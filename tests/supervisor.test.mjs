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

// ---------------------------------------------------------------------------
// github_relay_v1 mode (§4): GitHub relay state is the single routing
// authority. These tests prove the Supervisor routes the kernel action to the
// actuator executor, applies the executor's ACK back into relay state, and
// keeps the heartbeat alive across long (`pending`) executor waits.
// ---------------------------------------------------------------------------

const RELAY_REPO = "D22977/MEP-";
const RELAY_ISSUE = 3;
const RELAY_PR = 4;
const RELAY_HEAD = "f8e644871036f190b6e6385f3969f65ec9b016fb";
const RELAY_HEAD_B = "111122223333444455556666777788889999aaaa";
const RELAY_NOW = "2026-08-07T16:00:00+08:00";

function relayComment(id, body, created_at = RELAY_NOW) {
  return { id, body, created_at };
}

function relayReadyComment(head = RELAY_HEAD) {
  return relayComment(11, `## READY_FOR_REVIEW\nprotocol: GBB_GH_READY_FOR_REVIEW_V1\ncard_id: GBB-GH-02\npr_number: ${RELAY_PR}\nbase_sha: ${RELAY_HEAD}\nhead_sha: ${head}\nworker_self_review: false\nmerge_performed: false\n`);
}

function relayReviewComment(id, { decision, head = RELAY_HEAD, pr_number = RELAY_PR, created_at = RELAY_NOW }) {
  return relayComment(
    id,
    `Review:\n\`\`\`json\n${JSON.stringify({ protocol: "MRMP_REVIEW_RESULT_V1", card_id: "GBB-GH-02", pr_number, reviewed_head_sha: head, decision })}\n\`\`\``,
    created_at
  );
}

function relayDeps(overrides = {}) {
  const calls = { fetchSnapshot: 0, postComment: 0, dispatch: 0, createTerminal: 0 };
  return {
    deps: {
      fetchSnapshot: async () => {
        calls.fetchSnapshot += 1;
        return { repo: RELAY_REPO, issue_number: RELAY_ISSUE, pr_number: RELAY_PR, head: { sha: RELAY_HEAD, state: "OPEN", draft: true }, comments: [] };
      },
      postComment: async () => {
        calls.postComment += 1;
        return { id: 9001 };
      },
      webgpt: {
        dispatchReview: async () => {
          calls.dispatch += 1;
          return { conversation_url: "https://chatgpt.com/c/abc", conversationUrl: "https://chatgpt.com/c/abc" };
        },
      },
      orca: quietOrca({ createTerminal: async () => { calls.createTerminal += 1; return { handle: "term-worker", terminal: { handle: "term-worker" } }; } }),
      worktree: null,
      workerCommand: "opencode",
      cardId: "GBB-GH-02",
      checkpointPath: null,
      ...overrides,
    },
    calls,
  };
}

function relayCtx(root, paths, injected) {
  return {
    runtimeRoot: root,
    paths,
    orca: injected.deps.orca,
    pid: 711,
    now: () => Date.parse(RELAY_NOW),
    isAlive: async () => false,
    mode: "github_relay_v1",
    relay: { repo: RELAY_REPO, issue: RELAY_ISSUE, pr: RELAY_PR },
    relayDeps: injected.deps,
  };
}

test("relay mode with no relay config fails closed without touching project state", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const before = await readJson(paths.state);
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    paths,
    orca: quietOrca(),
    pid: 712,
    now: () => Date.parse(RELAY_NOW),
    isAlive: async () => false,
    mode: "github_relay_v1",
    relay: null,
    relayDeps: null,
  });
  assert.equal(outcome.reason, "RELAY_CONFIG_MISSING");
  assert.equal(outcome.stop, false);
  assert.deepEqual(await readJson(paths.state), before, "project state must be untouched");
  const heartbeat = await readJson(paths.heartbeat);
  assert.equal(heartbeat.state, "github_relay_v1");
});

test("relay mode routes a READY head to WebGPT dispatch and persists the executor checkpoint", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const injected = relayDeps();
  injected.deps.fetchSnapshot = async () => ({ repo: RELAY_REPO, issue_number: RELAY_ISSUE, pr_number: RELAY_PR, head: { sha: RELAY_HEAD, state: "OPEN", draft: true }, comments: [relayReadyComment()] });

  const outcome = await runLoopOnce(relayCtx(root, paths, injected));

  assert.equal(outcome.stop, false);
  assert.equal(outcome.action, "REQUEST_REVIEW");
  assert.equal(injected.calls.dispatch, 1, "WebGPT must be dispatched exactly once");

  // Kernel relay state records the pending action; executor checkpoint holds
  // the durable stage.
  const relayState = await readJson(paths.relayState);
  assert.equal(relayState.pending_action.action, "REQUEST_REVIEW");
  assert.equal(relayState.pending_action.action_id, `${RELAY_REPO}:${RELAY_PR}:${RELAY_HEAD}:REQUEST_REVIEW`);

  const execState = await readJson(paths.relayExecutorState);
  assert.equal(execState.request_review.stage, "sent");
  assert.equal(execState.request_review.head_sha, RELAY_HEAD);

  const heartbeat = await readJson(paths.heartbeat);
  assert.equal(heartbeat.state, "github_relay_v1");
});

