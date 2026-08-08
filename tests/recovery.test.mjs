import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ORCA_UNAVAILABLE_ESCALATE_MS,
  defaultRecoveryState,
  recoverActiveTerminal,
  resolveRuntimePaths,
  runLoopOnce,
  scanDurableReports,
} from "../src/supervisor.mjs";
import { runWatchLoop } from "../src/gpt_watch.mjs";

const BASE_MS = Date.parse("2026-08-01T01:00:00.000Z");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKTREE = "D:\\AIWORK_WT\\GPT_BROWSER_BRIDGE\\GBB-004-A1";
const CONVERSATION_URL = "https://chatgpt.com/c/00000000-0000-0000-0000-000000000004";

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
    next_action: "wait for role",
    retry_count: 0,
    blocked_reason: null,
    updated_at: "2026-08-01T09:00:00+08:00",
    ...overrides,
  };
}

async function tempRuntime(t, state = projectState()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gbb004-recovery-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const paths = resolveRuntimePaths(root);
  await mkdir(path.dirname(paths.state), { recursive: true });
  await writeFile(paths.state, JSON.stringify(state, null, 2));
  return { root, paths };
}

async function writeDispatch(paths, roles) {
  const runDir = path.join(paths.runsDir, "GBB-004-A1");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "dispatch.json"), JSON.stringify({
    run_id: "GBB-004-A1",
    task_id: "GBB-004",
    attempt: 1,
    worktree: WORKTREE,
    roles,
  }, null, 2));
  return runDir;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function orca(overrides = {}) {
  return {
    status: async () => ({ ok: true, state: "ready" }),
    listTerminals: async () => [],
    createTerminal: async () => ({ handle: "term-new" }),
    sendTerminal: async () => ({ accepted: true }),
    ...overrides,
  };
}

