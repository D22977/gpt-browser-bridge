import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ORCA_RETRY_BACKOFF_MS,
  ORCA_UNAVAILABLE_ESCALATE_MS,
  PROCESS_CRASH_BACKOFF_MS,
  acquireOrConfirmLock,
  buildResumePrompt,
  defaultRecoveryEntry,
  defaultRecoveryState,
  escalateToNeedsHuman,
  evaluateOrcaAvailability,
  recordRecoveryFailure,
  readDispatchCheckpoint,
  recoverActiveTerminal,
  resolveRuntimePaths,
  runResumeDeliveryCheck,
  runLoopOnce,
  runSupervisor,
  scanDurableReports,
  writeProjectState,
} from "../src/supervisor.mjs";
import { OrcaAdapter, resolveActiveTerminal } from "../src/adapters/orca_adapter.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "fixtures", "orca");
const BASE_MS = Date.parse("2026-08-01T01:00:00.000Z");

function projectState(overrides = {}) {
  return {
    schema_version: 1,
    project_id: "GPT_BROWSER_BRIDGE",
    state: "RUNNING",
    current_task: "004",
    current_phase: "worker",
    attempt: 1,
    base_commit: "5abc4dc",
    active_run_id: "GBB-004-A1",
    active_terminal: null,
    last_checkpoint: "2026-08-01T09:00:00+08:00",
    last_successful_step: "dispatch written",
    next_action: "wait for worker",
    retry_count: 0,
    blocked_reason: null,
    updated_at: "2026-08-01T09:00:00+08:00",
    ...overrides,
  };
}