test("acceptance: a never-resolving WebGPT review waiter never blocks a tick", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const injected = relayDeps();

  // The WebGPT review session never completes: any tick that tried to await
  // this waiter would hang until the watchdog below rejects it.
  const never = new Promise(() => {});
  injected.deps.webgpt.dispatchReview = async () => {
    injected.calls.dispatch += 1;
    return { conversation_url: "https://chatgpt.com/c/never", conversationUrl: "https://chatgpt.com/c/never", session: never };
  };
  // Bounded GitHub read: the review receipt never appears (session never ends).
  injected.deps.fetchSnapshot = async () => ({ repo: RELAY_REPO, issue_number: RELAY_ISSUE, pr_number: RELAY_PR, head: { sha: RELAY_HEAD, state: "OPEN", draft: true }, comments: [relayReadyComment()] });

  // Watchdog: if a tick ever awaits the never-resolving waiter, it must fail
  // within 300ms instead of blocking the Supervisor loop (§6).
  const guardedTick = () =>
    Promise.race([
      runLoopOnce(relayCtx(root, paths, injected)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SUPERVISOR_TICK_BLOCKED")), 300)),
    ]);

  // Tick 1: READY -> REQUEST_REVIEW -> dispatch is fire-and-forget fast; the
  // executor must return pending, not await the WebGPT session.
  const first = await guardedTick();
  assert.equal(first.stop, false);
  assert.equal(first.status, "pending");
  assert.equal(first.reason, "WEBGPT_DISPATCHED");
  assert.equal(injected.calls.dispatch, 1, "WebGPT must be dispatched exactly once");

  const execState1 = await readJson(paths.relayExecutorState);
  assert.equal(execState1.request_review.stage, "sent");
  assert.equal(execState1.request_review.head_sha, RELAY_HEAD);

  // Tick 2: still no receipt -> NOOP -> same checkpoint reused, pending again.
  // No second WebGPT session, no ACK applied, nothing processed.
  const second = await guardedTick();
  assert.equal(second.stop, false);
  assert.equal(second.status, "pending");
  assert.equal(second.reason, "REVIEW_RECEIPT_WAIT");
  assert.equal(injected.calls.dispatch, 1, "must not open a second WebGPT review session");

  const execState2 = await readJson(paths.relayExecutorState);
  assert.equal(execState2.request_review.stage, "sent", "checkpoint must be reused, not reset");

  const heartbeat = await readJson(paths.heartbeat);
  assert.equal(heartbeat.state, "github_relay_v1");

  const relayState = await readJson(paths.relayState);
  assert.ok(relayState.pending_action, "pending REQUEST_REVIEW must survive the long wait");
  assert.equal(relayState.pending_action.action, "REQUEST_REVIEW");
  assert.ok(!relayState.processed_event_keys.includes(`${RELAY_REPO}:${RELAY_PR}:${RELAY_HEAD}:READY`), "no event may be processed without a receipt");
});

test("relay mode applies the executor ACK back into relay state after a receipt", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const injected = relayDeps();

  // First tick: READY -> REQUEST_REVIEW -> dispatch (no receipt yet).
  injected.deps.fetchSnapshot = async () => ({ repo: RELAY_REPO, issue_number: RELAY_ISSUE, pr_number: RELAY_PR, head: { sha: RELAY_HEAD, state: "OPEN", draft: true }, comments: [relayReadyComment()] });
  await runLoopOnce(relayCtx(root, paths, injected));
  let relayState = await readJson(paths.relayState);
  assert.ok(relayState.pending_action, "pending REQUEST_REVIEW must exist after dispatch");

  // Second tick: the exact-head receipt is now present -> executor ACKs
  // succeeded -> Supervisor applies it -> pending clears, event processed.
  injected.deps.fetchSnapshot = async () => ({
    repo: RELAY_REPO,
    issue_number: RELAY_ISSUE,
    pr_number: RELAY_PR,
    head: { sha: RELAY_HEAD, state: "OPEN", draft: true },
    comments: [
      relayReadyComment(),
      relayComment(22, `Review:\n\`\`\`json\n${JSON.stringify({ protocol: "MRMP_REVIEW_RESULT_V1", card_id: "GBB-GH-02", pr_number: RELAY_PR, reviewed_head_sha: RELAY_HEAD, decision: "PASS" })}\n\`\`\``),
    ],
  });
  const outcome = await runLoopOnce(relayCtx(root, paths, injected));

  relayState = await readJson(paths.relayState);
  assert.equal(outcome.status, "executed");
  assert.equal(outcome.reason, "REVIEW_RECEIPT_OBSERVED");
  assert.equal(relayState.pending_action, null, "pending action must be cleared by the applied ACK");
  assert.ok(relayState.processed_event_keys.includes(`${RELAY_REPO}:${RELAY_PR}:${RELAY_HEAD}:READY`));
});

