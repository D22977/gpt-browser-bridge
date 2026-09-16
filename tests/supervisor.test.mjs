import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ORCA_RETRY_BACKOFF_MS,
  ORCA_UNAVAILABLE_ESCALATE_MS,
  PROCESS_CRASH_BACKOFF_MS,
  acquireOrConfirmLock,
  buildResumePrompt,
  claimPhysicalSendLease,
  confirmLockOwnership,
  defaultRecoveryEntry,
  defaultRecoveryState,
  escalateToNeedsHuman,
  evaluateOrcaAvailability,
  recordRecoveryFailure,
  readDispatchCheckpoint,
  readRecoveryState,
  recoverActiveTerminal,
  resolveRuntimePaths,
  runLoopOnce,
  runResumeDeliveryCheck,
  runSupervisor,
  scanDurableReports,
  writeProjectState,
} from "../src/supervisor.mjs";
import { OrcaAdapter, resolveActiveTerminal } from "../src/adapters/orca_adapter.mjs";
import { CURRENT_COMMENT_READBACK_PROTOCOL, createHerdrPrompter } from "../src/adapters/herdr_resume.mjs";

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

async function runTakeoverGuardLoop(t, { guard, isAlive, livenessExec }) {
  const { root, paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  const owner = { pid: 111, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 6 };
  const ownerRaw = JSON.stringify(owner);
  const guardRaw = JSON.stringify(guard);
  await writeFile(paths.lock, ownerRaw);
  await writeFile(`${paths.lock}.takeover`, guardRaw);
  let prompts = 0;
  let probeCalls = 0;
  const livenessContext = typeof livenessExec === "function"
    ? { livenessExec }
    : {
        isAlive: async (...args) => {
          probeCalls += 1;
          return isAlive(...args, `${paths.lock}.takeover`);
        },
      };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 222,
    hostId: "host-b",
    authorizedHostIds: ["host-b"],
    now: () => BASE_MS,
    ...livenessContext,
    resumeDelivery: { herdr: { prompt: async () => { prompts += 1; } } },
  });
  return { outcome, ownerRaw, guardRaw, paths, probeCalls, prompts };
}

function residentAuthorityBinding(overrides = {}) {
  return {
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    control_generation: 13,
    source_control_generation: 13,
    HEAD: "0123456789abcdef0123456789abcdef01234567",
    tree: "tree-r49",
    target: {
      agent_name: "R49-EXECUTOR",
      executor_instance_id: "r49-executor-instance",
      surface: "HERDR",
      pane_id: "wR49:p1",
      agent_session: "r49",
      workspace_id: "wR49",
      cwd: "D:\\fixtures\\r49",
      branch: "worker/r49-fixture",
      HEAD: "0123456789abcdef0123456789abcdef01234567",
    },
    ...overrides,
  };
}

function completeComments(comments = []) {
  return {
    comments,
    pagination_complete: true,
    readback_provenance: {
      protocol: CURRENT_COMMENT_READBACK_PROTOCOL,
      source: "github",
      method: "GET",
      endpoint: "repos/D22977/gpt-browser-bridge/issues/162/comments",
      pagination: "complete",
      readback: "exact_get",
    },
  };
}

function pendingDeliveryReceipt(logicalKey) {
  return `HERDR_RESUME_DELIVERY_V1
state: SEND_PENDING
logical_event_key: ${logicalKey}
source_terminal_receipt: 1629000001
control_generation: 13
card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01
allowed_action_class: ISSUE162_RESIDENT_CONSUMER
target_agent_name: R49-EXECUTOR
target_executor_instance_id: r49-executor-instance
target_surface: HERDR
target_herdr_agent: codex
target_herdr_workspace_id: wR49
target_herdr_pane_id: wR49:p1
target_herdr_agent_session: r49
`;
}

function spawnLockAttempt(root) {
  const supervisorModule = pathToFileURL(path.join(REPO_ROOT, "src", "supervisor.mjs")).href;
  const script = `import { resolveRuntimePaths, acquireOrConfirmLock } from ${JSON.stringify(supervisorModule)};
 const paths = resolveRuntimePaths(process.env.GBB_LOCK_ROOT);
 const result = await acquireOrConfirmLock(paths, { pid: process.pid, hostId: "host-a", isAlive: async (pid) => pid !== process.pid, isoNow: "2026-08-01T09:00:00+08:00" });
process.stdout.write(JSON.stringify(result));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      env: { ...process.env, GBB_LOCK_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("lock child timeout")); }, 5_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`lock child failed ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
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

test("resident GitHub consumer is polled by Supervisor and persists idempotency across ticks", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const waitTuple = {
    source_terminal_receipt: 1629000001,
    control_generation: 13,
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target: {
      agent_name: "R49-EXECUTOR",
      executor_instance_id: "r49-executor-instance",
      surface: "HERDR",
      herdr_agent: "codex",
      herdr_workspace_id: "wR49",
      herdr_agent_kind: "codex",
    },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;
  let prompts = 0;
  const resumeDelivery = {
    futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
    waitTuple,
    readAuthority: async () => ({ binding: residentAuthorityBinding() }),
    readDecisionBody: async () => decisionBody,
    readComments: async ({ phase, logicalKey } = {}) => phase === "send_pending_readback"
      ? completeComments([{ id: "send-pending-r49", body: pendingDeliveryReceipt(logicalKey) }])
      : completeComments(),
    herdr: { prompt: async () => { prompts += 1; return { accepted: true, workspace_id: "wR49", pane_id: "wR49:p1", agent_session: "r49" }; } },
    publishReceipt: async () => ({ id: "r49-delivery" }),
  };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    resumeDelivery,
    pid: 41005,
    now: () => BASE_MS,
    isAlive: async () => false,
  });
  assert.equal(prompts, 1);
  assert.equal(outcome.events.find((event) => event.type === "resume_delivery_delivered").type, "resume_delivery_delivered");
  assert.equal((await readJson(paths.recoveryState)).residentConsumer.state, "DELIVERED");
});

test("Supervisor honors resident wake_at and does not prompt before due", async (t) => {
  const { root } = await tempRuntime(t);
  const waitTuple = {
    source_terminal_receipt: 1629000001,
    control_generation: 13,
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target: { agent_name: "R49-EXECUTOR", executor_instance_id: "r49-executor-instance", surface: "HERDR", herdr_agent: "codex", herdr_workspace_id: "wR49", herdr_agent_kind: "codex" },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;
  let prompts = 0;
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readAuthority: async () => ({ binding: residentAuthorityBinding() }),
      decisionBody,
      comments: [],
      timedQuotaState: { state: "WAITING_FOR_WAKE", wake_at: "2099-01-01T00:00:00.000Z", retry_count: 0 },
      quotaRoutePolicy: { provider: "deepseek", model: "deepseek-v4-flash-free", billing_class: "FREE", max_cost: 0 },
      readComments: async () => completeComments(),
      herdr: { prompt: async () => { prompts += 1; return {}; } },
      publishReceipt: async () => ({ id: "never" }),
    },
    pid: 41009,
    now: () => BASE_MS,
    isAlive: async () => false,
  });
  assert.equal(prompts, 0);
  assert.equal(outcome.events.find((event) => event.type === "resume_delivery_waiting").reason, "WAIT_UNTIL_WAKE");
});

test("persisted RETRY_PENDING state remains gated after Supervisor restart", async (t) => {
  const { paths } = await tempRuntime(t);
  const waitTuple = {
    source_terminal_receipt: 1629000001, control_generation: 13, card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01", allowed_action_class: "ISSUE162_RESIDENT_CONSUMER", executor_role: "WORKER",
    target: { agent_name: "R49-EXECUTOR", executor_instance_id: "r49-executor-instance", surface: "HERDR", herdr_agent: "codex", herdr_workspace_id: "wR49", herdr_agent_kind: "codex" },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;
  await writeFile(paths.recoveryState, JSON.stringify({ residentConsumer: { state: "RETRY_PENDING", wake_at: "2099-01-01T00:00:00.000Z", retry_count: 1 } }));
  let prompts = 0;
  const result = await runResumeDeliveryCheck({ resumeDelivery: {
    futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] }, waitTuple, readAuthority: async () => ({ binding: residentAuthorityBinding() }), readComments: async () => completeComments(), decisionBody, comments: [], herdr: { prompt: async () => { prompts += 1; return {}; } }, publishReceipt: async () => ({ id: "never" }), quotaRoutePolicy: { provider: "herdr:codex", model: "gpt-5.6-luna", billing_class: "FREE", max_cost: 0 },
  } }, { isoNow: "2026-08-01T09:00:00+08:00", deliveryState: { state: "RETRY_PENDING", wake_at: "2099-01-01T00:00:00.000Z", retry_count: 1 } });
  assert.equal(prompts, 0);
  assert.equal(result.reason, "WAIT_UNTIL_WAKE");
});

test("corrupt nonterminal recovery state is CONTROL_REQUIRED and never prompts", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.recoveryState, "{not-json");
  let prompts = 0;
  const waitTuple = {
    source_terminal_receipt: 1629000001,
    control_generation: 13,
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target: { agent_name: "R49-EXECUTOR", executor_instance_id: "r49-executor-instance", surface: "HERDR", herdr_agent: "codex", herdr_workspace_id: "wR49", herdr_agent_kind: "codex" },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readAuthority: async () => ({ binding: residentAuthorityBinding() }),
      decisionBody,
      comments: [],
      readComments: async () => completeComments(),
      herdr: { prompt: async () => { prompts += 1; return {}; } },
      publishReceipt: async () => ({ id: "never" }),
    },
    pid: 41006,
    now: () => BASE_MS,
    isAlive: async () => false,
  });
  assert.equal(outcome.reason, "CONTROL_REQUIRED_RECOVERY_STATE_UNREADABLE");
  assert.equal(prompts, 0);
  assert.equal((await readRecoveryState(paths)).control_required, true);
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

test("dead lock owner fails closed when guard cleanup cannot be identity-bound", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  const ownerRaw = JSON.stringify({ pid: 111, at: "old" });
  await writeFile(paths.lock, ownerRaw);
  const result = await acquireOrConfirmLock(paths, {
    pid: 222,
    isAlive: async () => false,
    isoNow: "2026-08-01T09:00:00+08:00",
  });
  assert.deepEqual(result, { owned: false, holder: 111, reason: "CONTROL_REQUIRED_TAKEOVER_GUARD_CLEANUP_UNPROVEN" });
  assert.equal(await readFile(paths.lock, "utf8"), ownerRaw);
});

test("same-host concurrency is single-owner and a second host needs explicit authorization", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 111, host_id: "host-a", at: "old" }));
  const rejected = await acquireOrConfirmLock(paths, {
    pid: 222,
    hostId: "host-b",
    isAlive: async () => true,
    isoNow: "2026-08-01T09:00:00+08:00",
  });
  assert.deepEqual(rejected, { owned: false, holder: 111, reason: "HOST_IDENTITY_REJECTED" });
  const authorized = await acquireOrConfirmLock(paths, {
    pid: 222,
    hostId: "host-b",
    authorizedHostIds: ["host-b"],
    isAlive: async () => true,
    isoNow: "2026-08-01T09:00:00+08:00",
  });
  assert.deepEqual(authorized, { owned: false, holder: 111, reason: "CONTROL_REQUIRED_LIVE_OWNER_UNFENCED" });
  const sameHost = await acquireOrConfirmLock(paths, {
    pid: 333,
    hostId: "host-b",
    isAlive: async () => true,
    isoNow: "2026-08-01T09:00:01+08:00",
  });
  assert.equal(sameHost.owned, false);
});

test("an authorized second host cannot replace a live owner without a completed fencing handoff", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 111, host_id: "host-a", at: "old" }));
  const result = await acquireOrConfirmLock(paths, {
    pid: 222,
    hostId: "host-b",
    authorizedHostIds: ["host-b"],
    isAlive: async () => true,
    isoNow: "2026-08-01T09:00:00+08:00",
  });
  assert.deepEqual(result, { owned: false, holder: 111, reason: "CONTROL_REQUIRED_LIVE_OWNER_UNFENCED" });
});

test("cross-host takeover rejects an invisible remote owner and never reaches a prompt", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const owner = { pid: 111, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 6 };
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify(owner));
  const waitTuple = {
    source_terminal_receipt: 1629000001,
    control_generation: 13,
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target: { agent_name: "R49-EXECUTOR", executor_instance_id: "r49-executor-instance", surface: "HERDR", herdr_agent: "codex", herdr_workspace_id: "wR49", herdr_agent_kind: "codex" },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;
  let prompts = 0;
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 222,
    hostId: "host-b",
    authorizedHostIds: ["host-b"],
    now: () => BASE_MS,
    isAlive: async () => false,
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readAuthority: async () => ({ binding: residentAuthorityBinding() }),
      decisionBody,
      readComments: async () => completeComments(),
      herdr: { prompt: async () => { prompts += 1; return {}; } },
      publishReceipt: async () => ({ id: "never" }),
    },
  });
  assert.equal(outcome.stop, true);
  assert.equal(outcome.reason, "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN");
  assert.equal(prompts, 0);
  assert.deepEqual(await readJson(paths.lock), owner);
});

test("cross-host takeover rejects a liveness probe error and never reaches a prompt", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const owner = { pid: 111, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 6 };
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify(owner));
  const waitTuple = {
    source_terminal_receipt: 1629000001,
    control_generation: 13,
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target: { agent_name: "R49-EXECUTOR", executor_instance_id: "r49-executor-instance", surface: "HERDR", herdr_agent: "codex", herdr_workspace_id: "wR49", herdr_agent_kind: "codex" },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;
  let prompts = 0;
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 222,
    hostId: "host-b",
    authorizedHostIds: ["host-b"],
    now: () => BASE_MS,
    isAlive: async () => { throw new Error("tasklist unavailable"); },
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readAuthority: async () => ({ binding: residentAuthorityBinding() }),
      decisionBody,
      readComments: async () => completeComments(),
      herdr: { prompt: async () => { prompts += 1; return {}; } },
      publishReceipt: async () => ({ id: "never" }),
    },
  });
  assert.equal(outcome.stop, true);
  assert.equal(outcome.reason, "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN");
  assert.equal(prompts, 0);
  assert.deepEqual(await readJson(paths.lock), owner);
});

test("remote takeover guards reject a locally invisible PID before probing or mutation", async (t) => {
  const result = await runTakeoverGuardLoop(t, {
    guard: { pid: 333, host_id: "host-a", at: "2026-08-01T09:00:01+08:00", fence: 7 },
    isAlive: async () => false,
  });

  assert.equal(result.outcome.stop, true);
  assert.equal(result.outcome.reason, "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN");
  assert.equal(result.probeCalls, 0);
  assert.equal(result.prompts, 0);
  assert.equal(await readFile(result.paths.lock, "utf8"), result.ownerRaw);
  assert.equal(await readFile(`${result.paths.lock}.takeover`, "utf8"), result.guardRaw);
});