async function tempRuntime(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gbb004-supervisor-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const paths = resolveRuntimePaths(root);
  await mkdir(path.dirname(paths.state), { recursive: true });
  await writeFile(paths.state, JSON.stringify(projectState(), null, 2));
  return { root, paths };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readFixture(name) {
  return readFile(path.join(FIXTURE_ROOT, name), "utf8");
}

function quietOrca(overrides = {}) {
  return {
    status: async () => ({ ok: true, state: "ready" }),
    listTerminals: async () => [],
    createTerminal: async () => ({ handle: "term-new" }),
    sendTerminal: async () => ({ accepted: true }),
    ...overrides,
  };
}

test("OrcaAdapter consumes fake CLI transcripts and emits exact terminal argv", async () => {
  const calls = [];
  const exec = async (_exe, args) => {
    calls.push(args);
    if (args[0] === "status") return readFixture("status-ready.json");
    if (args[1] === "list") return readFixture("terminal-list-stale-handle.json");
    if (args[1] === "create") return readFixture("terminal-create.json");
    if (args[1] === "send") return readFixture("terminal-send.json");
    throw new Error(`unexpected fixture request: ${args.join(" ")}`);
  };
  const adapter = new OrcaAdapter({ orcaPath: "C:\\fake\\orca.exe", exec });

  assert.deepEqual(await adapter.status(), {
    ok: true,
    state: "ready",
    raw: { runtime: { reachable: true, state: "ready" } },
  });
  const terminals = await adapter.listTerminals({ worktree: "active" });
  assert.equal(terminals[0].handle, "term-control-new");
  const created = await adapter.createTerminal({
    worktree: "active",
    title: "GBB-004-A1-worker",
    command: "codex",
  });
  await adapter.sendTerminal({ handle: created.handle, text: "resume", enter: true });

  assert.deepEqual(calls, [
    ["status", "--json"],
    ["terminal", "list", "--worktree", "active", "--json"],
    ["terminal", "create", "--worktree", "active", "--title", "GBB-004-A1-worker", "--command", "codex", "--json"],
    ["terminal", "send", "--terminal", "term-worker-new", "--text", "resume", "--enter", "--json"],
  ]);

  const unavailable = new OrcaAdapter({
    orcaPath: "C:\\fake\\orca.exe",
    exec: async () => readFixture("status-unavailable.json"),
  });
  const unavailableStatus = await unavailable.status();
  assert.equal(unavailableStatus.ok, false);
  assert.equal(unavailableStatus.state, "unreachable");
  assert.match(unavailableStatus.error, /runtime unavailable/);
});

test("runSupervisor writes and refreshes heartbeat without a real interval", async (t) => {
  const { root, paths } = await tempRuntime(t);
  let nowMs = BASE_MS;
  const sleeps = [];
  const result = await runSupervisor({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41004,
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    maxIterations: 2,
    intervalMs: 15_000,
    isAlive: async () => false,
  });

  const heartbeat = await readJson(paths.heartbeat);
  assert.equal(result.iterations, 2);
  assert.deepEqual(sleeps, [15_000]);
  assert.equal(heartbeat.pid, 41004);
  assert.equal(Date.parse(heartbeat.at) - Date.parse("2026-08-01T09:00:00+08:00"), 15_000);
  assert.equal(heartbeat.state, "RUNNING");
});

test("resume delivery hook uses one bound consumer and emits a physical consume event", async () => {
  const waitTuple = {
    source_terminal_receipt: 5467000101,
    control_generation: 7,
    card_id: "HERDR-CONTROL-AUTONOMOUS-SEAM-RESTORE-G7-01",
    allowed_action_class: "CONTROL_AUTONOMOUS_SEAM_REPAIR",
    target: {
      agent_name: "LOCAL_HERDR_CODEX_GENERIC",
      executor_instance_id: "HERDR-CONTROL-AUTONOMOUS-SEAM-RESTORE-G7-01",
      surface: "HERDR",
      herdr_agent: "codex",
      herdr_workspace_id: "w2",
      herdr_pane_id: "w2:p1",
      herdr_agent_session: "01a04f6c-bd0f-7b42-8b56-ab876c720aad",
      herdr_agent_kind: "codex",
    },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 7

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #103 receipt 5467000101
source_control_generation: 7
resume_card_id: HERDR-CONTROL-AUTONOMOUS-SEAM-RESTORE-G7-01

EXACT_TARGET
agent_name: LOCAL_HERDR_CODEX_GENERIC
executor_instance_id: HERDR-CONTROL-AUTONOMOUS-SEAM-RESTORE-G7-01
surface: HERDR
minimal_wake: Read GitHub directly and execute only the exact bounded card.
`;
  const events = [];
  const result = await runResumeDeliveryCheck({
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "existing-supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readDecisionBody: async () => decisionBody,
      readComments: async () => [],
      herdr: { prompt: async (target) => ({ accepted: true, ...target, runtime: "herdr 0.8" }) },
      publishReceipt: async (receipt) => { events.push(receipt); return { id: 5467000111 }; },
    },
  }, { isoNow: "2026-08-30T14:00:00.000Z" });
  assert.equal(result.delivered, true);
  assert.equal(result.events[0].type, "resume_delivery_delivered");
  assert.equal(events[0].state, "CONSUMED_STARTED");
  assert.equal(events[0].target_herdr_pane_id, "w2:p1");
});

test("resume delivery hook stops when no restartable future consumer is bound", async () => {
  let promptCount = 0;
  const result = await runResumeDeliveryCheck({
    resumeDelivery: {
      futureConsumerBinding: { resident: false, restartable: false, process_alive: true },
      herdr: { prompt: async () => { promptCount += 1; } },
    },
  }, { isoNow: "2026-08-30T14:00:00.000Z" });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, "CONTROL_REQUIRED_FUTURE_CONSUMER_BINDING_MISSING");
  assert.equal(promptCount, 0);
  assert.equal(result.events[0].type, "resume_delivery_future_consumer_binding_missing");
});

test("live lock owner stops a duplicate Supervisor before ORCA or agent actions", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 9001, at: "2026-08-01T09:00:00+08:00" }));
  let orcaCalls = 0;
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca({ status: async () => { orcaCalls += 1; return { ok: true, state: "ready" }; } }),
    pid: 9002,
    now: () => BASE_MS,
    isAlive: async (pid) => pid === 9001,
  });

  assert.deepEqual(outcome, {
    stop: true,
    reason: "LOCK_NOT_OWNED",
    holder: 9001,
    at: "2026-08-01T09:00:00+08:00",
  });
  assert.equal(orcaCalls, 0);
  await assert.rejects(readFile(paths.heartbeat), { code: "ENOENT" });
});

test("dead lock owner is replaced and the current process becomes sole owner", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 111, at: "old" }));
  const result = await acquireOrConfirmLock(paths, {
    pid: 222,
    isAlive: async () => false,
    isoNow: "2026-08-01T09:00:00+08:00",
  });
  assert.deepEqual(result, { owned: true, holder: 222 });
  assert.equal((await readJson(paths.lock)).pid, 222);
});

for (const terminalState of ["COMPLETED", "CANCELLED", "NEEDS_HUMAN"]) {
  test(`${terminalState} state never lists, creates, or prompts an agent`, async (t) => {
    const { root, paths } = await tempRuntime(t);
    await writeFile(paths.state, JSON.stringify(projectState({
      state: terminalState,
      blocked_reason: terminalState === "NEEDS_HUMAN" ? "operator review required" : null,
      active_terminal: { role: "worker", handle: "stale", title: "GBB-004-A1-worker" },
    })));
    const actions = [];
    await runLoopOnce({
      runtimeRoot: root,
      orca: quietOrca({
        listTerminals: async () => { actions.push("list"); return []; },
        createTerminal: async () => { actions.push("create"); return { handle: "new" }; },
        sendTerminal: async () => { actions.push("send"); return {}; },
      }),
      pid: 1,
      now: () => BASE_MS,
      isAlive: async () => false,
    });
    assert.deepEqual(actions, []);
    assert.equal((await readJson(paths.state)).state, terminalState);
  });
}

test("ORCA unavailable policy schedules 30/60/180/300 second retries and escalates at 20 minutes", async (t) => {
  const { root, paths } = await tempRuntime(t);
  let nowMs = BASE_MS;
  let statusCalls = 0;
  const orca = quietOrca({
    status: async () => {
      statusCalls += 1;
      return { ok: false, state: "unreachable" };
    },
  });
  const tick = () => runLoopOnce({
    runtimeRoot: root,
    orca,
    pid: 501,
    now: () => nowMs,
    isAlive: async () => false,
  });

  await tick();
  let recovery = await readJson(paths.recoveryState);
  assert.equal(statusCalls, 1);
  assert.equal(recovery.orca.nextRetryAtMs, BASE_MS + ORCA_RETRY_BACKOFF_MS[0]);

  nowMs += 15_000;
  await tick();
  assert.equal(statusCalls, 1, "15-second Supervisor tick must honor the 30-second ORCA backoff");

  for (const delay of ORCA_RETRY_BACKOFF_MS.slice(0, 3)) {
    nowMs += delay - (nowMs === BASE_MS + 15_000 ? 15_000 : 0);
    await tick();
  }
  recovery = await readJson(paths.recoveryState);
  assert.equal(statusCalls, 4);
  assert.equal(recovery.orca.nextRetryAtMs - nowMs, ORCA_RETRY_BACKOFF_MS[3]);

  nowMs = BASE_MS + ORCA_UNAVAILABLE_ESCALATE_MS;
  await tick();
  const state = await readJson(paths.state);
  assert.equal(state.state, "NEEDS_HUMAN");
  assert.match(state.blocked_reason, /^ORCA_UNAVAILABLE:/);
  assert.equal(statusCalls, 5, "the 20-minute escalation boundary performs one final reachability check");
});

test("ORCA recovery success clears retry history", () => {
  const failed = evaluateOrcaAvailability({}, { ok: false, nowMs: BASE_MS });
  assert.equal(failed.nextRetryAtMs, BASE_MS + 30_000);
  assert.deepEqual(evaluateOrcaAvailability(failed, { ok: true, nowMs: BASE_MS + 30_000 }), {
    unavailableSinceMs: null,
    attempts: 0,
    nextRetryAtMs: 0,
    escalate: false,
  });
});

test("process crash policy is bounded to 10/30/120 second backoff and three restart records", () => {
  let entry = defaultRecoveryEntry();
  let nowMs = BASE_MS;
  for (const delay of PROCESS_CRASH_BACKOFF_MS) {
    entry = recordRecoveryFailure(entry, nowMs);
    assert.equal(entry.exhausted, false);
    assert.equal(entry.nextRetryAtMs, nowMs + delay);
    nowMs = entry.nextRetryAtMs;
  }
  const exhausted = recordRecoveryFailure(entry, nowMs);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.attempts, 3);
  assert.equal(exhausted.nextRetryAtMs, Infinity);
});

test("stale terminal handle is discarded and re-linked by exact title", async (t) => {
  const { paths } = await tempRuntime(t);
  const state = projectState({
    active_terminal: { role: "control", handle: "term-control-old", title: "GBB-004-A1-control" },
  });
  const terminals = JSON.parse(await readFixture("terminal-list-stale-handle.json")).result.terminals;
  const result = await recoverActiveTerminal({
    paths,
    now: () => BASE_MS,
    orca: quietOrca({ listTerminals: async () => terminals }),
  }, state, defaultRecoveryState(), "2026-08-01T09:00:00+08:00");

  assert.equal(resolveActiveTerminal(terminals, state.active_terminal).method, "title");
  assert.equal(result.state.active_terminal.handle, "term-control-new");
  assert.equal(result.events[0].type, "terminal_relinked");
});

test("same-title terminal candidates resolve deterministically to the newest healthy handle", () => {
  const ref = { role: "control", handle: "term-stale", title: "GBB-004-A1-control" };
  const candidates = [
    { handle: "term-disconnected", title: ref.title, connected: false, writable: true, lastOutputAt: 999 },
    { handle: "term-older", title: ref.title, connected: true, writable: true, lastOutputAt: 100 },
    { handle: "term-newer", title: ref.title, connected: true, writable: true, lastOutputAt: 200 },
  ];

  const forward = resolveActiveTerminal(candidates, ref);
  const reversed = resolveActiveTerminal([...candidates].reverse(), ref);

  assert.equal(forward.found, true);
  assert.equal(forward.method, "title");
  assert.equal(forward.terminal.handle, "term-newer");
  assert.equal(forward.candidateCount, 2);
  assert.equal(forward.ambiguous, true);
  assert.equal(reversed.terminal.handle, "term-newer", "input order must not affect resolution");
});

test("missing terminal is rebuilt from checkpoint and receives a deterministic resume prompt", async (t) => {
  const { paths } = await tempRuntime(t);
  const runDir = path.join(paths.runsDir, "GBB-004-A1");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "dispatch.json"), JSON.stringify({
    run_id: "GBB-004-A1",
    task_id: "GBB-004",
    attempt: 1,
    worktree: "D:\\AIWORK_WT\\GPT_BROWSER_BRIDGE\\GBB-004-A1",
    roles: {
      worker: { title: "GBB-004-A1-worker", command: "codex" },
    },
  }));
  const calls = [];
  const state = projectState({
    active_terminal: { role: "worker", handle: "term-worker-old", title: "GBB-004-A1-worker" },
  });
  const result = await recoverActiveTerminal({
    paths,
    now: () => BASE_MS,
    gitExec: async () => ({ stdout: "" }),
    orca: quietOrca({
      listTerminals: async () => [],
      createTerminal: async (args) => { calls.push(["create", args]); return { handle: "term-worker-new" }; },
      sendTerminal: async (args) => { calls.push(["send", args]); return { accepted: true }; },
    }),
  }, state, defaultRecoveryState(), "2026-08-01T09:00:00+08:00");

  assert.deepEqual(calls[0], ["create", {
    worktree: "D:\\AIWORK_WT\\GPT_BROWSER_BRIDGE\\GBB-004-A1",
    title: "GBB-004-A1-worker",
    command: "codex",
  }]);
  assert.equal(calls[1][0], "send");
  assert.equal(calls[1][1].handle, "term-worker-new");
  assert.match(calls[1][1].text, /run_id=GBB-004-A1/);
  assert.match(calls[1][1].text, /Do not repeat completed work/);
  assert.match(calls[1][1].text, /Do not re-send any ChatGPT prompt/);
  assert.equal(result.state.active_terminal.handle, "term-worker-new");
  assert.equal(result.events.at(-1).type, "terminal_rebuilt");
});

test("resume prompt names the role skill and durable checkpoint sources", () => {
  const text = buildResumePrompt("reviewer", projectState(), { runId: "GBB-004-A1" });
  assert.match(text, /skills\/reviewer\/SKILL\.md/);
  assert.match(text, /state\/project_state\.json and events\/events\.ndjson/);
  assert.match(text, /runs\/<run_id>\//);
});

test("durable reports and result.json become one-shot Control Tower events", async (t) => {
  const { paths } = await tempRuntime(t);
  const runDir = path.join(paths.runsDir, "GBB-004-A1");
  const jobDir = path.join(paths.jobsDir, "job-1");
  await mkdir(runDir, { recursive: true });
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(runDir, "worker_report.md"), "# worker\n");
  await writeFile(path.join(runDir, "reviewer_report.md"), "conclusion: 退修\n");
  await writeFile(path.join(jobDir, "result.json"), JSON.stringify({ state: "DONE", detections: [] }));
  const ctx = { paths };

  const first = await scanDurableReports(ctx, projectState(), "2026-08-01T09:00:00+08:00");
  const second = await scanDurableReports(ctx, projectState(), "2026-08-01T09:00:01+08:00");

  assert.deepEqual(first.events.map((event) => event.type).sort(), ["durable_report", "durable_report", "job_result"]);
  assert.deepEqual(second.events, []);
  assert.equal(first.authRequired, false);
});

for (const conclusion of ["通過", "退修", "COMPLETED"]) {
  test(`Reviewer report conclusion ${conclusion} only requests Control Tower handoff`, async (t) => {
    const { root, paths } = await tempRuntime(t);
    const runDir = path.join(paths.runsDir, "GBB-004-A1");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "reviewer_report.md"), [
      "# GBB-004 Reviewer report",
      "",
      `conclusion: ${conclusion}`,
      "status: COMPLETED",
      "recommendation: transition task to REWORK if the Control Tower agrees",
      "",
    ].join("\n"));
    const before = projectState({
      state: "WAITING_REVIEWER",
      current_phase: "reviewer",
      next_action: "Control Tower reads durable reviewer report",
    });
    await writeFile(paths.state, JSON.stringify(before, null, 2));

    const forbiddenCalls = [];
    const spy = (name) => async () => { forbiddenCalls.push(name); return {}; };
    const outcome = await runLoopOnce({
      runtimeRoot: root,
      orca: quietOrca({
        createTerminal: spy("create reviewer"),
        sendTerminal: spy("resend work prompt"),
        taskUpdate: spy("task update"),
        writeDecision: spy("decision writer"),
        pressContinue: spy("press Continue"),
      }),
      taskUpdater: spy("ctx task update"),
      decisionWriter: spy("ctx decision writer"),
      sender: spy("ctx sender"),
      reviewerFactory: spy("ctx reviewer factory"),
      pid: 700,
      now: () => BASE_MS,
      isAlive: async () => false,
    });

    assert.deepEqual(forbiddenCalls, []);
    assert.deepEqual(await readJson(paths.state), before, "durable reviewer content must not alter quality state");
    assert.deepEqual(outcome.events, [{
      type: "durable_report",
      run_id: "GBB-004-A1",
      report: "reviewer",
      action: "control_tower_handoff_requested",
    }]);
    assert.deepEqual(await readJson(paths.state), before, "reload remains byte-semantically unchanged");
  });
}

test("Supervisor source scan remains a secondary never-judge assertion", async () => {
  const source = await readFile(path.join(REPO_ROOT, "src", "supervisor.mjs"), "utf8");
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(executable, /conclusion\s*(?:===|==|switch)/);
  assert.doesNotMatch(executable, /["'](?:通過|退修)["']/);
  assert.doesNotMatch(executable, /task-update|REPEATED_REWORK/);
});

test("truncated dispatch checkpoint fails closed without inventing recovery data", async (t) => {
  const { paths } = await tempRuntime(t);
  const runDir = path.join(paths.runsDir, "GBB-004-A1");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "dispatch.json"), '{"run_id":"GBB-004-A1","roles":{"worker":');

  assert.equal(await readDispatchCheckpoint(paths, "GBB-004-A1"), null);
});

test("NEEDS_HUMAN cannot transition back to RUNNING", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const needsHuman = projectState({ state: "NEEDS_HUMAN", blocked_reason: "AUTH_REQUIRED: login wall" });
  await writeFile(paths.state, JSON.stringify(needsHuman));
  assert.strictEqual(
    escalateToNeedsHuman(needsHuman, "ORCA_UNAVAILABLE", "still down", "2026-08-01T09:01:00+08:00"),
    needsHuman
  );
  await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 701,
    now: () => BASE_MS,
    isAlive: async () => false,
  });
  const persisted = await readJson(paths.state);
  assert.equal(persisted.state, "NEEDS_HUMAN");
  assert.equal(persisted.blocked_reason, "AUTH_REQUIRED: login wall");
});

test("unified project-state writer rejects NEEDS_HUMAN to RUNNING from every caller", async (t) => {
  const { paths } = await tempRuntime(t);
  const needsHuman = projectState({ state: "NEEDS_HUMAN", blocked_reason: "AUTH_REQUIRED: login wall" });
  await writeFile(paths.state, JSON.stringify(needsHuman, null, 2));

  await assert.rejects(
    writeProjectState(paths, projectState({ state: "RUNNING", blocked_reason: null })),
    /ILLEGAL_STATE_TRANSITION: NEEDS_HUMAN -> RUNNING/
  );
  assert.deepEqual(await readJson(paths.state), needsHuman);
});