test("relay mode DISPATCH_FIX stays pending until a strict new-head READY proves Worker completion", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const injected = relayDeps();
  let createCount = 0;
  injected.deps.orca = quietOrca({
    createTerminal: async () => { createCount += 1; return { handle: "term-worker", terminal: { handle: "term-worker" } }; },
    sendTerminal: async () => ({ accepted: true }),
  });

  const fixReview = () => relayReviewComment(12, { decision: "FIX_REQUIRED" });
  const snapshotFor = (comments, head) => ({ repo: RELAY_REPO, issue_number: RELAY_ISSUE, pr_number: RELAY_PR, head: { sha: head, state: "OPEN", draft: true }, comments });

  // Tick 1: fresh FIX_REQUIRED on current head -> DISPATCH_FIX -> worker
  // terminal starts, executor returns pending (no ACK).
  injected.deps.fetchSnapshot = async () => snapshotFor([fixReview()], RELAY_HEAD);
  const first = await runLoopOnce(relayCtx(root, paths, injected));
  assert.equal(first.stop, false);
  assert.equal(first.action, "DISPATCH_FIX");
  assert.equal(first.status, "pending", "terminal start must not ACK succeeded");
  assert.equal(first.reason, "WORKER_TERMINAL_STARTED");

  let relayState = await readJson(paths.relayState);
  assert.ok(relayState.pending_action, "DISPATCH_FIX must stay pending");
  assert.equal(relayState.pending_action.action, "DISPATCH_FIX");
  assert.equal(relayState.repair.rounds, 0, "no repair round before Worker completion");
  assert.ok(!relayState.processed_event_keys.includes(`${RELAY_REPO}:${RELAY_PR}:${RELAY_HEAD}:FIX_REQUIRED`), "no event processed without completion proof");

  // Tick 2: still no new-head READY -> NOOP -> executor continuation stays
  // pending, never launches a second worker, never ACKs.
  const second = await runLoopOnce(relayCtx(root, paths, injected));
  assert.equal(second.action, "NOOP");
  assert.equal(second.status, "pending");
  assert.equal(second.reason, "WORKER_DISPATCH_WAIT");
  assert.equal(createCount, 1, "must not relaunch a duplicate worker terminal");
  relayState = await readJson(paths.relayState);
  assert.equal(relayState.repair.rounds, 0);

  // Tick 3: the Worker pushed a new commit and posted a strict READY for it ->
  // executor ACKs succeeded -> kernel processes the FIX_REQUIRED event and
  // increments the repair round exactly once.
  injected.deps.fetchSnapshot = async () => snapshotFor([fixReview(), relayReadyComment(RELAY_HEAD_B)], RELAY_HEAD_B);
  const third = await runLoopOnce(relayCtx(root, paths, injected));
  assert.equal(third.action, "NOOP");
  assert.equal(third.status, "executed");
  assert.equal(third.reason, "WORKER_COMPLETION_OBSERVED");
  relayState = await readJson(paths.relayState);
  assert.equal(relayState.pending_action, null, "pending must clear only after completion proof");
  assert.equal(relayState.repair.rounds, 1, "repair round increments exactly once on completion");
  assert.ok(relayState.processed_event_keys.includes(`${RELAY_REPO}:${RELAY_PR}:${RELAY_HEAD}:FIX_REQUIRED`));
});

test("relay mode transport failure enters a terminal relay state without crashing the loop", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const injected = relayDeps();
  injected.deps.fetchSnapshot = async () => {
    throw new Error("gh: API rate limit exceeded");
  };

  const outcome = await runLoopOnce(relayCtx(root, paths, injected));

  assert.equal(outcome.stop, false);
  const relayState = await readJson(paths.relayState);
  assert.equal(relayState.terminal.active, true);
  assert.equal(relayState.terminal.reason, "TRANSPORT_BLOCKED");
  const heartbeat = await readJson(paths.heartbeat);
  assert.equal(heartbeat.state, "github_relay_v1");
});

test("relay mode with corrupt relay state fails closed without crashing the loop", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.relayState, "{not valid json", "utf8");
  const injected = relayDeps();

  const outcome = await runLoopOnce(relayCtx(root, paths, injected));

  assert.equal(outcome.reason, "RELAY_POLL_FAILED");
  assert.equal(outcome.stop, false);
  const heartbeat = await readJson(paths.heartbeat);
  assert.equal(heartbeat.state, "github_relay_v1");
});

test("legacy mode never touches relay state or executor deps", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const injected = relayDeps();
  let used = false;
  injected.deps.fetchSnapshot = async () => {
    used = true;
    return { comments: [] };
  };

  await runLoopOnce({
    runtimeRoot: root,
    paths,
    orca: quietOrca(),
    pid: 713,
    now: () => BASE_MS,
    isAlive: async () => false,
    mode: "legacy",
    relayDeps: injected.deps,
  });

  assert.equal(used, false, "legacy mode must not call relay deps");
  await assert.rejects(() => readFile(paths.relayState, "utf8"), /ENOENT/);
  await assert.rejects(() => readFile(paths.relayExecutorState, "utf8"), /ENOENT/);
});