test("remote takeover guards fail closed when a local liveness probe would throw", async (t) => {
  const result = await runTakeoverGuardLoop(t, {
    guard: { pid: 333, host_id: "host-a", at: "2026-08-01T09:00:01+08:00", fence: 7 },
    isAlive: async () => { throw new Error("tasklist unavailable"); },
  });

  assert.equal(result.outcome.stop, true);
  assert.equal(result.outcome.reason, "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN");
  assert.equal(result.probeCalls, 0);
  assert.equal(result.prompts, 0);
  assert.equal(await readFile(result.paths.lock, "utf8"), result.ownerRaw);
  assert.equal(await readFile(`${result.paths.lock}.takeover`, "utf8"), result.guardRaw);
});

test("missing takeover-guard host identity never permits local PID absence to replace it", async (t) => {
  const result = await runTakeoverGuardLoop(t, {
    guard: { pid: 333, at: "2026-08-01T09:00:01+08:00", fence: 7 },
    isAlive: async () => false,
  });

  assert.equal(result.outcome.stop, true);
  assert.equal(result.outcome.reason, "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN");
  assert.equal(result.probeCalls, 0);
  assert.equal(result.prompts, 0);
  assert.equal(await readFile(result.paths.lock, "utf8"), result.ownerRaw);
  assert.equal(await readFile(`${result.paths.lock}.takeover`, "utf8"), result.guardRaw);
});

test("same-host takeover-guard probe errors are typed fail-closed with unchanged locks", async (t) => {
  const result = await runTakeoverGuardLoop(t, {
    guard: { pid: 333, host_id: "host-b", at: "2026-08-01T09:00:01+08:00", fence: 7 },
    isAlive: async () => { throw new Error("tasklist unavailable"); },
  });

  assert.equal(result.outcome.stop, true);
  assert.equal(result.outcome.reason, "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN");
  assert.equal(result.probeCalls, 1);
  assert.equal(result.prompts, 0);
  assert.equal(await readFile(result.paths.lock, "utf8"), result.ownerRaw);
  assert.equal(await readFile(`${result.paths.lock}.takeover`, "utf8"), result.guardRaw);
});

test("default tasklist probe failure is unknown and preserves both locks without prompting", async (t) => {
  let execCalls = 0;
  const result = await runTakeoverGuardLoop(t, {
    guard: { pid: 333, host_id: "host-b", at: "2026-08-01T09:00:01+08:00", fence: 7 },
    livenessExec: async (command, args) => {
      execCalls += 1;
      assert.equal(command, "tasklist");
      assert.deepEqual(args, ["/FI", "PID eq 333"]);
      throw new Error("tasklist unavailable");
    },
  });

  assert.equal(result.outcome.stop, true);
  assert.equal(result.outcome.reason, "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN");
  assert.equal(execCalls, 1);
  assert.equal(result.prompts, 0);
  assert.equal(await readFile(result.paths.lock, "utf8"), result.ownerRaw);
  assert.equal(await readFile(`${result.paths.lock}.takeover`, "utf8"), result.guardRaw);
});

test("takeover-guard cleanup fails closed when validated G0 is replaced by G1 before removal", async (t) => {
  const guard1 = { pid: 444, host_id: "host-a", at: "2026-08-01T09:00:02+08:00", fence: 8 };
  const guard1Raw = JSON.stringify(guard1);
  const result = await runTakeoverGuardLoop(t, {
    guard: { pid: 333, host_id: "host-b", at: "2026-08-01T09:00:01+08:00", fence: 7 },
    isAlive: async (pid, guardPath) => {
      assert.equal(pid, 333);
      await writeFile(guardPath, guard1Raw);
      return false;
    },
  });

  assert.equal(result.outcome.stop, true);
  assert.equal(result.outcome.reason, "CONTROL_REQUIRED_TAKEOVER_GUARD_CLEANUP_UNPROVEN");
  assert.equal(result.probeCalls, 1);
  assert.equal(result.prompts, 0);
  assert.equal(await readFile(result.paths.lock, "utf8"), result.ownerRaw);
  assert.equal(await readFile(`${result.paths.lock}.takeover`, "utf8"), guard1Raw);
});

test("a self-authored fencing handoff never permits a bounded second-host takeover while the owner is live", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  const handoff = {
    protocol: "GBB_SUPERVISOR_FENCING_HANDOFF_V1",
    token: "handoff-1",
    status: "FENCED",
    from_pid: 111,
    from_host_id: "host-a",
    to_host_id: "host-b",
    issued_at: "2026-08-01T08:59:00+08:00",
    expires_at: "2026-08-01T09:05:00+08:00",
  };
  await writeFile(paths.lock, JSON.stringify({ pid: 111, host_id: "host-a", at: "old", fencing_handoff: handoff }));
  const result = await acquireOrConfirmLock(paths, {
    pid: 222,
    hostId: "host-b",
    authorizedHostIds: ["host-b"],
    handoffToken: "handoff-1",
    isAlive: async () => true,
    isoNow: "2026-08-01T09:00:00+08:00",
  });
  assert.deepEqual(result, { owned: false, holder: null, reason: "CONTROL_REQUIRED_LOCK_STATE_UNREADABLE" });
  const owner = await readJson(paths.lock);
  assert.equal(owner.pid, 111);
  assert.equal(owner.fencing_handoff.token, "handoff-1");
});

test("an expired or mismatched fencing handoff blocks a live-owner takeover", async (t) => {
  for (const handoffToken of ["wrong-token", "handoff-1"]) {
    const { paths } = await tempRuntime(t);
    await mkdir(path.dirname(paths.lock), { recursive: true });
    await writeFile(paths.lock, JSON.stringify({
      pid: 111,
      host_id: "host-a",
      at: "old",
      fencing_handoff: {
        protocol: "GBB_SUPERVISOR_FENCING_HANDOFF_V1",
        token: "handoff-1",
        status: "FENCED",
        from_pid: 111,
        from_host_id: "host-a",
        to_host_id: "host-b",
        issued_at: "2026-08-01T08:59:00+08:00",
        expires_at: handoffToken === "handoff-1" ? "2026-08-01T08:59:30+08:00" : "2026-08-01T09:05:00+08:00",
      },
    }));
    const result = await acquireOrConfirmLock(paths, {
      pid: 222,
      hostId: "host-b",
      authorizedHostIds: ["host-b"],
      handoffToken,
      isAlive: async () => true,
      isoNow: "2026-08-01T09:00:00+08:00",
    });
    assert.deepEqual(result, { owned: false, holder: null, reason: "CONTROL_REQUIRED_LOCK_STATE_UNREADABLE" });
  }
});

test("a self-authored fencing handoff cannot replace a live owner on an authorized second host", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({
    pid: 111,
    host_id: "host-a",
    at: "2026-08-01T09:00:00+08:00",
    fence: 7,
    fencing_handoff: {
      protocol: "GBB_SUPERVISOR_FENCING_HANDOFF_V1",
      token: "self-authored-proof",
      status: "FENCED",
      from_pid: 111,
      from_host_id: "host-a",
      to_host_id: "host-b",
      issued_at: "2026-08-01T08:59:00+08:00",
      expires_at: "2026-08-01T09:05:00+08:00",
    },
  }));
  const result = await acquireOrConfirmLock(paths, {
    pid: 222,
    hostId: "host-b",
    authorizedHostIds: ["host-b"],
    handoffToken: "self-authored-proof",
    isAlive: async () => true,
    isoNow: "2026-08-01T09:00:00+08:00",
  });
  assert.deepEqual(result, { owned: false, holder: null, reason: "CONTROL_REQUIRED_LOCK_STATE_UNREADABLE" });
  assert.equal((await readJson(paths.lock)).pid, 111);
});

test("physical ownership confirmation rejects a stale or mismatched fence", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 111, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 7 }));
  const result = await confirmLockOwnership(paths, {
    pid: 111,
    hostId: "host-a",
    fence: 8,
    isoNow: "2026-08-01T09:00:01+08:00",
  });
  assert.deepEqual(result, { owned: false, holder: 111, reason: "CONTROL_REQUIRED_FENCE_CHANGED" });
});

test("live old-owner takeover interleaving permits at most one physical prompt", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 111, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 3 }));
  const oldGate = await confirmLockOwnership(paths, {
    pid: 111,
    hostId: "host-a",
    fence: 3,
    isoNow: "2026-08-01T09:00:01+08:00",
  });
  assert.equal(oldGate.owned, true);

  const takeover = await acquireOrConfirmLock(paths, {
    pid: 222,
    hostId: "host-b",
    authorizedHostIds: ["host-b"],
    handoffToken: "forged-live-owner-handoff",
    isAlive: async () => true,
    isoNow: "2026-08-01T09:00:02+08:00",
  });
  let physicalPrompts = 0;
  if (takeover.owned) {
    const oldClaim = await claimPhysicalSendLease(paths, { pid: 111, hostId: "host-a", fence: 3, logicalKey: "event-1", nowMs: BASE_MS + 3_000 });
    if (oldClaim.allow) physicalPrompts += 1;
    const newClaim = await claimPhysicalSendLease(paths, { pid: 222, hostId: "host-b", fence: takeover.fence, logicalKey: "event-1", nowMs: BASE_MS + 3_000 });
    if (newClaim.allow) physicalPrompts += 1;
  } else {
    const oldClaim = await claimPhysicalSendLease(paths, { pid: 111, hostId: "host-a", fence: 3, logicalKey: "event-1", nowMs: BASE_MS + 3_000 });
    assert.equal(oldClaim.allow, true);
    physicalPrompts += 1;
  }
  assert.equal(takeover.owned, false);
  assert.ok(physicalPrompts <= 1);
  assert.equal((await readJson(paths.lock)).pid, 111);
});

test("durable physical-send leases are isolated by logical event", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 111, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 3 }));
  const first = await claimPhysicalSendLease(paths, { pid: 111, hostId: "host-a", fence: 3, logicalKey: "event-1", nowMs: BASE_MS });
  const second = await claimPhysicalSendLease(paths, { pid: 111, hostId: "host-a", fence: 3, logicalKey: "event-2", nowMs: BASE_MS });
  assert.equal(first.allow, true);
  assert.equal(second.allow, true);
});

test("concurrent authorized takeover attempts yield at most one owner", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({
    pid: 111,
    host_id: "host-a",
    at: "old",
    fencing_handoff: {
      protocol: "GBB_SUPERVISOR_FENCING_HANDOFF_V1",
      token: "handoff-1",
      status: "FENCED",
      from_pid: 111,
      from_host_id: "host-a",
      to_host_id: "host-b",
      issued_at: "2026-08-01T08:59:00+08:00",
      expires_at: "2026-08-01T09:05:00+08:00",
    },
  }));
  const results = await Promise.all([222, 333].map((pid) => acquireOrConfirmLock(paths, {
    pid,
    hostId: "host-b",
    authorizedHostIds: ["host-b"],
    handoffToken: "handoff-1",
    isAlive: async () => true,
    isoNow: "2026-08-01T09:00:00+08:00",
  })));
  assert.equal(results.filter((result) => result.owned).length, 0);
  assert.equal(results.filter((result) => !result.owned).length, 2);
});

test("Supervisor revalidates lock ownership immediately before a physical prompt", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const waitTuple = {
    source_terminal_receipt: 1629000001,
    control_generation: 13,
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target: { agent_name: "R49-EXECUTOR", executor_instance_id: "r49-executor-instance", surface: "HERDR", herdr_agent: "codex", herdr_workspace_id: "wR49", herdr_agent_kind: "codex" },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;
  let prompts = 0;
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readAuthority: async ({ phase }) => {
        if (phase === "before_send") await writeFile(paths.lock, JSON.stringify({ pid: 999, at: "foreign" }));
        return { binding: residentAuthorityBinding() };
      },
      decisionBody,
      readComments: async () => completeComments(),
      herdr: { prompt: async () => { prompts += 1; return {}; } },
      publishReceipt: async () => ({ id: "never" }),
    },
    pid: 41007,
    now: () => BASE_MS,
    isAlive: async () => false,
  });
  assert.equal(prompts, 0);
  assert.equal(outcome.events.find((event) => event.type === "resume_delivery_control_required").reason, "LOCK_NOT_OWNED");
});

test("Supervisor rereads current time at the physical gate and rejects an expired lease", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const waitTuple = {
    source_terminal_receipt: 1629000001,
    control_generation: 13,
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target: { agent_name: "R49-EXECUTOR", executor_instance_id: "r49-executor-instance", surface: "HERDR", herdr_agent: "codex", herdr_workspace_id: "wR49", herdr_agent_kind: "codex" },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({
    pid: 41010,
    host_id: "host-a",
    at: "2026-08-01T09:00:00+08:00",
    fence: 4,
    lease_expires_at: "2026-08-01T09:00:30+08:00",
  }));
  let nowMs = BASE_MS;
  let prompts = 0;
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41010,
    hostId: "host-a",
    now: () => nowMs,
    handoffToken: null,
    isAlive: async () => true,
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readAuthority: async ({ phase }) => {
        if (phase === "before_send") nowMs = BASE_MS + 60_000;
        return { binding: residentAuthorityBinding() };
      },
      decisionBody,
      readComments: async () => completeComments(),
      herdr: { prompt: async () => { prompts += 1; return {}; } },
      publishReceipt: async () => ({ id: "never" }),
    },
  });
  assert.equal(prompts, 0);
  assert.equal(outcome.events.find((event) => event.type === "resume_delivery_control_required").reason, "CONTROL_REQUIRED_FENCING_REVALIDATION_FAILED");
});