test("Windows resume chain stays bound to the checked-out worktree and forwards runtime arguments", async () => {
  const start = await readFile(path.join(REPO_ROOT, "scripts", "start-supervisor.ps1"), "utf8");
  const resume = await readFile(path.join(REPO_ROOT, "scripts", "resume.ps1"), "utf8");
  const register = await readFile(path.join(REPO_ROOT, "scripts", "register-resume-task.ps1"), "utf8");

  assert.match(start, /\$PSScriptRoot/);
  assert.match(start, /Join-Path\s+\$repo\s+["']src\\supervisor\.mjs["']/i);
  assert.doesNotMatch(start, /\$repo\s*=\s*["']D:\\AIWORK\\GPT_BROWSER_BRIDGE["']/i);
  assert.match(start, /\[int\]\$heartbeatState\.pid\s+-eq\s+\$process\.Id/);
  assert.match(resume, /\$PSScriptRoot/);
  assert.match(resume, /-Runtime\s+\$Runtime\s+-Orca\s+\$Orca/);
  assert.doesNotMatch(resume, /-File["',\s]+["']D:\\AIWORK\\GPT_BROWSER_BRIDGE\\scripts\\start-supervisor\.ps1/i);
  assert.doesNotMatch(resume, /\bexit\s+0\b/i);
  assert.doesNotMatch(resume, /\$\{hb\.at\}/);
  assert.match(resume, /\$\(\$hb\.at\)/);
  assert.match(register, /\[string\]\$Runtime/);
  assert.match(register, /\[string\]\$Orca/);
  assert.match(register, /\$tr\s*=.*-Runtime.*\$Runtime/);
  assert.match(register, /if\s*\(\$Orca\s+-ne\s+\$defaultOrca\)/);
  assert.match(register, /\$tr\s*\+=.*-Orca.*\$Orca/);
});

test("Worker CLI crash rebuilds the same worktree from checkpoint without reset, clean, or stash", async (t) => {
  const state = projectState({
    active_terminal: { role: "worker", handle: "worker-old", title: "GBB-004-A1-worker" },
  });
  const { paths } = await tempRuntime(t, state);
  await writeDispatch(paths, {
    worker: { title: "GBB-004-A1-worker", command: "codex" },
  });
  const gitCalls = [];
  const orcaCalls = [];
  const result = await recoverActiveTerminal({
    paths,
    now: () => BASE_MS,
    gitExec: async (args, opts) => {
      gitCalls.push({ args, cwd: opts.cwd });
      return { stdout: "" };
    },
    orca: orca({
      createTerminal: async (args) => { orcaCalls.push(args); return { handle: "worker-new" }; },
      sendTerminal: async () => ({ accepted: true }),
    }),
  }, state, defaultRecoveryState(), "2026-08-01T09:00:00+08:00");

  assert.equal(result.state.active_terminal.handle, "worker-new");
  assert.equal(orcaCalls[0].worktree, WORKTREE);
  assert.deepEqual(gitCalls.map((call) => call.args), [["status", "--short"], ["diff", "--name-only"]]);
  assert.ok(gitCalls.every((call) => call.cwd === WORKTREE));
  assert.doesNotMatch(JSON.stringify(gitCalls), /reset|clean|stash/);
});

test("F005: supervisor must not create/send a Worker terminal while the relay executor owns a dispatched DISPATCH_FIX", async (t) => {
  const state = projectState({
    active_terminal: { role: "worker", handle: "worker-old", title: "GBB-004-A1-worker" },
  });
  const { paths } = await tempRuntime(t, state);
  // Relay executor checkpoint: a DISPATCH_FIX is mid-flight (stage dispatched).
  await writeFile(paths.relayExecutorState, JSON.stringify({
    schema_version: 1,
    protocol: "GBB_GH_EXECUTOR_V1",
    dispatch_fix: { action_id: "x", stage: "dispatched", recovery_attempted: false },
  }));
  let created = false;
  let sent = false;
  const result = await recoverActiveTerminal({
    paths,
    now: () => BASE_MS,
    orca: orca({
      createTerminal: async () => { created = true; return { handle: "should-never-happen" }; },
      sendTerminal: async () => { sent = true; return { accepted: true }; },
    }),
  }, state, defaultRecoveryState(), "2026-08-01T09:00:00+08:00");

  assert.equal(created, false, "supervisor must not create a worker terminal mid-dispatch");
  assert.equal(sent, false, "supervisor must not send a resume prompt mid-dispatch");
  assert.equal(result.state.active_terminal.handle, "worker-old", "no handle relink/rebuild by supervisor");
  assert.ok(result.events.some((e) => e.type === "worker_terminal_owned_by_executor"));
});

test("F005: supervisor may still recover the worker when the relay executor stage is not dispatched", async (t) => {
  const state = projectState({
    active_terminal: { role: "worker", handle: "worker-old", title: "GBB-004-A1-worker" },
  });
  const { paths } = await tempRuntime(t, state);
  // Executor checkpoint with no mid-flight dispatch (completed or absent) must
  // NOT block legacy recovery.
  await writeFile(paths.relayExecutorState, JSON.stringify({
    schema_version: 1,
    protocol: "GBB_GH_EXECUTOR_V1",
    dispatch_fix: { action_id: "x", stage: "completion_observed", recovery_attempted: true },
  }));
  await writeDispatch(paths, {
    worker: { title: "GBB-004-A1-worker", command: "codex" },
  });
  let created = false;
  const result = await recoverActiveTerminal({
    paths,
    now: () => BASE_MS,
    gitExec: async () => ({ stdout: "" }),
    orca: orca({
      createTerminal: async () => { created = true; return { handle: "worker-new" }; },
      sendTerminal: async () => ({ accepted: true }),
    }),
  }, state, defaultRecoveryState(), "2026-08-01T09:00:00+08:00");

  assert.equal(created, true, "non-dispatched stage must not block supervisor recovery");
  assert.equal(result.state.active_terminal.handle, "worker-new");
});

test("Reviewer crash creates a fresh-context terminal and forbids stale conclusion reuse", async (t) => {
  const state = projectState({
    current_phase: "reviewer",
    active_terminal: { role: "reviewer", handle: "reviewer-old", title: "GBB-004-A1-reviewer" },
  });
  const { paths } = await tempRuntime(t, state);
  const runDir = await writeDispatch(paths, {
    reviewer: { title: "GBB-004-A1-reviewer", command: "claude" },
  });
  await writeFile(path.join(runDir, "reviewer_report.md"), "conclusion: 通過\nstatus: incomplete\n");
  let sent;
  const result = await recoverActiveTerminal({
    paths,
    now: () => BASE_MS,
    orca: orca({
      createTerminal: async () => ({ handle: "reviewer-fresh" }),
      sendTerminal: async (args) => { sent = args; return { accepted: true }; },
    }),
  }, state, defaultRecoveryState(), "2026-08-01T09:00:00+08:00");

  assert.equal(result.state.active_terminal.handle, "reviewer-fresh");
  assert.match(sent.text, /fresh context/i);
  assert.match(sent.text, /Do not reuse any incomplete or stale reviewer conclusion/i);
  assert.doesNotMatch(sent.text, /conclusion: 通過/);
});

test("Control Tower crash rebuilds control terminal and resumes it without Supervisor judgment", async (t) => {
  const state = projectState({
    current_phase: "control",
    state: "WAITING_REVIEWER",
    active_terminal: { role: "control", handle: "control-old", title: "GBB-004-A1-control" },
  });
  const { paths } = await tempRuntime(t, state);
  await writeDispatch(paths, {
    control: { title: "GBB-004-A1-control", command: "codex" },
  });
  let sent;
  const result = await recoverActiveTerminal({
    paths,
    now: () => BASE_MS,
    orca: orca({
      createTerminal: async () => ({ handle: "control-new" }),
      sendTerminal: async (args) => { sent = args; return { accepted: true }; },
    }),
  }, state, defaultRecoveryState(), "2026-08-01T09:00:00+08:00");

  assert.equal(result.state.state, "WAITING_REVIEWER");
  assert.equal(result.state.active_terminal.handle, "control-new");
  assert.match(sent.text, /skills\/control-tower\/SKILL\.md/);
  assert.match(sent.text, /Resume exactly where the last checkpoint left off/);
});

test("Watcher crash restarts the same job watcher and never resends the ChatGPT prompt", async (t) => {
  const state = projectState({
    current_phase: "browser",
    state: "WAITING_BROWSER",
    active_terminal: { role: "watcher", handle: "watcher-old", title: "GBB-004-A1-watcher" },
  });
  const { paths } = await tempRuntime(t, state);
  await writeDispatch(paths, {
    watcher: {
      title: "GBB-004-A1-watcher",
      command: "node src/gpt_watch.mjs --job-id job-004 --runtime D:\\AIWORK_RUNTIME\\GPT_BROWSER_BRIDGE",
    },
  });
  const calls = [];
  const result = await recoverActiveTerminal({
    paths,
    now: () => BASE_MS,
    orca: orca({
      createTerminal: async (args) => { calls.push(["create", args]); return { handle: "watcher-new" }; },
      sendTerminal: async (args) => { calls.push(["send", args]); return { accepted: true }; },
    }),
  }, state, defaultRecoveryState(), "2026-08-01T09:00:00+08:00");

  assert.match(calls[0][1].command, /--job-id job-004/);
  assert.match(calls[1][1].text, /Do not re-send any ChatGPT prompt/);
  assert.doesNotMatch(JSON.stringify(calls), /gpt_send\.mjs/);
  assert.equal(result.state.active_terminal.handle, "watcher-new");
});

test("ORCA restart re-lists terminals, finds run title, and never trusts or sends to old handle", async (t) => {
  const state = projectState({
    active_terminal: { role: "control", handle: "old-runtime-handle", title: "GBB-004-A1-control" },
  });
  const { paths } = await tempRuntime(t, state);
  let lists = 0;
  let creates = 0;
  let sends = 0;
  const result = await recoverActiveTerminal({
    paths,
    now: () => BASE_MS,
    orca: orca({
      listTerminals: async () => { lists += 1; return [{ handle: "new-runtime-handle", title: "GBB-004-A1-control" }]; },
      createTerminal: async () => { creates += 1; return { handle: "unexpected" }; },
      sendTerminal: async () => { sends += 1; return {}; },
    }),
  }, state, defaultRecoveryState(), "2026-08-01T09:00:00+08:00");

  assert.equal(lists, 1);
  assert.equal(creates, 0);
  assert.equal(sends, 0);
  assert.equal(result.state.active_terminal.handle, "new-runtime-handle");
});

test("Chrome crash produces an approved-start, URL-based, no-resend/no-login recovery request", async (t) => {
  const { paths } = await tempRuntime(t);
  const jobDir = path.join(paths.jobsDir, "job-cdp");
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "job.json"), JSON.stringify({
    job_id: "job-cdp",
    conversation_url: CONVERSATION_URL,
  }));
  await writeFile(path.join(jobDir, "result.json"), JSON.stringify({
    state: "FAILED",
    detections: ["cdp_unreachable"],
  }));

  const scan = await scanDurableReports({ paths }, projectState(), "2026-08-01T09:00:00+08:00");
  const recovery = scan.events.find((event) => event.type === "browser_recovery_required");
  assert.deepEqual(recovery, {
    type: "browser_recovery_required",
    job_id: "job-cdp",
    action: "start_approved_automation_chrome",
    conversation_url: CONVERSATION_URL,
    resend: false,
    auto_login: false,
  });
});

test("login wall becomes NEEDS_HUMAN / AUTH_REQUIRED and never attempts auto-login", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const jobDir = path.join(paths.jobsDir, "job-auth");
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "result.json"), JSON.stringify({
    state: "NEEDS_DECISION",
    detections: ["login_wall"],
  }));
  const calls = [];
  await runLoopOnce({
    runtimeRoot: root,
    paths,
    orca: orca({ sendTerminal: async (args) => { calls.push(args); return {}; } }),
    pid: 810,
    now: () => BASE_MS,
    isAlive: async () => false,
  });

  const state = await readJson(paths.state);
  assert.equal(state.state, "NEEDS_HUMAN");
  assert.match(state.blocked_reason, /^AUTH_REQUIRED:/);
  assert.deepEqual(calls, []);
});

test("network outage waits before bounded read retry and never invokes a sender", async () => {
  let attempts = 0;
  const sleeps = [];
  const persisted = [];
  const job = {
    schema_version: 1,
    job_id: "job-network",
    conversation_url: CONVERSATION_URL,
    baseline: { assistant_count: 0 },
  };
  await runWatchLoop(job, {
    session: "fake-session",
    exec: async () => { attempts += 1; throw new Error("ENETDOWN"); },
    jobDir: "not-used",
    maxRetries: 0,
    maxConsecutivePollFailures: 2,
    pollIntervalMs: 2_000,
    sleep: async (ms) => sleeps.push(ms),
    now: () => BASE_MS,
    persist: async (args) => { persisted.push(args); return args; },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [2_000, 2_000]);
  assert.equal(persisted[0].state, "FAILED");
  assert.deepEqual(persisted[0].detections, ["cdp_unreachable"]);
  const watcherSource = await readFile(new URL("../src/gpt_watch.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(watcherSource, /from ["']\.\/gpt_send\.mjs["']/);
});

test("unknown Git dirt pauses recovery, writes attribution, and never cleans/stashes/resets", async (t) => {
  const state = projectState({
    active_terminal: { role: "worker", handle: "worker-old", title: "GBB-004-A1-worker" },
  });
  const { paths } = await tempRuntime(t, state);
  const runDir = await writeDispatch(paths, {
    worker: { title: "GBB-004-A1-worker", command: "codex" },
  });
  const commands = [];
  let created = false;
  const result = await recoverActiveTerminal({
    paths,
    now: () => BASE_MS,
    gitExec: async (args) => {
      commands.push(args);
      if (args[0] === "status") return { stdout: " M src/unknown.mjs\n?? notes.txt\n" };
      return { stdout: "src/unknown.mjs\n" };
    },
    orca: orca({ createTerminal: async () => { created = true; return { handle: "bad" }; } }),
  }, state, defaultRecoveryState(), "2026-08-01T09:00:00+08:00");

  assert.equal(result.state.state, "NEEDS_HUMAN");
  assert.match(result.state.blocked_reason, /^DIRTY_ATTRIBUTION_UNKNOWN:/);
  assert.equal(created, false);
  assert.doesNotMatch(JSON.stringify(commands), /reset|clean|stash/);
  const report = await readFile(path.join(runDir, "dirty_attribution_report.md"), "utf8");
  assert.match(report, /M src\/unknown\.mjs/);
  assert.match(report, /Supervisor paused rather than resetting\/stashing\/cleaning/);
});

test("failing test evidence is forwarded for Control Tower worker rework, never ignored or self-decided", async (t) => {
  const state = projectState({ state: "WAITING_REVIEWER", current_phase: "reviewer" });
  const { paths } = await tempRuntime(t, state);
  const runDir = await writeDispatch(paths, {});
  await writeFile(path.join(runDir, "test_report.json"), JSON.stringify({ pass: false, failed: 2 }));
  await writeFile(path.join(runDir, "worker_report.md"), "tests: failing\n");

  const scan = await scanDurableReports({ paths }, state, "2026-08-01T09:00:00+08:00");
  assert.ok(scan.events.some((event) => event.type === "durable_report" && event.report === "worker"));
  assert.equal(state.state, "WAITING_REVIEWER", "only Control Tower may transition back to Worker");
});

test("three failed automatic restarts are followed by NEEDS_HUMAN, never a fourth terminal create", async (t) => {
  const state = projectState({
    active_terminal: { role: "control", handle: "control-old", title: "GBB-004-A1-control" },
  });
  const { paths } = await tempRuntime(t, state);
  await writeDispatch(paths, {
    control: { title: "GBB-004-A1-control", command: "codex" },
  });
  let nowMs = BASE_MS;
  let recoveryState = defaultRecoveryState();
  let currentState = state;
  let creates = 0;
  const ctx = {
    paths,
    now: () => nowMs,
    orca: orca({
      createTerminal: async () => { creates += 1; throw new Error("terminal crashed during start"); },
    }),
  };

  for (const advance of [0, 10_000, 30_000, 120_000]) {
    nowMs += advance;
    const result = await recoverActiveTerminal(ctx, currentState, recoveryState, "2026-08-01T09:00:00+08:00");
    currentState = result.state;
    recoveryState = result.recoveryState;
  }

  assert.equal(creates, 3);
  assert.equal(currentState.state, "NEEDS_HUMAN");
  assert.match(currentState.blocked_reason, /^REPEATED_TERMINAL_CRASH:/);
});

test("reply.md without result.json after an atomic-rename crash is not terminal", async (t) => {
  const { paths } = await tempRuntime(t);
  const jobDir = path.join(paths.jobsDir, "job-half-committed");
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "reply.md"), "complete-looking reply");

  const scan = await scanDurableReports({ paths }, projectState(), "2026-08-01T09:00:00+08:00");
  assert.equal(scan.events.some((event) => event.job_id === "job-half-committed"), false);
  const cursor = await readJson(paths.reportCursor);
  assert.deepEqual(cursor.seenJobs, []);
});

test("ORCA outage remains bounded and never uses resume delivery as a retry channel", async (t) => {
  const { root, paths } = await tempRuntime(t);
  let nowMs = BASE_MS;
  let statusCalls = 0;
  let sendCalls = 0;
  const fakeOrca = orca({
    status: async () => { statusCalls += 1; return { ok: false, state: "unreachable" }; },
    sendTerminal: async () => { sendCalls += 1; return {}; },
  });
  const tick = () => runLoopOnce({
    runtimeRoot: root,
    orca: fakeOrca,
    pid: 900,
    now: () => nowMs,
    isAlive: async () => false,
  });

  await tick();
  nowMs += 15_000;
  await tick();
  nowMs = BASE_MS + ORCA_UNAVAILABLE_ESCALATE_MS;
  await tick();

  assert.equal(statusCalls, 2);
  assert.equal(sendCalls, 0);
  assert.equal((await readJson(paths.state)).state, "NEEDS_HUMAN");
});