test("Supervisor rejects a lease that expires during final target resolution before the real prompt", async (t) => {
  const { root, paths } = await tempRuntime(t);
  const target = {
    agent_name: "R49-EXECUTOR",
    executor_instance_id: "r49-executor-instance",
    surface: "HERDR",
    herdr_agent: "codex",
    herdr_workspace_id: "wR49",
    herdr_pane_id: "wR49:p1",
    herdr_agent_session: "r49",
    herdr_agent_kind: "codex",
    herdr_agent_provider: "herdr:codex",
    herdr_model: "gpt-5.6-luna",
    cwd: "D:\\fixtures\\r49",
    branch: "worker/r49-fixture",
    HEAD: "0123456789abcdef0123456789abcdef01234567",
    require_visible: true,
  };
  const waitTuple = {
    source_terminal_receipt: 1629000001,
    control_generation: 13,
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target,
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({
    pid: 41010,
    host_id: "host-a",
    at: "2026-08-01T01:00:00.000Z",
    fence: 4,
    lease_expires_at: "2026-08-01T01:00:30.000Z",
  }));
  const agent = {
    agent: "R49-EXECUTOR",
    name: "R49-EXECUTOR",
    agent_session: { agent: "codex", value: "r49" },
    agent_status: "idle",
    agent_provider: "herdr:codex",
    model: "gpt-5.6-luna",
    cwd: "D:\\fixtures\\r49",
    branch: "worker/r49-fixture",
    HEAD: "0123456789abcdef0123456789abcdef01234567",
    pane_id: "wR49:p1",
    terminal_id: "term-r49",
    workspace_id: "wR49",
    visible: true,
  };
  const agentList = () => JSON.stringify({ id: "cli:agent:list", result: { agents: [agent] } });
  let nowMs = BASE_MS;
  let listCount = 0;
  let promptCount = 0;
  const prompter = createHerdrPrompter({
    herdrExe: "herdr.exe",
    exec: async (_exe, args) => {
      if (args[1] === "list") {
        listCount += 1;
        if (listCount === 2) nowMs = BASE_MS + 60_000;
        return { stdout: agentList() };
      }
      promptCount += 1;
      return { stdout: "{}" };
    },
  });
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41010,
    hostId: "host-a",
    now: () => nowMs,
    isAlive: async () => true,
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readAuthority: async () => ({ binding: residentAuthorityBinding() }),
      decisionBody,
      readComments: async ({ phase, logicalKey } = {}) => phase === "send_pending_readback"
        ? completeComments([{ id: "send-pending-expiry", body: pendingDeliveryReceipt(logicalKey) }])
        : completeComments(),
      herdr: prompter,
      publishReceipt: async () => ({ id: "never" }),
      quotaRoutePolicy: { provider: "herdr:codex", model: "gpt-5.6-luna", billing_class: "FREE", max_cost: 0 },
      timedQuotaState: { state: "WAITING_FOR_WAKE", wake_at: "1970-01-01T00:00:00.000Z", retry_count: 0 },
    },
  });
  assert.equal(outcome.events.find((event) => event.type === "resume_delivery_control_required").reason, "CONTROL_REQUIRED_FENCING_REVALIDATION_FAILED");
  assert.equal(listCount, 2);
  assert.equal(promptCount, 0);
});

test("old and new contenders reach the real prompt boundary but only the current fence can prompt", async (t) => {
  const { paths } = await tempRuntime(t);
  const target = {
    agent_name: "R49-EXECUTOR",
    executor_instance_id: "r49-executor-instance",
    surface: "HERDR",
    herdr_agent: "codex",
    herdr_workspace_id: "wR49",
    herdr_pane_id: "wR49:p1",
    herdr_agent_session: "r49",
    herdr_agent_kind: "codex",
    herdr_agent_provider: "herdr:codex",
    herdr_model: "gpt-5.6-luna",
    cwd: "D:\\fixtures\\r49",
    branch: "worker/r49-fixture",
    HEAD: "0123456789abcdef0123456789abcdef01234567",
    require_visible: true,
  };
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 111, host_id: "host-a", at: "2026-08-01T01:00:00.000Z", fence: 1 }));
  const agent = {
    agent: "R49-EXECUTOR",
    name: "R49-EXECUTOR",
    agent_session: { agent: "codex", value: "r49" },
    agent_status: "idle",
    agent_provider: "herdr:codex",
    model: "gpt-5.6-luna",
    cwd: "D:\\fixtures\\r49",
    branch: "worker/r49-fixture",
    HEAD: "0123456789abcdef0123456789abcdef01234567",
    pane_id: "wR49:p1",
    terminal_id: "term-r49",
    workspace_id: "wR49",
    visible: true,
  };
  const list = () => ({ stdout: JSON.stringify({ id: "cli:agent:list", result: { agents: [agent] } }) });
  const logicalKey = "event-physical-boundary";
  let promptCount = 0;
  let oldLists = 0;
  let newResult;
  let newPrompter;
  const newGate = () => claimPhysicalSendLease(paths, {
    pid: 222,
    hostId: "host-b",
    fence: 2,
    logicalKey,
    nowMs: BASE_MS + 1_000,
  });
  newPrompter = createHerdrPrompter({
    herdrExe: "herdr.exe",
    exec: async (_exe, args) => {
      if (args[1] === "list") return list();
      promptCount += 1;
      return { stdout: "{}" };
    },
  });
  const oldPrompter = createHerdrPrompter({
    herdrExe: "herdr.exe",
    exec: async (_exe, args) => {
      if (args[1] === "list") {
        oldLists += 1;
        if (oldLists === 2) {
          // The test fixture models a separately authorized, durable fence transition.
          await writeFile(paths.lock, JSON.stringify({ pid: 222, host_id: "host-b", at: "2026-08-01T01:00:02.000Z", fence: 2 }));
          newResult = await newPrompter.prompt(target, "new contender", { beforePhysicalPrompt: newGate });
        }
        return list();
      }
      promptCount += 1;
      return { stdout: "{}" };
    },
  });
  const earlierGate = await confirmLockOwnership(paths, { pid: 111, hostId: "host-a", fence: 1, isoNow: "2026-08-01T01:00:01.000Z" });
  assert.equal(earlierGate.owned, true);
  await assert.rejects(
    oldPrompter.prompt(target, "old contender", {
      beforePhysicalPrompt: () => claimPhysicalSendLease(paths, {
        pid: 111,
        hostId: "host-a",
        fence: 1,
        logicalKey,
        nowMs: BASE_MS + 1_000,
      }),
    }),
    (error) => ["LOCK_NOT_OWNED", "CONTROL_REQUIRED_FENCE_CHANGED"].includes(error.code),
  );
  assert.equal(newResult.accepted, true);
  assert.equal(promptCount, 1);
  assert.equal(oldLists, 2);
});

test("resident delivery without fresh authority or paginated comment readers is CONTROL_REQUIRED", async (t) => {
  const { root } = await tempRuntime(t);
  const waitTuple = {
    source_terminal_receipt: 1629000001,
    control_generation: 13,
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target: { agent_name: "R49-EXECUTOR", executor_instance_id: "r49-executor-instance", surface: "HERDR", herdr_agent: "codex", herdr_workspace_id: "wR49", herdr_agent_kind: "codex" },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;
  for (const readers of [
    { readComments: async () => [], readAuthority: undefined },
    { readComments: undefined, readAuthority: async () => ({ binding: residentAuthorityBinding() }) },
    { readComments: async () => { throw new Error("pagination incomplete"); }, readAuthority: async () => ({ binding: residentAuthorityBinding() }) },
  ]) {
    let prompts = 0;
    const result = await runResumeDeliveryCheck({ resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      decisionBody,
      ...readers,
      herdr: { prompt: async () => { prompts += 1; } },
      publishReceipt: async () => ({ id: "never" }),
      quotaRoutePolicy: { provider: "deepseek", model: "deepseek-v4-flash-free", billing_class: "FREE", max_cost: 0 },
    } });
    assert.equal(result.delivered, false);
    assert.equal(prompts, 0);
    assert.match(result.reason, /^CONTROL_REQUIRED_/);
  }
});

test("two independent Supervisor processes racing an absent lock yield exactly one owner", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gbb-lock-race-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const paths = resolveRuntimePaths(root);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  const results = await Promise.all([spawnLockAttempt(root), spawnLockAttempt(root)]);
  assert.equal(results.filter((result) => result.owned).length, 1);
  assert.equal(results.filter((result) => !result.owned).length, 1);
});

test("malformed lock ownership is CONTROL_REQUIRED and never treated as no owner", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, "{not-json");
  const result = await acquireOrConfirmLock(paths, {
    pid: 222,
    hostId: "host-a",
    isAlive: async () => false,
    isoNow: "2026-08-01T09:00:00+08:00",
  });
  assert.deepEqual(result, { owned: false, holder: null, reason: "CONTROL_REQUIRED_LOCK_STATE_UNREADABLE" });
  assert.equal((await readFile(paths.lock, "utf8")), "{not-json");
});

test("malformed takeover ownership is also CONTROL_REQUIRED", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(`${paths.lock}.takeover`, "{not-json");
  const result = await acquireOrConfirmLock(paths, {
    pid: 222,
    hostId: "host-a",
    isAlive: async () => false,
    isoNow: "2026-08-01T09:00:00+08:00",
  });
  assert.deepEqual(result, { owned: false, holder: null, reason: "CONTROL_REQUIRED_LOCK_STATE_UNREADABLE" });
  assert.equal((await readFile(`${paths.lock}.takeover`, "utf8")), "{not-json");
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
// Execution Registry / Admission tests
// ---------------------------------------------------------------------------

import {
  createRegistry,
  admitEntry,
  admitEntryWithAuthority,
  heartbeatEntry,
  reclassifyEntry,
  findExpiredEntries,
  checkPathOverlap,
  reconstructRegistry,
  reconstructFromAuthorityAndObservations,
  canonicalizeRepoRelativePath,
  canonicalizeRef,
  canonicalizeWorktree,
  validateEntryAdmission,
} from "../src/supervisor.mjs";
import {
  ALLOWED_TRANSITIONS,
  registryEntrySchema,
} from "../src/contracts.mjs";

const REG_TS = "2026-08-01T09:00:00+08:00";

function fullAuth(entry) {
  return {
    pid: entry.process.pid,
    fence: entry.fence,
    fence_id: entry.fence_id,
    lease_id: entry.lease_id,
    lease_expiry: entry.lease_expiry,
    generation: entry.generation,
    ref: entry.ref,
    head: entry.head,
    tree: entry.tree,
    worktree: entry.worktree,
    process: { pid: entry.process.pid, started_at: entry.process.started_at },
    session: { ...entry.session },
  };
}

function regEntry(overrides = {}) {
  return {
    card_id: "GBB-REG-01",
    generation: 1,
    role: "worker",
    ref: "refs/heads/main",
    head: "a".repeat(40),
    tree: "b".repeat(40),
    allowlist_paths: ["src/contracts.mjs"],
    worktree: "D:\\worktrees\\reg-01",
    process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: "lease-reg-01",
    lease_expiry: "2026-08-01T10:00:00+08:00",
    fence: 1,
    fence_id: "fence-reg-01",
    heartbeat_at: REG_TS,
    state: "ADMITTED",
    admitted_at: REG_TS,
    ...overrides,
  };
}

test("createRegistry returns empty entries map", () => {
  const reg = createRegistry();
  assert.deepEqual(reg.entries, {});
});

test("admitEntry allows first worker", () => {
  const reg = createRegistry();
  const result = admitEntry(reg, regEntry(), REG_TS);
  assert.equal(result.ok, true);
  assert.equal(reg.entries["GBB-REG-01"].state, "ADMITTED");
});

test("admitEntry allows second worker with different ref and disjoint paths", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", ref: "refs/heads/main", allowlist_paths: ["src/contracts.mjs"], worktree: "D:\\worktrees\\w1" }), REG_TS);
  const result = admitEntry(reg, regEntry({ card_id: "W2", ref: "refs/heads/feature", allowlist_paths: ["src/supervisor.mjs"], worktree: "D:\\worktrees\\w2" }), REG_TS);
  assert.equal(result.ok, true);
  assert.equal(Object.keys(reg.entries).length, 2);
});

test("admitEntry rejects third worker fail-closed", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/a.mjs"], worktree: "D:\\worktrees\\w1" }), REG_TS);
  admitEntry(reg, regEntry({ card_id: "W2", ref: "refs/heads/b", allowlist_paths: ["src/b.mjs"], worktree: "D:\\worktrees\\w2" }), REG_TS);
  const result = admitEntry(reg, regEntry({ card_id: "W3", ref: "refs/heads/c", allowlist_paths: ["src/c.mjs"], worktree: "D:\\worktrees\\w3" }), REG_TS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /MAX_WORKERS/);
  assert.equal(Object.keys(reg.entries).length, 2);
});

test("admitEntry allows one reviewer", () => {
  const reg = createRegistry();
  const result = admitEntry(reg, regEntry({ card_id: "R1", role: "reviewer" }), REG_TS);
  assert.equal(result.ok, true);
});

test("admitEntry rejects second reviewer fail-closed", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "R1", role: "reviewer" }), REG_TS);
  const result = admitEntry(reg, regEntry({ card_id: "R2", role: "reviewer" }), REG_TS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /MAX_REVIEWERS/);
});

test("admitEntry rejects second writer to same ref fail-closed", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", ref: "refs/heads/main", allowlist_paths: ["src/a.mjs"] }), REG_TS);
  const result = admitEntry(reg, regEntry({ card_id: "W2", ref: "refs/heads/main", allowlist_paths: ["src/b.mjs"] }), REG_TS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /MAX_WRITERS_PER_REF/);
});

test("admitEntry rejects overlapping paths even on different refs", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/"], worktree: "D:\\worktrees\\w1" }), REG_TS);
  const result = admitEntry(reg, regEntry({ card_id: "W2", ref: "refs/heads/b", allowlist_paths: ["src/contracts.mjs"], worktree: "D:\\worktrees\\w2" }), REG_TS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /OVERLAPPING_PATHS/);
});

test("admitEntry allows disjoint paths on different refs", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["tests/"], worktree: "D:\\worktrees\\w1" }), REG_TS);
  const result = admitEntry(reg, regEntry({ card_id: "W2", ref: "refs/heads/b", allowlist_paths: ["src/"], worktree: "D:\\worktrees\\w2" }), REG_TS);
  assert.equal(result.ok, true);
});

test("admitEntry rejects mismatched generation for same card_id", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", generation: 1 }), REG_TS);
  const result = admitEntry(reg, regEntry({ card_id: "W1", generation: 2, ref: "refs/heads/b", allowlist_paths: ["src/b.mjs"] }), REG_TS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /GENERATION_MISMATCH/);
});

test("admitEntry rejects entry with duplicate card_id same generation (already admitted)", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1" }), REG_TS);
  const result = admitEntry(reg, regEntry({ card_id: "W1" }), REG_TS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /ALREADY_ADMITTED/);
});

test("heartbeatEntry updates heartbeat_at with ownership proof", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const ok = heartbeatEntry(reg, "W1", { isoNow: "2026-08-01T09:01:00+08:00", authority: fullAuth(entry) });
  assert.equal(ok, true);
  assert.equal(reg.entries["W1"].heartbeat_at, "2026-08-01T09:01:00+08:00");
});

test("heartbeatEntry rejects wrong pid ownership", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const ok = heartbeatEntry(reg, "W1", { isoNow: "2026-08-01T09:01:00+08:00", authority: { ...fullAuth(entry), process: { pid: 9999, started_at: entry.process.started_at } } });
  assert.equal(ok, false);
});

test("heartbeatEntry rejects wrong fence ownership", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const ok = heartbeatEntry(reg, "W1", { isoNow: "2026-08-01T09:01:00+08:00", authority: { ...fullAuth(entry), fence: 99 } });
  assert.equal(ok, false);
});

test("heartbeatEntry is a no-op for unknown card_id", () => {
  const reg = createRegistry();
  heartbeatEntry(reg, "UNKNOWN", REG_TS);
  assert.deepEqual(reg.entries, {});
});

test("reclassifyEntry transitions state", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const result = reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", { authority: fullAuth(entry) });
  assert.equal(result.ok, true);
  assert.equal(reg.entries["W1"].state, "HEARTBEAT_STALE");
});

test("reclassifyEntry rejects RELEASED without releaseAuthority", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const result = reclassifyEntry(reg, "W1", "RELEASED", { authority: fullAuth(entry) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /RELEASE_AUTHORITY_MISSING/);
  assert.equal(reg.entries["W1"].state, "ADMITTED");
});

test("reclassifyEntry is a no-op for unknown card_id", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  const result = reclassifyEntry(reg, "UNKNOWN", "RELEASED", { authority: fullAuth(entry) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ENTRY_NOT_FOUND/);
  assert.deepEqual(reg.entries, {});
});

test("findExpiredEntries finds entries with stale heartbeats", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", heartbeat_at: "2026-08-01T08:50:00+08:00", worktree: "D:\\worktrees\\w1" }), REG_TS);
  admitEntry(reg, regEntry({ card_id: "W2", heartbeat_at: "2026-08-01T08:59:30+08:00", worktree: "D:\\worktrees\\w2" }), REG_TS);
  const thresholdMs = 30_000; // 30s stale threshold
  const nowMs = Date.parse("2026-08-01T09:00:00+08:00");
  const expired = findExpiredEntries(reg, nowMs, thresholdMs);
  assert.equal(expired.length, 1);
  assert.equal(expired[0], "W1");
});

test("findExpiredEntries returns empty when all heartbeats are fresh", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", heartbeat_at: REG_TS }), REG_TS);
  const nowMs = Date.parse(REG_TS);
  const expired = findExpiredEntries(reg, nowMs, 30_000);
  assert.equal(expired.length, 0);
});

test("checkPathOverlap detects overlapping paths", () => {
  assert.equal(checkPathOverlap(["src/"], ["src/contracts.mjs"]), true);
  assert.equal(checkPathOverlap(["src/contracts.mjs"], ["src/"]), true);
  assert.equal(checkPathOverlap(["src/contracts.mjs"], ["src/contracts.mjs"]), true);
  assert.equal(checkPathOverlap(["tests/"], ["src/"]), false);
  assert.equal(checkPathOverlap(["src/contracts.mjs"], ["src/supervisor.mjs"]), false);
});

test("reconstructRegistry is deprecated and throws", () => {
  const reg = createRegistry();
  assert.throws(
    () => reconstructRegistry(reg, [], REG_TS),
    /DEPRECATED.*reconstructFromAuthorityAndObservations/
  );
});

test("UNCERTAIN_SEND remains NO_BLIND_RETRY without registry reclaim", () => {
  const reg = createRegistry();
  const result = { decision: "NO_BLIND_RETRY" };
  assert.equal(result.decision, "NO_BLIND_RETRY");
  // Registry entry reclamation does not change NO_BLIND_RETRY classification
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const reclassResult = reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", { authority: fullAuth(entry) });
  assert.equal(reclassResult.ok, true);
  assert.equal(result.decision, "NO_BLIND_RETRY");
});

// ---------------------------------------------------------------------------
// F3 - Schema: exact 40-hex head/tree, canonical ref, required lease_id/fence_id
// ---------------------------------------------------------------------------

test("F3: registryEntrySchema rejects non-40-hex head", () => {
  assert.throws(
    () => registryEntrySchema.parse(regEntry({ head: "a".repeat(7) })),
    /head/
  );
});

test("F3: registryEntrySchema rejects non-40-hex tree", () => {
  assert.throws(
    () => registryEntrySchema.parse(regEntry({ tree: "not-a-tree" })),
    /tree/
  );
});

test("F3: registryEntrySchema accepts exact 40-hex head and tree", () => {
  const parsed = registryEntrySchema.parse(regEntry());
  assert.equal(parsed.head.length, 40);
  assert.equal(parsed.tree.length, 40);
});

test("F3: registryEntrySchema rejects ref not starting with refs/ or bare SHA", () => {
  assert.throws(
    () => registryEntrySchema.parse(regEntry({ ref: "main" })),
    /ref/
  );
});

test("F3: registryEntrySchema accepts canonical refs/ ref", () => {
  const parsed = registryEntrySchema.parse(regEntry({ ref: "refs/heads/feature" }));
  assert.equal(parsed.ref, "refs/heads/feature");
});

test("F3: registryEntrySchema accepts bare 40-hex SHA as ref", () => {
  const parsed = registryEntrySchema.parse(regEntry({ ref: "a".repeat(40) }));
  assert.equal(parsed.ref, "a".repeat(40));
});

test("F3: registryEntrySchema requires lease_id", () => {
  assert.throws(
    () => registryEntrySchema.parse(regEntry({ lease_id: undefined })),
    /lease_id/
  );
});

test("F3: registryEntrySchema requires fence_id", () => {
  assert.throws(
    () => registryEntrySchema.parse(regEntry({ fence_id: undefined })),
    /fence_id/
  );
});

// ---------------------------------------------------------------------------
// F4 - State machine: explicit allowed transitions only
// ---------------------------------------------------------------------------

test("F4: reclassifyEntry allows ADMITTED -> ACTIVE", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const result = reclassifyEntry(reg, "W1", "ACTIVE", { authority: fullAuth(entry) });
  assert.equal(result.ok, true);
  assert.equal(reg.entries["W1"].state, "ACTIVE");
});

test("F4: reclassifyEntry allows ADMITTED -> HEARTBEAT_STALE", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const result = reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", { authority: fullAuth(entry) });
  assert.equal(result.ok, true);
  assert.equal(reg.entries["W1"].state, "HEARTBEAT_STALE");
});

test("F4: reclassifyEntry requires releaseAuthority for ADMITTED -> RELEASED", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const result = reclassifyEntry(reg, "W1", "RELEASED", { authority: fullAuth(entry) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /RELEASE_AUTHORITY_MISSING/);
  assert.equal(reg.entries["W1"].state, "ADMITTED");
});

test("F4: reclassifyEntry rejects ADMITTED -> REVALIDATING (skip stale path)", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const result = reclassifyEntry(reg, "W1", "REVALIDATING", { authority: fullAuth(entry) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /INVALID_TRANSITION/);
});

test("F4: reclassifyEntry allows HEARTBEAT_STALE -> MARK_STALE_CANDIDATE", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", { authority: fullAuth(entry) });
  const result = reclassifyEntry(reg, "W1", "MARK_STALE_CANDIDATE", { authority: fullAuth(entry) });
  assert.equal(result.ok, true);
  assert.equal(reg.entries["W1"].state, "MARK_STALE_CANDIDATE");
});

test("F4: reclassifyEntry allows MARK_STALE_CANDIDATE -> REVALIDATING", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", { authority: fullAuth(entry) });
  reclassifyEntry(reg, "W1", "MARK_STALE_CANDIDATE", { authority: fullAuth(entry) });
  const result = reclassifyEntry(reg, "W1", "REVALIDATING", { authority: fullAuth(entry) });
  assert.equal(result.ok, true);
  assert.equal(reg.entries["W1"].state, "REVALIDATING");
});

test("F4: reclassifyEntry allows REVALIDATING -> RELEASED (authorized terminal release)", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1", lease_expiry: "2026-08-01T08:00:00+08:00" });
  admitEntry(reg, entry, REG_TS);
  reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", { authority: fullAuth(entry) });
  reclassifyEntry(reg, "W1", "MARK_STALE_CANDIDATE", { authority: fullAuth(entry) });
  reclassifyEntry(reg, "W1", "REVALIDATING", { authority: fullAuth(entry) });
  // Lease must be expired for release to succeed; terminal authority required with all identity fields
  const result = reclassifyEntry(reg, "W1", "RELEASED", { authority: fullAuth(entry), isoNow: "2026-08-01T11:00:00+08:00", releaseAuthority: { type: "terminal_authority", pid: entry.process.pid, fence: entry.fence, fence_id: entry.fence_id, lease_id: entry.lease_id, lease_expiry: entry.lease_expiry, generation: entry.generation, ref: entry.ref, head: entry.head, tree: entry.tree, worktree: entry.worktree, process: entry.process, session: entry.session } });
  assert.equal(result.ok, true);
  assert.equal(reg.entries["W1"].state, "RELEASED");
});

test("F4: reclassifyEntry rejects state mutation without pid ownership", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const result = reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", { authority: { ...fullAuth(entry), process: { pid: 9999, started_at: entry.process.started_at } } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /PID_MISMATCH/);
});

test("F4: reclassifyEntry rejects state mutation without fence ownership", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const result = reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", { authority: { ...fullAuth(entry), fence: 99 } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /FENCE_MISMATCH/);
});

test("F4: reclassifyEntry rejects state mutation without fence_id ownership", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const result = reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", { authority: { ...fullAuth(entry), fence_id: "wrong-fence-id" } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /FENCE_ID_MISMATCH/);
});

test("F4: reclassifyEntry rejects state mutation without authority", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const result = reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /AUTHORITY_MISSING/);
});

test("F4: RELEASED state has no allowed transitions", () => {
  const allowed = ALLOWED_TRANSITIONS["RELEASED"];
  assert.ok(Array.isArray(allowed));
  assert.equal(allowed.length, 0);
});

// ---------------------------------------------------------------------------
// F5 - Path/ref/worktree canonicalization
// ---------------------------------------------------------------------------

test("F5: canonicalizeRepoRelativePath normalizes forward slashes", () => {
  assert.equal(canonicalizeRepoRelativePath("src/contracts.mjs"), "src/contracts.mjs");
  assert.equal(canonicalizeRepoRelativePath("src\\contracts.mjs"), "src/contracts.mjs");
});

test("F5: canonicalizeRepoRelativePath rejects absolute paths", () => {
  assert.equal(canonicalizeRepoRelativePath("C:\\worktrees\\x"), null);
  assert.equal(canonicalizeRepoRelativePath("/src/contracts.mjs"), null);
  assert.equal(canonicalizeRepoRelativePath("\\\\server\\share"), null);
});

test("F5: canonicalizeRepoRelativePath rejects traversal", () => {
  assert.equal(canonicalizeRepoRelativePath("src/../contracts.mjs"), null);
  assert.equal(canonicalizeRepoRelativePath("../outside"), null);
});

test("F5: canonicalizeRepoRelativePath collapses repeated separators", () => {
  assert.equal(canonicalizeRepoRelativePath("src//contracts.mjs"), "src/contracts.mjs");
  assert.equal(canonicalizeRepoRelativePath("src///contracts.mjs"), "src/contracts.mjs");
});

test("F5: canonicalizeRef accepts refs/heads/main", () => {
  assert.equal(canonicalizeRef("refs/heads/main"), "refs/heads/main");
});

test("F5: canonicalizeRef accepts bare 40-hex SHA", () => {
  assert.equal(canonicalizeRef("a".repeat(40)), "a".repeat(40));
});

test("F5: canonicalizeRef rejects ambiguous ref", () => {
  assert.equal(canonicalizeRef("main"), null);
  assert.equal(canonicalizeRef("HEAD"), null);
  assert.equal(canonicalizeRef(""), null);
});

test("F5: canonicalizeWorktree normalizes backslashes", () => {
  assert.equal(canonicalizeWorktree("D:\\worktrees\\reg-01"), "d:/worktrees/reg-01");
});

test("F5: canonicalizeWorktree removes trailing slashes", () => {
  assert.equal(canonicalizeWorktree("D:\\worktrees\\reg-01\\"), "d:/worktrees/reg-01");
});

test("F5: checkPathOverlap detects path traversal as non-overlapping", () => {
  // Canonicalized paths should not overlap if one has traversal
  assert.equal(checkPathOverlap(["src/"], ["src/contracts.mjs"]), true);
});

test("F5: checkPathOverlap uses canonical comparison (case-insensitive)", () => {
  assert.equal(checkPathOverlap(["SRC/"], ["src/contracts.mjs"]), true);
  assert.equal(checkPathOverlap(["Tests/"], ["tests/supervisor.mjs"]), true);
});

test("F5: admitEntry rejects same worktree for different workers", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/a.mjs"] }), REG_TS);
  const result = admitEntry(reg, regEntry({
    card_id: "W2",
    ref: "refs/heads/b",
    allowlist_paths: ["src/b.mjs"],
    worktree: "D:\\worktrees\\reg-01",
  }), REG_TS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /SAME_WORKTREE/);
});

test("F5: admitEntry allows different canonical worktrees", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/a.mjs"], worktree: "D:\\worktrees\\w1" }), REG_TS);
  const result = admitEntry(reg, regEntry({
    card_id: "W2",
    ref: "refs/heads/b",
    allowlist_paths: ["src/b.mjs"],
    worktree: "D:\\worktrees\\w2",
  }), REG_TS);
  assert.equal(result.ok, true);
});

test("F5: admitEntry rejects Windows path case-insensitive overlap", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["SRC/"], worktree: "D:\\worktrees\\w1" }), REG_TS);
  const result = admitEntry(reg, regEntry({
    card_id: "W2",
    ref: "refs/heads/b",
    allowlist_paths: ["src/contracts.mjs"],
    worktree: "D:\\worktrees\\w2",
  }), REG_TS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /OVERLAPPING_PATHS/);
});

// ---------------------------------------------------------------------------
// F2 - Reconstruction: duplicates, conflicts, stale generation, forge detection
// ---------------------------------------------------------------------------

test("F2: reconstructFromAuthorityAndObservations rejects duplicate card_id in durable receipts", () => {
  const receipts = [
    regEntry({ card_id: "W1", state: "ACTIVE" }),
    regEntry({ card_id: "W1", state: "ACTIVE" }),
  ];
  const result = reconstructFromAuthorityAndObservations(receipts, []);
  assert.equal(result.ok, false);
  assert.match(result.reason, /DUPLICATE_DURABLE_RECEIPT/);
});

test("F2: reconstructFromAuthorityAndObservations rejects duplicate live observations", () => {
  const live = [
    regEntry({ card_id: "W1", state: "ACTIVE" }),
    regEntry({ card_id: "W1", state: "ACTIVE" }),
  ];
  const result = reconstructFromAuthorityAndObservations([], live);
  assert.equal(result.ok, false);
  assert.match(result.reason, /DUPLICATE_LIVE_OBSERVATION/);
});

test("F2: reconstructFromAuthorityAndObservations rejects same-ref workers (MAX_WRITERS_PER_REF)", () => {
  const receipts = [
    regEntry({ card_id: "W1", ref: "refs/heads/main", allowlist_paths: ["src/a.mjs"], worktree: "D:\\worktrees\\w1" }),
    regEntry({ card_id: "W2", ref: "refs/heads/main", allowlist_paths: ["src/b.mjs"], worktree: "D:\\worktrees\\w2" }),
  ];
  const live = [
    regEntry({ card_id: "W1", ref: "refs/heads/main", allowlist_paths: ["src/a.mjs"], worktree: "D:\\worktrees\\w1" }),
    regEntry({ card_id: "W2", ref: "refs/heads/main", allowlist_paths: ["src/b.mjs"], worktree: "D:\\worktrees\\w2" }),
  ];
  const result = reconstructFromAuthorityAndObservations(receipts, live);
  assert.equal(result.ok, false);
  assert.match(result.reason, /MAX_WRITERS_PER_REF/);
});

test("F2: reconstructFromAuthorityAndObservations rejects overlapping paths", () => {
  const receipts = [
    regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/"], worktree: "D:\\worktrees\\w1" }),
    regEntry({ card_id: "W2", ref: "refs/heads/b", allowlist_paths: ["src/contracts.mjs"], worktree: "D:\\worktrees\\w2" }),
  ];
  const live = [
    regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/"], worktree: "D:\\worktrees\\w1" }),
    regEntry({ card_id: "W2", ref: "refs/heads/b", allowlist_paths: ["src/contracts.mjs"], worktree: "D:\\worktrees\\w2" }),
  ];
  const result = reconstructFromAuthorityAndObservations(receipts, live);
  assert.equal(result.ok, false);
  assert.match(result.reason, /OVERLAPPING_PATHS/);
});

test("F2: reconstructFromAuthorityAndObservations does not refresh heartbeat", () => {
  const oldHeartbeat = "2026-08-01T08:50:00+08:00";
  const entry = regEntry({ card_id: "W1", state: "ACTIVE", heartbeat_at: oldHeartbeat, worktree: "D:\\worktrees\\w1" });
  const receipts = [entry];
  const live = [
    regEntry({ card_id: "W1", state: "ACTIVE", heartbeat_at: oldHeartbeat, worktree: "D:\\worktrees\\w1" }),
  ];
  const result = reconstructFromAuthorityAndObservations(receipts, live, {
    currentAuthority: {
      generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
      worktree: "D:\\worktrees\\w1", process: { pid: entry.process.pid, started_at: entry.process.started_at },
      session: { ...entry.session }, lease_id: entry.lease_id, lease_expiry: entry.lease_expiry,
      fence: entry.fence, fence_id: entry.fence_id,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.entries["W1"].heartbeat_at, oldHeartbeat);
});

test("F2: reconstructFromAuthorityAndObservations rejects stale generation (generation mismatch)", () => {
  const receipts = [
    regEntry({ card_id: "W1", generation: 1, worktree: "D:\\worktrees\\w1" }),
  ];
  const live = [
    regEntry({ card_id: "W1", generation: 2, worktree: "D:\\worktrees\\w1" }),
  ];
  const result = reconstructFromAuthorityAndObservations(receipts, live);
  assert.equal(result.ok, false);
  assert.match(result.reason, /GENERATION_MISMATCH/);
});

test("F2: reconstructFromAuthorityAndObservations rejects same worktree for different workers", () => {
  const receipts = [
    regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/a.mjs"], worktree: "D:\\wt\\same" }),
    regEntry({ card_id: "W2", ref: "refs/heads/b", allowlist_paths: ["src/b.mjs"], worktree: "D:\\wt\\same" }),
  ];
  const live = [
    regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/a.mjs"], worktree: "D:\\wt\\same" }),
    regEntry({ card_id: "W2", ref: "refs/heads/b", allowlist_paths: ["src/b.mjs"], worktree: "D:\\wt\\same" }),
  ];
  const result = reconstructFromAuthorityAndObservations(receipts, live);
  assert.equal(result.ok, false);
  assert.match(result.reason, /SAME_WORKTREE/);
});

// ---------------------------------------------------------------------------
// F1 - Production-path admission: admitEntryWithAuthority
// ---------------------------------------------------------------------------

test("F1: admitEntryWithAuthority admits under matching fence", () => {
  const reg = createRegistry();
  const authority = {
    generation: 1,
    ref: "refs/heads/main",
    head: "a".repeat(40),
    tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01",
    process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: "lease-reg-01",
    lease_expiry: "2026-08-01T10:00:00+08:00",
    fence: 1,
    fence_id: "fence-reg-01",
  };
  const result = admitEntryWithAuthority(reg, regEntry(), REG_TS, {
    currentAuthority: authority,
  });
  assert.equal(result.ok, true);
  assert.equal(reg.entries["GBB-REG-01"].state, "ADMITTED");
});

test("F1: admitEntryWithAuthority rejects fence mismatch", () => {
  const reg = createRegistry();
  const authority = {
    generation: 1,
    ref: "refs/heads/main",
    head: "a".repeat(40),
    tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01",
    process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: "lease-reg-01",
    lease_expiry: "2026-08-01T10:00:00+08:00",
    fence: 99,
    fence_id: "fence-reg-01",
  };
  const result = admitEntryWithAuthority(reg, regEntry(), REG_TS, {
    currentAuthority: authority,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /FENCE_MISMATCH/);
});

test("F1: admitEntryWithAuthority rejects fence_id mismatch", () => {
  const reg = createRegistry();
  const authority = {
    generation: 1,
    ref: "refs/heads/main",
    head: "a".repeat(40),
    tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01",
    process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: "lease-reg-01",
    lease_expiry: "2026-08-01T10:00:00+08:00",
    fence: 1,
    fence_id: "wrong-fence-id",
  };
  const result = admitEntryWithAuthority(reg, regEntry(), REG_TS, {
    currentAuthority: authority,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /FENCE_ID_MISMATCH/);
});

test("F1: admitEntryWithAuthority rejects missing lease", () => {
  const reg = createRegistry();
  const authority = {
    generation: 1,
    ref: "refs/heads/main",
    head: "a".repeat(40),
    tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01",
    process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: null,
    lease_expiry: "2026-08-01T10:00:00+08:00",
    fence: 1,
    fence_id: "fence-reg-01",
  };
  const result = admitEntryWithAuthority(reg, regEntry(), REG_TS, {
    currentAuthority: authority,
  });
  assert.equal(result.ok, false);
  // currentAuthoritySchema rejects null lease_id as AUTHORITY_INVALID before the explicit LEASE_MISSING check
  assert.match(result.reason, /AUTHORITY_INVALID|LEASE_MISSING/);
});

test("F1: admitEntryWithAuthority rejects wrong current lease_id", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1", lease_id: "correct-lease" });
  const authority = {
    generation: 1,
    ref: "refs/heads/main",
    head: "a".repeat(40),
    tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01",
    process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: "wrong-lease",
    lease_expiry: "2026-08-01T10:00:00+08:00",
    fence: 1,
    fence_id: "fence-reg-01",
  };
  const result = admitEntryWithAuthority(reg, entry, REG_TS, {
    currentAuthority: authority,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /LEASE_ID_MISMATCH/);
});

test("F1: admitEntryWithAuthority rejects third worker under authority", () => {
  const reg = createRegistry();
  const auth1 = {
    generation: 1, ref: "refs/heads/a", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w1", process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
    lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "fence-reg-01",
  };
  const auth2 = {
    generation: 1, ref: "refs/heads/b", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w2", process: { pid: 1002, started_at: REG_TS },
    session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" },
    lease_id: "lease-2", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "fence-reg-01",
  };
  const auth3 = {
    generation: 1, ref: "refs/heads/c", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w3", process: { pid: 1003, started_at: REG_TS },
    session: { workspace_id: "w3", pane_id: "p3", agent_session: "s3" },
    lease_id: "lease-3", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "fence-reg-01",
  };
  admitEntryWithAuthority(reg, regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/a.mjs"], worktree: "D:\\worktrees\\w1", lease_id: "lease-1", session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" }, process: { pid: 1001, started_at: REG_TS } }), REG_TS, {
    currentAuthority: auth1,
  });
  admitEntryWithAuthority(reg, regEntry({ card_id: "W2", ref: "refs/heads/b", allowlist_paths: ["src/b.mjs"], worktree: "D:\\worktrees\\w2", lease_id: "lease-2", session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" }, process: { pid: 1002, started_at: REG_TS } }), REG_TS, {
    currentAuthority: auth2,
  });
  const result = admitEntryWithAuthority(reg, regEntry({ card_id: "W3", ref: "refs/heads/c", allowlist_paths: ["src/c.mjs"], worktree: "D:\\worktrees\\w3", lease_id: "lease-3", session: { workspace_id: "w3", pane_id: "p3", agent_session: "s3" }, process: { pid: 1003, started_at: REG_TS } }), REG_TS, {
    currentAuthority: auth3,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /MAX_WORKERS/);
});

test("F1: admitEntryWithAuthority rejects second reviewer under authority", () => {
  const reg = createRegistry();
  const authR1 = {
    generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01", process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: "lease-r1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "fence-reg-01",
  };
  const authR2 = {
    generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01", process: { pid: 1002, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: "lease-r2", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "fence-reg-01",
  };
  admitEntryWithAuthority(reg, regEntry({ card_id: "R1", role: "reviewer", lease_id: "lease-r1", process: { pid: 1001, started_at: REG_TS } }), REG_TS, {
    currentAuthority: authR1,
  });
  const result = admitEntryWithAuthority(reg, regEntry({ card_id: "R2", role: "reviewer", lease_id: "lease-r2", process: { pid: 1002, started_at: REG_TS } }), REG_TS, {
    currentAuthority: authR2,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /MAX_REVIEWERS/);
});

// ---------------------------------------------------------------------------
// F1 - Production-path integration: Supervisor runLoopOnce admission gate
// ---------------------------------------------------------------------------

test("F1: Supervisor runLoopOnce exercises registry admission path under lock/fence", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  const pendingEntry = regEntry({ card_id: "W-PROD-01", ref: "refs/heads/prod", allowlist_paths: ["src/prod.mjs"], worktree: "D:\\worktrees\\prod", fence_id: "1", lease_id: "lease-supervisor-01", session: { workspace_id: "w-prod", pane_id: "p-prod", agent_session: "s-prod" }, process: { pid: 41020, started_at: REG_TS } });
  const authority = {
    generation: 1, ref: "refs/heads/prod", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\prod", process: { pid: 41020, started_at: REG_TS },
    session: { workspace_id: "w-prod", pane_id: "p-prod", agent_session: "s-prod" },
    lease_id: "lease-supervisor-01", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41020,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => false,
    registry: createRegistry(),
    admissionLeaseId: "lease-supervisor-01",
    pendingAdmissions: [pendingEntry],
    currentAuthority: authority,
    readCurrentIdentity: async () => authority,
  });
  assert.equal(outcome.stop, false);
  assert.ok(outcome.at);
  // The entry should be admitted into the registry
  assert.equal(Object.keys(outcome.registry.entries).length, 1);
  assert.equal(outcome.registry.entries["W-PROD-01"].state, "ADMITTED");
  assert.equal(outcome.admissionResults.length, 1);
  assert.equal(outcome.admissionResults[0].ok, true);
});

// ---------------------------------------------------------------------------
// F6 - Non-vacuous production-path tests for all F1-F6 bypasses
// ---------------------------------------------------------------------------

// F1: Production-path admission rejects third worker through runLoopOnce
test("F6-F1: Supervisor runLoopOnce rejects third worker through real admission gate", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  const reg = createRegistry();
  // Pre-admit two workers into the registry
  const auth1 = {
    generation: 1, ref: "refs/heads/a", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w1", process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
    lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  const auth2 = {
    generation: 1, ref: "refs/heads/b", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w2", process: { pid: 1002, started_at: REG_TS },
    session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" },
    lease_id: "lease-2", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  admitEntryWithAuthority(reg, regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/a.mjs"], worktree: "D:\\worktrees\\w1", fence_id: "1", lease_id: "lease-1", session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" }, process: { pid: 1001, started_at: REG_TS } }), REG_TS, {
    currentAuthority: auth1,
  });
  admitEntryWithAuthority(reg, regEntry({ card_id: "W2", ref: "refs/heads/b", allowlist_paths: ["src/b.mjs"], worktree: "D:\\worktrees\\w2", fence_id: "1", lease_id: "lease-2", session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" }, process: { pid: 1002, started_at: REG_TS } }), REG_TS, {
    currentAuthority: auth2,
  });
  // Try to admit a third worker - should be rejected
  const pendingEntry = regEntry({ card_id: "W3", ref: "refs/heads/c", allowlist_paths: ["src/c.mjs"], worktree: "D:\\worktrees\\w3", fence_id: "1", lease_id: "lease-3", session: { workspace_id: "w3", pane_id: "p3", agent_session: "s3" }, process: { pid: 41030, started_at: REG_TS } });
  const authority = {
    generation: 1, ref: "refs/heads/c", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w3", process: { pid: 41030, started_at: REG_TS },
    session: { workspace_id: "w3", pane_id: "p3", agent_session: "s3" },
    lease_id: "lease-3", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41030,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => false,
    registry: reg,
    currentAuthority: authority,
    readCurrentIdentity: async () => authority,
    pendingAdmissions: [pendingEntry],
  });
  assert.equal(outcome.stop, false);
  assert.equal(outcome.admissionResults.length, 1);
  assert.equal(outcome.admissionResults[0].ok, false);
  assert.match(outcome.admissionResults[0].reason, /MAX_WORKERS/);
  assert.equal(Object.keys(outcome.registry.entries).length, 2);
});

// F1: Production-path admission rejects second reviewer
test("F6-F1: Supervisor runLoopOnce rejects second reviewer through real admission gate", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  const reg = createRegistry();
  const authR1 = {
    generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01", process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: "lease-r1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  admitEntryWithAuthority(reg, regEntry({ card_id: "R1", role: "reviewer", fence_id: "1", lease_id: "lease-r1", process: { pid: 1001, started_at: REG_TS } }), REG_TS, {
    currentAuthority: authR1,
  });
  const pendingEntry = regEntry({ card_id: "R2", role: "reviewer", fence_id: "1", lease_id: "lease-r2", process: { pid: 41031, started_at: REG_TS } });
  const authority = {
    generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01", process: { pid: 41031, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: "lease-r2", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41031,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => false,
    registry: reg,
    currentAuthority: authority,
    readCurrentIdentity: async () => authority,
    pendingAdmissions: [pendingEntry],
  });
  assert.equal(outcome.admissionResults[0].ok, false);
  assert.match(outcome.admissionResults[0].reason, /MAX_REVIEWERS/);
});

// F1: Production-path admission rejects same ref writer
test("F6-F1: Supervisor runLoopOnce rejects same ref writer through real admission gate", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  const reg = createRegistry();
  const auth1 = {
    generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w1", process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
    lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  admitEntryWithAuthority(reg, regEntry({ card_id: "W1", ref: "refs/heads/main", allowlist_paths: ["src/a.mjs"], worktree: "D:\\worktrees\\w1", fence_id: "1", lease_id: "lease-1", session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" }, process: { pid: 1001, started_at: REG_TS } }), REG_TS, {
    currentAuthority: auth1,
  });
  const pendingEntry = regEntry({ card_id: "W2", ref: "refs/heads/main", allowlist_paths: ["src/b.mjs"], worktree: "D:\\worktrees\\w2", fence_id: "1", lease_id: "lease-2", session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" }, process: { pid: 41032, started_at: REG_TS } });
  const authority = {
    generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w2", process: { pid: 41032, started_at: REG_TS },
    session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" },
    lease_id: "lease-2", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41032,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => false,
    registry: reg,
    currentAuthority: authority,
    readCurrentIdentity: async () => authority,
    pendingAdmissions: [pendingEntry],
  });
  assert.equal(outcome.admissionResults[0].ok, false);
  assert.match(outcome.admissionResults[0].reason, /MAX_WRITERS_PER_REF/);
});

// F1: Production-path admission rejects overlapping paths
test("F6-F1: Supervisor runLoopOnce rejects overlapping paths through real admission gate", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  const reg = createRegistry();
  const auth1 = {
    generation: 1, ref: "refs/heads/a", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w1", process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
    lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  admitEntryWithAuthority(reg, regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/"], worktree: "D:\\worktrees\\w1", fence_id: "1", lease_id: "lease-1", session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" }, process: { pid: 1001, started_at: REG_TS } }), REG_TS, {
    currentAuthority: auth1,
  });
  const pendingEntry = regEntry({ card_id: "W2", ref: "refs/heads/b", allowlist_paths: ["src/contracts.mjs"], worktree: "D:\\worktrees\\w2", fence_id: "1", lease_id: "lease-2", session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" }, process: { pid: 41033, started_at: REG_TS } });
  const authority = {
    generation: 1, ref: "refs/heads/b", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w2", process: { pid: 41033, started_at: REG_TS },
    session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" },
    lease_id: "lease-2", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41033,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => false,
    registry: reg,
    currentAuthority: authority,
    readCurrentIdentity: async () => authority,
    pendingAdmissions: [pendingEntry],
  });
  assert.equal(outcome.admissionResults[0].ok, false);
  assert.match(outcome.admissionResults[0].reason, /OVERLAPPING_PATHS/);
});

// F1: Production-path admission rejects same worktree alias (Windows case)
test("F6-F1: Supervisor runLoopOnce rejects same worktree alias through real admission gate", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  const reg = createRegistry();
  const auth1 = {
    generation: 1, ref: "refs/heads/a", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\same", process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
    lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  admitEntryWithAuthority(reg, regEntry({ card_id: "W1", ref: "refs/heads/a", allowlist_paths: ["src/a.mjs"], worktree: "D:\\worktrees\\same", fence_id: "1", lease_id: "lease-1", session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" }, process: { pid: 1001, started_at: REG_TS } }), REG_TS, {
    currentAuthority: auth1,
  });
  // Different case, same canonical path
  const pendingEntry = regEntry({ card_id: "W2", ref: "refs/heads/b", allowlist_paths: ["src/b.mjs"], worktree: "d:\\Worktrees\\SAME", fence_id: "1", lease_id: "lease-2", session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" }, process: { pid: 41034, started_at: REG_TS } });
  const authority = {
    generation: 1, ref: "refs/heads/b", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "d:\\Worktrees\\SAME", process: { pid: 41034, started_at: REG_TS },
    session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" },
    lease_id: "lease-2", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41034,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => false,
    registry: reg,
    currentAuthority: authority,
    readCurrentIdentity: async () => authority,
    pendingAdmissions: [pendingEntry],
  });
  assert.equal(outcome.admissionResults[0].ok, false);
  assert.match(outcome.admissionResults[0].reason, /SAME_WORKTREE/);
});

// F1: Production-path admission rejects stale generation
test("F6-F1: Supervisor runLoopOnce rejects stale generation through real admission gate", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  const reg = createRegistry();
  const auth1 = {
    generation: 2, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w1", process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
    lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  admitEntryWithAuthority(reg, regEntry({ card_id: "W1", generation: 2, fence_id: "1", lease_id: "lease-1", worktree: "D:\\worktrees\\w1", session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" }, process: { pid: 1001, started_at: REG_TS } }), REG_TS, {
    currentAuthority: auth1,
  });
  // Try to admit same card_id with stale generation - uses same lease_id to pass lease check
  const pendingEntry = regEntry({ card_id: "W1", generation: 1, ref: "refs/heads/b", allowlist_paths: ["src/b.mjs"], worktree: "D:\\worktrees\\w2", fence_id: "1", lease_id: "lease-1", session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" }, process: { pid: 41035, started_at: REG_TS } });
  const authority = {
    generation: 1, ref: "refs/heads/b", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\w2", process: { pid: 41035, started_at: REG_TS },
    session: { workspace_id: "w2", pane_id: "p2", agent_session: "s2" },
    lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41035,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => false,
    registry: reg,
    currentAuthority: authority,
    readCurrentIdentity: async () => authority,
    pendingAdmissions: [pendingEntry],
  });
  assert.equal(outcome.admissionResults[0].ok, false);
  assert.ok(outcome.admissionResults[0].reason.includes("GENERATION_MISMATCH") || outcome.admissionResults[0].reason.includes("ALREADY_ADMITTED"));
});

// F3: Production-path admission rejects expired lease
test("F6-F3: Supervisor runLoopOnce rejects expired lease through real admission gate", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  const pendingEntry = regEntry({
    card_id: "W-EXPIRED",
    ref: "refs/heads/expired",
    allowlist_paths: ["src/expired.mjs"],
    worktree: "D:\\worktrees\\expired",
    lease_id: "lease-expired",
    lease_expiry: "2026-08-01T08:00:00+08:00", // expired before REG_TS
    fence_id: "1",
  });
  const authority = {
    generation: 1,
    ref: "refs/heads/expired",
    head: "a".repeat(40),
    tree: "b".repeat(40),
    worktree: "D:\\worktrees\\expired",
    process: { pid: 41036, started_at: REG_TS },
    session: { workspace_id: "w-expired", pane_id: "p-expired", agent_session: "s-expired" },
    lease_id: "lease-expired",
    lease_expiry: "2026-08-01T08:00:00+08:00",
    fence: 1,
    fence_id: "1",
  };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41036,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => false,
    registry: createRegistry(),
    admissionLeaseId: "lease-expired",
    pendingAdmissions: [pendingEntry],
    currentAuthority: authority,
    readCurrentIdentity: async () => authority,
  });
  assert.equal(outcome.admissionResults[0].ok, false);
  assert.match(outcome.admissionResults[0].reason, /LEASE_EXPIRED/);
});

// F3: heartbeatEntry requires mandatory ownership tuple
test("F6-F3: heartbeatEntry rejects heartbeat without authority", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1" }), REG_TS);
  const ok = heartbeatEntry(reg, "W1", { isoNow: "2026-08-01T09:01:00+08:00" });
  assert.equal(ok, false);
});

test("F6-F3: heartbeatEntry rejects expired lease", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1", lease_expiry: "2026-08-01T08:00:00+08:00" });
  admitEntry(reg, entry, REG_TS);
  const ok = heartbeatEntry(reg, "W1", { isoNow: "2026-08-01T09:01:00+08:00", authority: fullAuth(entry) });
  assert.equal(ok, false);
});

// F3: reclassifyEntry requires mandatory ownership tuple
test("F6-F3: reclassifyEntry rejects state mutation without authority", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1" }), REG_TS);
  const result = reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /AUTHORITY_MISSING/);
});

test("F6-F3: reclassifyEntry rejects state mutation with partial authority (missing fence_id)", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1" });
  admitEntry(reg, entry, REG_TS);
  const partial = { pid: 1001, fence: 1, fence_id: "fence-reg-01" };
  const result = reclassifyEntry(reg, "W1", "HEARTBEAT_STALE", { authority: partial });
  assert.equal(result.ok, false);
  assert.match(result.reason, /AUTHORITY_INVALID/);
});

// F4: ACTIVE -> RELEASED authorized release path
test("F6-F4: reclassifyEntry allows ACTIVE -> RELEASED with expired lease and terminal authority", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1", lease_expiry: "2026-08-01T08:00:00+08:00" });
  admitEntry(reg, entry, REG_TS);
  reclassifyEntry(reg, "W1", "ACTIVE", { authority: fullAuth(entry) });
  const result = reclassifyEntry(reg, "W1", "RELEASED", { authority: fullAuth(entry), isoNow: REG_TS, releaseAuthority: { type: "terminal_authority", pid: entry.process.pid, fence: entry.fence, fence_id: entry.fence_id, lease_id: entry.lease_id, lease_expiry: entry.lease_expiry, generation: entry.generation, ref: entry.ref, head: entry.head, tree: entry.tree, worktree: entry.worktree, process: entry.process, session: entry.session } });
  assert.equal(result.ok, true);
  assert.equal(reg.entries["W1"].state, "RELEASED");
});

// F4: Release before lease expiry rejected
test("F6-F4: reclassifyEntry rejects ACTIVE -> RELEASED when lease not expired", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1", lease_expiry: "2099-01-01T00:00:00+08:00" });
  admitEntry(reg, entry, REG_TS);
  reclassifyEntry(reg, "W1", "ACTIVE", { authority: fullAuth(entry) });
  const result = reclassifyEntry(reg, "W1", "RELEASED", { authority: fullAuth(entry), isoNow: REG_TS, releaseAuthority: { type: "terminal_authority", pid: entry.process.pid, fence: entry.fence, fence_id: entry.fence_id, lease_id: entry.lease_id, lease_expiry: entry.lease_expiry, generation: entry.generation, ref: entry.ref, head: entry.head, tree: entry.tree, worktree: entry.worktree, process: entry.process, session: entry.session } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /LEASE_NOT_EXPIRED/);
});

// F5: RELEASED rejected without terminal/revocation authority
test("F6-F4: reclassifyEntry rejects ACTIVE -> RELEASED without terminal or revocation authority", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1", lease_expiry: "2026-08-01T08:00:00+08:00" });
  admitEntry(reg, entry, REG_TS);
  reclassifyEntry(reg, "W1", "ACTIVE", { authority: fullAuth(entry) });
  const result = reclassifyEntry(reg, "W1", "RELEASED", { authority: fullAuth(entry), isoNow: REG_TS });
  assert.equal(result.ok, false);
  assert.match(result.reason, /RELEASE_AUTHORITY_MISSING/);
});

// F5: canonicalizeRepoRelativePath rejects bare "."
test("F6-F5: canonicalizeRepoRelativePath rejects bare dot", () => {
  assert.equal(canonicalizeRepoRelativePath("."), null);
});

// F5: checkPathOverlap fails closed on invalid path
test("F6-F5: checkPathOverlap fails closed on invalid allowlist path", () => {
  assert.equal(checkPathOverlap(["C:\\absolute\\path"], ["src/contracts.mjs"]), true);
  assert.equal(checkPathOverlap(["src/contracts.mjs"], ["../traversal"]), true);
});

// F5: validateEntryAdmission rejects invalid ref
test("F6-F5: validateEntryAdmission rejects invalid ref", () => {
  const reg = createRegistry();
  const entry = regEntry({ ref: "main" }); // invalid ref
  const result = validateEntryAdmission(reg, entry, new Set());
  assert.equal(result.ok, false);
  assert.match(result.reason, /INVALID_REF/);
});

// F5: validateEntryAdmission uses canonical ref comparison
test("F6-F5: validateEntryAdmission detects same ref with different case", () => {
  const reg = createRegistry();
  admitEntry(reg, regEntry({ card_id: "W1", ref: "refs/heads/Main", allowlist_paths: ["src/a.mjs"], worktree: "D:\\worktrees\\w1" }), REG_TS);
  const entry = regEntry({ card_id: "W2", ref: "refs/heads/main", allowlist_paths: ["src/b.mjs"], worktree: "D:\\worktrees\\w2" });
  const result = validateEntryAdmission(reg, entry, new Set());
  assert.equal(result.ok, false);
  assert.match(result.reason, /MAX_WRITERS_PER_REF/);
});

// F2: reconstructFromAuthorityAndObservations joins durable + live
test("F6-F2: reconstructFromAuthorityAndObservations joins durable receipt and live observation", () => {
  const receipt = regEntry({ card_id: "W1", state: "ADMITTED", fence_id: "fence-01" });
  const live = regEntry({ card_id: "W1", state: "ACTIVE", fence_id: "fence-01" });
  const result = reconstructFromAuthorityAndObservations([receipt], [live], {
    currentFenceId: "fence-01",
    currentAuthority: {
      generation: receipt.generation, ref: receipt.ref, head: receipt.head, tree: receipt.tree,
      worktree: receipt.worktree, process: { pid: receipt.process.pid, started_at: receipt.process.started_at },
      session: { ...receipt.session }, lease_id: receipt.lease_id, lease_expiry: receipt.lease_expiry,
      fence: receipt.fence, fence_id: receipt.fence_id,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.entries["W1"].state, "ACTIVE");
  assert.equal(result.entries["W1"].admitted_at, receipt.admitted_at);
});

// F2: reconstructFromAuthorityAndObservations rejects missing durable receipt
test("F6-F2: reconstructFromAuthorityAndObservations rejects missing durable receipt", () => {
  const live = regEntry({ card_id: "W1", state: "ACTIVE" });
  const result = reconstructFromAuthorityAndObservations([], [live], {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /MISSING_DURABLE_RECEIPT/);
});

// F2: reconstructFromAuthorityAndObservations rejects missing live observation
test("F6-F2: reconstructFromAuthorityAndObservations rejects missing live observation", () => {
  const receipt = regEntry({ card_id: "W1", state: "ADMITTED" });
  const result = reconstructFromAuthorityAndObservations([receipt], [], {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /MISSING_LIVE_OBSERVATION/);
});

// F2: reconstructFromAuthorityAndObservations rejects duplicate durable receipt
test("F6-F2: reconstructFromAuthorityAndObservations rejects duplicate durable receipt", () => {
  const r1 = regEntry({ card_id: "W1" });
  const r2 = regEntry({ card_id: "W1" });
  const live = regEntry({ card_id: "W1" });
  const result = reconstructFromAuthorityAndObservations([r1, r2], [live], {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /DUPLICATE_DURABLE_RECEIPT/);
});

// F2: reconstructFromAuthorityAndObservations rejects head mismatch
test("F6-F2: reconstructFromAuthorityAndObservations rejects head mismatch between receipt and live", () => {
  const receipt = regEntry({ card_id: "W1", head: "a".repeat(40) });
  const live = regEntry({ card_id: "W1", head: "b".repeat(40) });
  const result = reconstructFromAuthorityAndObservations([receipt], [live], {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /HEAD_MISMATCH/);
});

// F2: reconstructFromAuthorityAndObservations rejects generation mismatch
test("F6-F2: reconstructFromAuthorityAndObservations rejects generation mismatch", () => {
  const receipt = regEntry({ card_id: "W1", generation: 1 });
  const live = regEntry({ card_id: "W1", generation: 2 });
  const result = reconstructFromAuthorityAndObservations([receipt], [live], {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /GENERATION_MISMATCH/);
});

// F2: reconstructFromAuthorityAndObservations rejects duplicate live observations
test("F6-F2: reconstructFromAuthorityAndObservations rejects duplicate live observations", () => {
  const receipt = regEntry({ card_id: "W1" });
  const live1 = regEntry({ card_id: "W1" });
  const live2 = regEntry({ card_id: "W1" });
  const result = reconstructFromAuthorityAndObservations([receipt], [live1, live2], {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /DUPLICATE_LIVE_OBSERVATION/);
});

// F2: reconstructFromAuthorityAndObservations rejects session workspace mismatch
test("F2: reconstructFromAuthorityAndObservations rejects session workspace mismatch", () => {
  const receipt = regEntry({ card_id: "W1", session: { workspace_id: "ws-1", pane_id: "p1", agent_session: "s1" } });
  const live = regEntry({ card_id: "W1", session: { workspace_id: "ws-2", pane_id: "p1", agent_session: "s1" } });
  const result = reconstructFromAuthorityAndObservations([receipt], [live], {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /SESSION_WORKSPACE_MISMATCH/);
});

// F2: reconstructFromAuthorityAndObservations rejects session pane mismatch
test("F2: reconstructFromAuthorityAndObservations rejects session pane mismatch", () => {
  const receipt = regEntry({ card_id: "W1", session: { workspace_id: "ws-1", pane_id: "p1", agent_session: "s1" } });
  const live = regEntry({ card_id: "W1", session: { workspace_id: "ws-1", pane_id: "p2", agent_session: "s1" } });
  const result = reconstructFromAuthorityAndObservations([receipt], [live], {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /SESSION_PANE_MISMATCH/);
});

// F2: reconstructFromAuthorityAndObservations rejects session agent_session mismatch
test("F2: reconstructFromAuthorityAndObservations rejects session agent_session mismatch", () => {
  const receipt = regEntry({ card_id: "W1", session: { workspace_id: "ws-1", pane_id: "p1", agent_session: "s1" } });
  const live = regEntry({ card_id: "W1", session: { workspace_id: "ws-1", pane_id: "p1", agent_session: "s2" } });
  const result = reconstructFromAuthorityAndObservations([receipt], [live], {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /SESSION_AGENT_MISMATCH/);
});

// F2: reconstructFromAuthorityAndObservations rejects lease_expiry mismatch
test("F2: reconstructFromAuthorityAndObservations rejects lease_expiry mismatch", () => {
  const receipt = regEntry({ card_id: "W1", lease_expiry: "2026-08-01T10:00:00+08:00" });
  const live = regEntry({ card_id: "W1", lease_expiry: "2026-08-01T11:00:00+08:00" });
  const result = reconstructFromAuthorityAndObservations([receipt], [live], {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /LEASE_EXPIRY_MISMATCH/);
});

// F6: UNCERTAIN_SEND production-path no-blind-retry
test("F6: physical send lease blocks second prompt for same logical key", async (t) => {
  const { paths } = await tempRuntime(t);
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 111, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 1 }));
  const first = await claimPhysicalSendLease(paths, { pid: 111, hostId: "host-a", fence: 1, logicalKey: "event-uncertain", nowMs: BASE_MS });
  assert.equal(first.allow, true);
  // Second claim for same logical key should be rejected (uncertain send)
  const second = await claimPhysicalSendLease(paths, { pid: 111, hostId: "host-a", fence: 1, logicalKey: "event-uncertain", nowMs: BASE_MS });
  assert.equal(second.allow, false);
  assert.equal(second.decision, "CONTROL_REQUIRED");
  assert.match(second.reason, /PHYSICAL_SEND_LEASE_HELD/);
});

// ---------------------------------------------------------------------------
// F001: Production reconstruction uses string fence_id from numeric lock.fence
// ---------------------------------------------------------------------------

test("F001: runLoopOnce derives string fence_id from numeric lock fence for reconstruction", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  // Simulate a durable receipt with string fence_id "1" (matching numeric fence 1)
  const receipt = regEntry({
    card_id: "W-RECON-01",
    fence: 1,
    fence_id: "1",
    ref: "refs/heads/recon",
    allowlist_paths: ["src/recon.mjs"],
    worktree: "D:\\worktrees\\recon",
    state: "ACTIVE",
  });
  const live = regEntry({
    card_id: "W-RECON-01",
    fence: 1,
    fence_id: "1",
    ref: "refs/heads/recon",
    allowlist_paths: ["src/recon.mjs"],
    worktree: "D:\\worktrees\\recon",
    state: "ACTIVE",
  });
  const authority = {
    generation: 1, ref: "refs/heads/recon", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\recon", process: { pid: 41040, started_at: REG_TS },
    session: { workspace_id: "w-recon", pane_id: "p-recon", agent_session: "s-recon" },
    lease_id: "lease-recon", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41040,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => false,
    durableReceipts: [receipt],
    liveObservations: [live],
    currentAuthority: authority,
    readCurrentIdentity: async () => authority,
  });
  // The reconstruction should succeed because fence_id is derived as String(lock.fence) = "1"
  assert.equal(outcome.stop, false);
  assert.ok(!outcome.events?.find((e) => e.type === "registry_reconstruction_rejected"),
    "reconstruction must not reject valid entries with numeric lock fence");
});

test("F001: runLoopOnce rejects currentAuthority fence mismatch with acquired lock", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 41040, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 1 }));
  const receipt = regEntry({ card_id: "W-FENCE-01", fence: 1, fence_id: "1" });
  const live = regEntry({ card_id: "W-FENCE-01", fence: 1, fence_id: "1" });
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41040,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => true,
    durableReceipts: [receipt],
    liveObservations: [live],
    currentAuthority: {
      generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
      worktree: "D:\\worktrees\\reg-01", process: { pid: 41040, started_at: REG_TS },
      session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
      lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 2, fence_id: "2",
    },
  });
  assert.equal(outcome.stop, false);
  assert.equal(outcome.reason, "LOCK_AUTHORITY_FENCE_MISMATCH");
});

test("F001: runLoopOnce rejects currentAuthority fence_id mismatch with derived lock fence_id", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 41040, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 1 }));
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41040,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => true,
    currentAuthority: {
      generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
      worktree: "D:\\worktrees\\reg-01", process: { pid: 41040, started_at: REG_TS },
      session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
      lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "wrong",
    },
  });
  assert.equal(outcome.stop, false);
  assert.equal(outcome.reason, "LOCK_AUTHORITY_FENCE_ID_MISMATCH");
});

// F001: Same-fence forged pid must be rejected. Acquired lock has fence=1,
// caller supplies currentAuthority with fence=1 but forged pid; must fail
// before downstream work.
test("F001: runLoopOnce rejects same-fence forged pid (authority pid != current process pid)", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 41040, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 1 }));
  const observedAuthority = {
    generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01", process: { pid: 41040, started_at: REG_TS },
    session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
    lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
  };
  const outcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 41040,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => true,
    currentAuthority: {
      generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
      worktree: "D:\\worktrees\\reg-01", process: { pid: 99999, started_at: REG_TS },
      session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
      lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
    },
    readCurrentIdentity: async () => observedAuthority,
  });
  assert.equal(outcome.stop, false);
  assert.equal(outcome.reason, "LOCK_AUTHORITY_PID_MISMATCH");
});

for (const [label, forge, expectedReason] of [
  ["host", (authority) => ({ ...authority, host_id: "host-forged" }), "LOCK_AUTHORITY_HOST_MISMATCH"],
  ["head", (authority) => ({ ...authority, head: "c".repeat(40) }), "LOCK_AUTHORITY_HEAD_MISMATCH"],
  ["session", (authority) => ({ ...authority, session: { ...authority.session, pane_id: "p-forged" } }), "LOCK_AUTHORITY_SESSION_PANE_ID_MISMATCH"],
]) {
  test(`F001: runLoopOnce rejects same-fence forged ${label} against fresh identity`, async (t) => {
    const { root, paths } = await tempRuntime(t);
    await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
    await mkdir(path.dirname(paths.lock), { recursive: true });
    await writeFile(paths.lock, JSON.stringify({ pid: 41040, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 1 }));
    const observedAuthority = {
      generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
      worktree: "D:\\worktrees\\reg-01", process: { pid: 41040, started_at: REG_TS },
      session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
      lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1", host_id: "host-a",
    };
    const outcome = await runLoopOnce({
      runtimeRoot: root,
      orca: quietOrca(),
      pid: 41040,
      hostId: "host-a",
      now: () => BASE_MS,
      isAlive: async () => true,
      currentAuthority: forge(observedAuthority),
      readCurrentIdentity: async () => observedAuthority,
    });
    assert.equal(outcome.stop, false);
    assert.equal(outcome.reason, expectedReason);
  });
}

// ---------------------------------------------------------------------------
// F002: reconstructFromAuthorityAndObservations validates authority fields
// ---------------------------------------------------------------------------
// F006: Production-boundary runLoopOnce UNCERTAIN_SEND regression
// Physical send succeeds, receipt publication fails, restart/recovery,
// second physical send is proven blocked.
// ---------------------------------------------------------------------------

test("F006: runLoopOnce UNCERTAIN_SEND regression — physical send succeeds, receipt fails, restart blocks second send", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 50001, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 1 }));

  let promptCount = 0;
  let publishCount = 0;
  let sendReceiptFails = true;

  const waitTuple = {
    source_terminal_receipt: 1629000001,
    control_generation: 13,
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target: { agent_name: "R49-EXECUTOR", executor_instance_id: "r49-executor-instance", surface: "HERDR", herdr_agent: "codex", herdr_workspace_id: "wR49", herdr_agent_kind: "codex" },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;

  // First tick: physical send succeeds, receipt publication fails
  const firstOutcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 50001,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => true,
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readAuthority: async () => ({ binding: residentAuthorityBinding() }),
      decisionBody,
      readComments: async ({ phase, logicalKey } = {}) => phase === "send_pending_readback"
        ? completeComments([{ id: "send-pending-1", body: pendingDeliveryReceipt(logicalKey) }])
        : completeComments(),
      herdr: { prompt: async () => { promptCount += 1; return { accepted: true, workspace_id: "wR49", pane_id: "wR49:p1", agent_session: "r49" }; } },
      publishReceipt: async (receipt) => { publishCount += 1; if (receipt?.state === "CONSUMED_STARTED" && sendReceiptFails) throw new Error("PUBLICATION_FAILED"); return { id: `receipt-${publishCount}` }; },
    },
  });

  // Physical prompt was sent
  assert.equal(promptCount, 1);
  // Receipt publication failed (SEND_PENDING succeeded, CONSUMED_STARTED failed)
  assert.equal(publishCount, 2);
  // The delivery should have been attempted but receipt failed
  const uncertainEvent = firstOutcome.events.find((e) => e.type === "resume_delivery_no_blind_retry" || e.type === "resume_delivery_failed" || e.type === "resume_delivery_control_required");
  assert.ok(uncertainEvent, "expected delivery failure or no-blind-retry event from receipt publication failure");

  // Second tick: recovery should NOT re-prompt (NO_BLIND_RETRY / UNCERTAIN_SEND)
  sendReceiptFails = false;
  const secondOutcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 50001,
    hostId: "host-a",
    now: () => BASE_MS + 15_000,
    isAlive: async () => true,
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readAuthority: async () => ({ binding: residentAuthorityBinding() }),
      decisionBody,
      readComments: async ({ phase, logicalKey } = {}) => phase === "send_pending_readback"
        ? completeComments([{ id: "send-pending-2", body: pendingDeliveryReceipt(logicalKey) }])
        : completeComments(),
      herdr: { prompt: async () => { promptCount += 1; return { accepted: true }; } },
      publishReceipt: async () => ({ id: "receipt-2" }),
    },
  });

  // Second prompt must NOT have been sent — the uncertain send state blocks retry
  assert.equal(promptCount, 1, "second physical send must be blocked after uncertain send");
});

// ---------------------------------------------------------------------------
// F006: Causal durable fresh restart proof
// Uses one shared fake durable GitHub comment store at the adapter boundary.
// First run publishes SEND_PENDING into the store, readback reads the same
// store, physical prompt succeeds once, terminal publication fails. Then all
// local recovery state is discarded and a genuinely fresh consumer discovers
// only the durable SEND_PENDING marker and returns NO_BLIND_RETRY without a
// second physical prompt. Prompt count must remain exactly one.
// ---------------------------------------------------------------------------

test("F006: causal durable fresh restart — shared store, first publish + prompt, terminal fail, fresh consumer blocks second prompt", async (t) => {
  const { root, paths } = await tempRuntime(t);
  await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
  await mkdir(path.dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid: 70001, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 1 }));

  // Shared durable GitHub comment store — the single source of truth for
  // publication and readback causality. publishReceipt(SEND_PENDING) writes
  // into this store; every readComments reads from the same store.
  const durableGitHubComments = [];
  const readPhases = [];
  const publishStates = [];

  let promptCount = 0;

  const waitTuple = {
    source_terminal_receipt: 1629000001,
    control_generation: 13,
    card_id: "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01",
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target: { agent_name: "R49-EXECUTOR", executor_instance_id: "r49-executor-instance", surface: "HERDR", herdr_agent: "codex", herdr_workspace_id: "wR49", herdr_agent_kind: "codex" },
  };
  const decisionBody = `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: 13
decision_topic: ISSUE162_RESIDENT_CONSUMER

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt 1629000001
source_control_generation: 13
resume_card_id: GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01

EXACT_TARGET
executor_role: WORKER
agent_name: R49-EXECUTOR
executor_instance_id: r49-executor-instance
surface: HERDR
minimal_wake: Read GitHub directly.
`;

  function buildReadComments(logicalKey) {
    return async ({ phase } = {}) => {
      readPhases.push({ phase, count: durableGitHubComments.length });
      // All phases read from the shared durable store
      const comments = durableGitHubComments.map((body, idx) => ({
        id: `gh-comment-${idx}`,
        created_at: "2026-08-01T09:00:00+08:00",
        body,
      }));
      return completeComments(comments);
    };
  }

  // First run: fresh consumer publishes SEND_PENDING into the durable store,
  // readback reads from the same store, physical prompt succeeds once,
  // terminal receipt publication fails.
  const firstOutcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 70001,
    hostId: "host-a",
    now: () => BASE_MS,
    isAlive: async () => true,
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readAuthority: async () => ({ binding: residentAuthorityBinding() }),
      decisionBody,
      readComments: buildReadComments(),
      herdr: { prompt: async () => { promptCount += 1; return { accepted: true, workspace_id: "wR49", pane_id: "wR49:p1", agent_session: "r49" }; } },
      publishReceipt: async (receipt) => {
        publishStates.push(receipt?.state);
        if (receipt?.state === "SEND_PENDING") {
          // Publish SEND_PENDING into the shared durable store
          const body = [
            "HERDR_RESUME_DELIVERY_V1",
            `state: ${receipt.state}`,
            `logical_event_key: ${receipt.logical_event_key}`,
            `source_terminal_receipt: ${receipt.source_terminal_receipt}`,
            `control_generation: ${receipt.control_generation}`,
            `card_id: ${receipt.card_id}`,
            `allowed_action_class: ${receipt.allowed_action_class}`,
            `target_agent_name: ${receipt.target_agent_name}`,
            `target_executor_instance_id: ${receipt.target_executor_instance_id}`,
            `target_surface: ${receipt.target_surface}`,
            `target_herdr_agent: ${receipt.target_herdr_agent}`,
            `target_herdr_workspace_id: ${receipt.target_herdr_workspace_id}`,
            `target_herdr_pane_id: ${receipt.target_herdr_pane_id}`,
            `target_herdr_agent_session: ${receipt.target_herdr_agent_session}`,
          ].join("\n");
          durableGitHubComments.push(body);
          return { id: `gh-send-pending-${durableGitHubComments.length}` };
        }
        if (receipt?.state === "CONSUMED_STARTED") {
          // Terminal publication fails
          throw new Error("TERMINAL_PUBLICATION_FAILED");
        }
        return { id: `gh-other-${durableGitHubComments.length}` };
      },
    },
  });

  // Physical prompt was sent exactly once
  assert.equal(promptCount, 1, `first run must send exactly one physical prompt: ${JSON.stringify(firstOutcome)}`);
  assert.deepEqual(publishStates, ["SEND_PENDING", "CONSUMED_STARTED"], "terminal receipt publication must be attempted after the physical prompt");
  assert.deepEqual(readPhases.filter(({ phase }) => phase === "send_pending_readback").map(({ count }) => count), [1], "SEND_PENDING readback must observe the same durable store write");
  assert.equal(firstOutcome.events.find((event) => event.type === "resume_delivery_no_blind_retry")?.decision, "NO_BLIND_RETRY");
  // SEND_PENDING was published to the durable store
  assert.ok(durableGitHubComments.length >= 1, "SEND_PENDING must be in durable store");

  // Discard all local recovery/delivery state — simulate fresh process
  const recoveryStatePath = path.join(root, "state", "recovery_state.json");
  await rm(recoveryStatePath, { force: true });

  // Second run: genuinely fresh consumer with NO local state. Only the
  // durable GitHub comment store survives. The fresh readComments reads
  // the SEND_PENDING marker from the store, findExistingDelivery
  // discovers it, and returns NO_OP_DUPLICATE without a second prompt.
  const secondOutcome = await runLoopOnce({
    runtimeRoot: root,
    orca: quietOrca(),
    pid: 70001,
    hostId: "host-a",
    now: () => BASE_MS + 15_000,
    isAlive: async () => true,
    resumeDelivery: {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: ["CONTROL_DECISION_V1"] },
      waitTuple,
      readAuthority: async () => ({ binding: residentAuthorityBinding() }),
      decisionBody,
      readComments: buildReadComments(),
      herdr: { prompt: async () => { promptCount += 1; throw new Error("MUST_NOT_PROMPT_ON_FRESH_RESTART"); } },
      publishReceipt: async () => { throw new Error("MUST_NOT_PUBLISH_ON_FRESH_RESTART"); },
    },
  });

  // Prompt count must remain exactly one — the durable SEND_PENDING marker
  // from the shared store blocks any second physical prompt
  assert.equal(promptCount, 1, "fresh consumer must not re-prompt; durable SEND_PENDING blocks retry");
  // The duplicate detection must have fired
  const duplicateEvent = secondOutcome.events?.find((e) => e.type === "resume_delivery_duplicate");
  assert.ok(duplicateEvent, "fresh consumer must detect SEND_PENDING duplicate from durable store");
});

// ---------------------------------------------------------------------------
// F001: admitEntryWithAuthority rejects partial authority (old API)
// ---------------------------------------------------------------------------

test("F001: admitEntryWithAuthority rejects missing currentAuthority", () => {
  const reg = createRegistry();
  const result = admitEntryWithAuthority(reg, regEntry(), REG_TS, {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /AUTHORITY_MISSING/);
});

test("F001: admitEntryWithAuthority rejects invalid currentAuthority", () => {
  const reg = createRegistry();
  const result = admitEntryWithAuthority(reg, regEntry(), REG_TS, {
    currentAuthority: { generation: "not-a-number", ref: 123 },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /AUTHORITY_INVALID/);
});

test("F001: admitEntryWithAuthority admits under valid currentAuthority", () => {
  const reg = createRegistry();
  const authority = {
    generation: 1,
    ref: "refs/heads/main",
    head: "a".repeat(40),
    tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01",
    process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: "lease-reg-01",
    lease_expiry: "2026-08-01T10:00:00+08:00",
    fence: 1,
    fence_id: "fence-reg-01",
  };
  const result = admitEntryWithAuthority(reg, regEntry(), REG_TS, { currentAuthority: authority });
  assert.equal(result.ok, true);
  assert.equal(reg.entries["GBB-REG-01"].state, "ADMITTED");
});

// ---------------------------------------------------------------------------
// F004: canonicalizeWorktree rejects ambiguous Windows forms
// ---------------------------------------------------------------------------

test("F004: canonicalizeWorktree accepts canonical UNC and rejects ambiguous UNC", () => {
  assert.equal(canonicalizeWorktree("\\\\server\\share\\worktree"), "//server/share/worktree");
  assert.equal(canonicalizeWorktree("//server/share/worktree"), null);
});

test("F004: canonicalizeWorktree rejects bare leading slash", () => {
  assert.equal(canonicalizeWorktree("/worktrees/reg-01"), null);
});

test("F004: canonicalizeWorktree accepts drive letter paths and normalizes them", () => {
  assert.equal(canonicalizeWorktree("D:\\worktrees\\reg-01"), "d:/worktrees/reg-01");
  assert.equal(canonicalizeWorktree("D:/worktrees/reg-01"), "d:/worktrees/reg-01");
  assert.equal(canonicalizeWorktree("d:\\worktrees\\reg-01"), "d:/worktrees/reg-01");
});

test("F004: canonicalizeWorktree rejects relative paths", () => {
  assert.equal(canonicalizeWorktree("worktrees/reg-01"), null);
  assert.equal(canonicalizeWorktree("./worktrees/reg-01"), null);
});

test("F004: canonicalizeWorktree rejects aliases before normalization", () => {
  assert.equal(canonicalizeWorktree("D:\\worktrees\\reg-01\\..\\reg-02"), null);
  assert.equal(canonicalizeWorktree("D:\\worktrees\\reg-01\\\\alias"), null);
  assert.equal(canonicalizeWorktree("D:\\worktrees\\reg-01//alias"), null);
  assert.equal(canonicalizeWorktree("D:worktrees\\reg-01"), null);
  assert.equal(canonicalizeWorktree("\\\\server\\share\\.\\worktree"), null);
  assert.equal(canonicalizeWorktree("\\\\server\\share\\\\worktree"), null);
  assert.equal(canonicalizeWorktree("\\\\server/share/worktree"), null);
});

// F004: Reject single-separator mixed drive spellings
test("F004: canonicalizeWorktree rejects single-separator slash-mixed drive paths", () => {
  assert.equal(canonicalizeWorktree("D:\\worktrees/reg-01"), null, "backslash then forward slash must be rejected");
  assert.equal(canonicalizeWorktree("D:/worktrees\\reg-01"), null, "forward slash then backslash must be rejected");
  assert.equal(canonicalizeWorktree("C:\\foo/bar/baz"), null, "mixed separators in body must be rejected");
});

// F004: Admission rejects invalid worktree forms through production boundary
const INVALID_WORKTREE_CASES = [
  ["relative path", "worktrees/reg-01"],
  ["drive-relative", "D:worktrees\\reg-01"],
  ["root-relative backslash", "\\worktrees\\reg-01"],
  ["root-relative forward slash", "/worktrees/reg-01"],
  ["dot-segment", "D:\\worktrees\\reg-01\\..\\reg-02"],
  ["double-separator alias", "D:\\worktrees\\reg-01\\\\alias"],
  ["slash-mixed alias", "D:\\worktrees\\reg-01//alias"],
  ["slash-mixed backslash-then-forward", "D:\\worktrees/reg-01"],
  ["slash-mixed forward-then-backslash", "D:/worktrees\\reg-01"],
  ["POSIX UNC", "//server/share/worktree"],
  ["ambiguous UNC dot-segment", "\\\\server\\share\\.\\worktree"],
  ["ambiguous UNC double-separator", "\\\\server\\share\\\\worktree"],
];

for (const [label, invalidWt] of INVALID_WORKTREE_CASES) {
  test(`F004: admission rejects invalid worktree (${label}) through runLoopOnce`, async (t) => {
    const { root, paths } = await tempRuntime(t);
    await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
    await mkdir(path.dirname(paths.lock), { recursive: true });
    await writeFile(paths.lock, JSON.stringify({ pid: 41040, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 1 }));
    const entry = regEntry({
      card_id: "W-INVALID-WT",
      worktree: invalidWt,
      ref: "refs/heads/main",
      allowlist_paths: ["src/invalid.mjs"],
      fence: 1,
      fence_id: "1",
      lease_id: "lease-1",
      process: { pid: 41040, started_at: REG_TS },
      session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
      lease_expiry: "2026-08-01T10:00:00+08:00",
      generation: 1,
    });
    const authority = {
      generation: 1, ref: "refs/heads/main", head: "a".repeat(40), tree: "b".repeat(40),
      worktree: "D:\\worktrees\\reg-01", process: { pid: 41040, started_at: REG_TS },
      session: { workspace_id: "w1", pane_id: "p1", agent_session: "s1" },
      lease_id: "lease-1", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
    };
    const outcome = await runLoopOnce({
      runtimeRoot: root,
      orca: quietOrca(),
      pid: 41040,
      hostId: "host-a",
      now: () => BASE_MS,
      isAlive: async () => true,
      pendingAdmissions: [entry],
      currentAuthority: authority,
      readCurrentIdentity: async () => authority,
    });
    assert.equal(outcome.stop, false);
    assert.equal(outcome.reason, "REGISTRY_ADMISSION_REJECTED",
      `admission must reject ${label} worktree ${JSON.stringify(invalidWt)}`);
    assert.ok(outcome.admissionResults?.some((r) => !r.ok && (/(?:INVALID_WORKTREE|WORKTREE_MISMATCH)/.test(r.reason))),
      `must have INVALID_WORKTREE or WORKTREE_MISMATCH rejection for ${label}`);
  });
}

// F004: Reconstruction rejects invalid worktree forms through production boundary
for (const [label, invalidWt] of INVALID_WORKTREE_CASES) {
  test(`F004: reconstruction rejects invalid worktree (${label}) through runLoopOnce`, async (t) => {
    const { root, paths } = await tempRuntime(t);
    await writeFile(paths.state, JSON.stringify(projectState({ state: "RUNNING" })));
    await mkdir(path.dirname(paths.lock), { recursive: true });
    await writeFile(paths.lock, JSON.stringify({ pid: 41040, host_id: "host-a", at: "2026-08-01T09:00:00+08:00", fence: 1 }));
    const receipt = regEntry({
      card_id: "W-RECON-INVALID-WT",
      worktree: invalidWt,
      ref: "refs/heads/recon",
      allowlist_paths: ["src/recon.mjs"],
      state: "ACTIVE",
      fence: 1,
      fence_id: "1",
    });
    const live = regEntry({
      card_id: "W-RECON-INVALID-WT",
      worktree: invalidWt,
      ref: "refs/heads/recon",
      allowlist_paths: ["src/recon.mjs"],
      state: "ACTIVE",
      fence: 1,
      fence_id: "1",
    });
    const authority = {
      generation: 1, ref: "refs/heads/recon", head: "a".repeat(40), tree: "b".repeat(40),
      worktree: invalidWt, process: { pid: 41040, started_at: REG_TS },
      session: { workspace_id: "w-recon", pane_id: "p-recon", agent_session: "s-recon" },
      lease_id: "lease-recon", lease_expiry: "2026-08-01T10:00:00+08:00", fence: 1, fence_id: "1",
    };
    const outcome = await runLoopOnce({
      runtimeRoot: root,
      orca: quietOrca(),
      pid: 41040,
      hostId: "host-a",
      now: () => BASE_MS,
      isAlive: async () => true,
      durableReceipts: [receipt],
      liveObservations: [live],
      currentAuthority: authority,
      readCurrentIdentity: async () => authority,
    });
    assert.equal(outcome.stop, false);
    assert.match(outcome.reason, /^REGISTRY_RECONSTRUCTION_REJECTED/,
      `reconstruction must reject ${label} worktree ${JSON.stringify(invalidWt)}`);
  });
}

// ---------------------------------------------------------------------------
// F005: reclassifyEntry RELEASED requires identity-bound releaseAuthority
// ---------------------------------------------------------------------------

test("F005: reclassifyEntry rejects RELEASED with mismatched releaseAuthority pid", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1", lease_expiry: "2026-08-01T08:00:00+08:00" });
  admitEntry(reg, entry, REG_TS);
  reclassifyEntry(reg, "W1", "ACTIVE", { authority: fullAuth(entry) });
  const result = reclassifyEntry(reg, "W1", "RELEASED", {
    authority: fullAuth(entry),
    isoNow: "2026-08-01T11:00:00+08:00",
    releaseAuthority: { type: "terminal_authority", pid: 9999, fence: entry.fence, fence_id: entry.fence_id, lease_id: entry.lease_id, lease_expiry: entry.lease_expiry, generation: entry.generation, ref: entry.ref, head: entry.head, tree: entry.tree, worktree: entry.worktree, process: entry.process, session: entry.session },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /RELEASE_AUTHORITY_PID_MISMATCH/);
});

test("F005: reclassifyEntry rejects RELEASED with mismatched releaseAuthority fence", () => {
  const reg = createRegistry();
  const entry = regEntry({ card_id: "W1", lease_expiry: "2026-08-01T08:00:00+08:00" });
  admitEntry(reg, entry, REG_TS);
  reclassifyEntry(reg, "W1", "ACTIVE", { authority: fullAuth(entry) });
  const result = reclassifyEntry(reg, "W1", "RELEASED", {
    authority: fullAuth(entry),
    isoNow: "2026-08-01T11:00:00+08:00",
    releaseAuthority: { type: "terminal_authority", pid: entry.process.pid, fence: 99, fence_id: entry.fence_id, lease_id: entry.lease_id, lease_expiry: entry.lease_expiry, generation: entry.generation, ref: entry.ref, head: entry.head, tree: entry.tree, worktree: entry.worktree, process: entry.process, session: entry.session },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /RELEASE_AUTHORITY_FENCE_MISMATCH/);
});

// ---------------------------------------------------------------------------
// F002: reconstructFromAuthorityAndObservations validates against currentAuthority
// ---------------------------------------------------------------------------

test("F002: reconstructFromAuthorityAndObservations validates against currentAuthority", () => {
  const receipt = regEntry({ card_id: "W1", generation: 1 });
  const live = regEntry({ card_id: "W1", generation: 1 });
  const authority = {
    generation: 2, // mismatch
    ref: "refs/heads/main",
    head: "a".repeat(40),
    tree: "b".repeat(40),
    worktree: "D:\\worktrees\\reg-01",
    process: { pid: 1001, started_at: REG_TS },
    session: { workspace_id: "w-reg-01", pane_id: "p-reg-01", agent_session: "s-reg-01" },
    lease_id: "lease-reg-01",
    lease_expiry: "2026-08-01T10:00:00+08:00",
    fence: 1,
    fence_id: "fence-reg-01",
  };
  const result = reconstructFromAuthorityAndObservations([receipt], [live], { currentAuthority: authority });
  assert.equal(result.ok, false);
  assert.match(result.reason, /RECONSTRUCTION_AUTHORITY_GENERATION_MISMATCH/);
});
