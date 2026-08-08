// GPT_BROWSER_BRIDGE - Overnight Supervisor (GBB-004)
// Spec: plans/GBB_PARENT_WORK_ORDER.md §15, skills/recovery-supervisor/SKILL.md.
//
// Deterministic Node process, NO model. Every external boundary (ORCA CLI,
// the system clock, `git`, `tasklist`, sleeping between ticks) is injectable
// through the `ctx` object passed to runLoopOnce()/runSupervisor() so this
// file is fully test-driven without a live ORCA session or a real 15s
// interval. Plain filesystem access (state/heartbeat/events/lock/runs/jobs)
// uses node:fs/promises directly against `ctx.runtimeRoot`, matching the
// rest of the repo's testing convention (temp dirs, not fs mocks).
//
// Hard boundary (§6.1, §15 step 12): this file recovers processes and
// terminals. It never judges pass/rework, never resends a ChatGPT prompt,
// never presses Continue, and never moves NEEDS_HUMAN -> RUNNING. The only
// state transitions it performs are RUNNING-ish -> NEEDS_HUMAN for a small,
// fixed set of infrastructure-only reason codes (ORCA_UNAVAILABLE,
// REPEATED_TERMINAL_CRASH, CHECKPOINT_MISSING, DIRTY_ATTRIBUTION_UNKNOWN,
// AUTH_REQUIRED) - each a mechanical threshold, not a code-quality judgment.
// Agent-task rework counting (§15 "Agent 任務失敗") stays the Control
// Tower's call per §6.2; Supervisor only forwards the events it needs to see.

import { readFile, appendFile, mkdir, stat, readdir, writeFile } from "node:fs/promises";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import writeFileAtomic from "write-file-atomic";

import { projectStateSchema } from "./contracts.mjs";
import { OrcaAdapter, resolveOrcaCli, resolveActiveTerminal } from "./adapters/orca_adapter.mjs";
import { gatherMorningSummaryData, writeMorningSummary } from "./morning_summary.mjs";
import { runPoll, readStateFile, writeStateFile, applyAck, fetchSnapshotViaGh } from "./github_relay.mjs";
import { executeAction } from "./github_relay_executor.mjs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants (§15 retry policy)
// ---------------------------------------------------------------------------

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const PROCESS_CRASH_BACKOFF_MS = [10_000, 30_000, 120_000];
export const ORCA_RETRY_BACKOFF_MS = [30_000, 60_000, 180_000, 300_000];
export const ORCA_UNAVAILABLE_ESCALATE_MS = 20 * 60_000;
export const MORNING_SUMMARY_MAX_INTERVAL_MS = 30 * 60_000;

const ROLE_SKILL_DIR = {
  control: "control-tower",
  worker: "worker",
  reviewer: "reviewer",
  watcher: "browser-watcher",
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function resolveRuntimePaths(runtimeRoot) {
  const root = runtimeRoot;
  return {
    root,
    state: path.join(root, "state", "project_state.json"),
    heartbeat: path.join(root, "state", "heartbeat.json"),
    summary: path.join(root, "state", "morning_summary.md"),
    recoveryState: path.join(root, "state", "recovery_state.json"),
    reportCursor: path.join(root, "state", "report_cursor.json"),
    relayState: path.join(root, "state", "github_relay_state.json"),
    relayExecutorState: path.join(root, "state", "github_relay_executor_state.json"),
    lock: path.join(root, "locks", "supervisor.lock"),
    events: path.join(root, "events", "events.ndjson"),
    runsDir: path.join(root, "runs"),
    jobsDir: path.join(root, "jobs"),
    logsDir: path.join(root, "logs"),
  };
}

async function ensureRuntimeDirs(paths) {
  const dirs = new Set([
    path.dirname(paths.state),
    path.dirname(paths.lock),
    path.dirname(paths.events),
    paths.runsDir,
    paths.jobsDir,
    paths.logsDir,
  ]);
  await Promise.all([...dirs].map((d) => mkdir(d, { recursive: true })));
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

export function formatIso(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}+08:00`;
}

// ---------------------------------------------------------------------------
// Pure decision helpers
// ---------------------------------------------------------------------------

export function isStopState(stateValue) {
  return stateValue === "COMPLETED" || stateValue === "CANCELLED" || stateValue === "NEEDS_HUMAN";
}

export function defaultRecoveryEntry() {
  return { attempts: 0, nextRetryAtMs: 0 };
}

export function canAttemptRecovery(entry, nowMs) {
  return nowMs >= (entry?.nextRetryAtMs ?? 0);
}

// §15 "Process crash": same step, at most 3 automatic restarts, backoff
// 10s -> 30s -> 120s. A 4th consecutive failure means the caller should
// escalate rather than retry again.
export function recordRecoveryFailure(entry, nowMs, table = PROCESS_CRASH_BACKOFF_MS) {
  const attempts = (entry?.attempts ?? 0) + 1;
  if (attempts > table.length) {
    return { attempts: entry?.attempts ?? table.length, nextRetryAtMs: Infinity, exhausted: true };
  }
  return { attempts, nextRetryAtMs: nowMs + table[attempts - 1], exhausted: false };
}

export function recordRecoverySuccess() {
  return defaultRecoveryEntry();
}

// §15 "ORCA 不可用": retry 30/60/180/300s; 20 consecutive minutes unreachable
// escalates. `entry.unavailableSinceMs` is persisted across ticks (and
// across a Supervisor restart, via recovery_state.json) so the 20-minute
// clock survives a crash of the Supervisor itself.
export function evaluateOrcaAvailability(entry, { ok, nowMs }) {
  if (ok) {
    return { unavailableSinceMs: null, attempts: 0, nextRetryAtMs: 0, escalate: false };
  }
  const unavailableSinceMs = entry?.unavailableSinceMs ?? nowMs;
  const attempts = (entry?.attempts ?? 0) + 1;
  const delay = ORCA_RETRY_BACKOFF_MS[Math.min(attempts - 1, ORCA_RETRY_BACKOFF_MS.length - 1)];
  const escalate = nowMs - unavailableSinceMs >= ORCA_UNAVAILABLE_ESCALATE_MS;
  return { unavailableSinceMs, attempts, nextRetryAtMs: nowMs + delay, escalate };
}

// The only state mutation this file performs. Never overwrites an existing
// terminal state (COMPLETED/CANCELLED/NEEDS_HUMAN) - idempotent and fails
// closed rather than clobbering a human's or Control Tower's prior verdict.
export function escalateToNeedsHuman(state, reasonCode, detail, isoNow) {
  if (isStopState(state.state)) return state;
  const blocked_reason = detail ? `${reasonCode}: ${detail}` : reasonCode;
  return projectStateSchema.parse({ ...state, state: "NEEDS_HUMAN", blocked_reason, updated_at: isoNow });
}

// §15 terminal naming: GBB-<TASK>-A<ATTEMPT>-<role>. Resume-prompt content is
// fixed and deterministic - never a ChatGPT prompt, never "press Continue".
export function buildResumePrompt(role, state, { runId } = {}) {
  const roleSafety = role === "reviewer"
    ? ["Start from a fresh context. Do not reuse any incomplete or stale reviewer conclusion."]
    : [];
  return [
    "[GBB Supervisor auto-recovery]",
    `Your ${role} terminal was rebuilt after losing its previous session.`,
    `task=${state.current_task} attempt=${state.attempt} phase=${state.current_phase} run_id=${runId ?? state.active_run_id}`,
    ...roleSafety,
    "Before doing anything else, read (in order):",
    "  1. plans/GBB_PARENT_WORK_ORDER.md",
    `  2. skills/${ROLE_SKILL_DIR[role] ?? role}/SKILL.md`,
    "  3. state/project_state.json and events/events.ndjson in the runtime root",
    "  4. any existing report/checkpoint files under runs/<run_id>/",
    "Do not repeat completed work. Do not re-send any ChatGPT prompt.",
    "Resume exactly where the last checkpoint left off.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Lock (§15 step 2: confirm lock owner; also the initial acquire)
// ---------------------------------------------------------------------------

async function defaultIsAlive(pid) {
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`], { windowsHide: true });
    // tasklist always exits 0; a non-match prints "INFO: No tasks...".
    return !/no tasks/i.test(stdout) && stdout.includes(String(pid));
  } catch {
    return false;
  }
}

// Re-run every tick (not just at startup): if a live process other than us
// owns the lock, we stop rather than fight it (duplicate scheduler
// invocation). If nobody alive owns it (Supervisor was killed), we take it
// over. Owning it also renews the timestamp.
export async function acquireOrConfirmLock(paths, { pid, isAlive, isoNow }) {
  let current = null;
  try {
    current = JSON.parse(await readFile(paths.lock, "utf8"));
  } catch {
    current = null;
  }
  if (current && current.pid !== pid) {
    const alive = await isAlive(current.pid);
    if (alive) return { owned: false, holder: current.pid };
  }
  await writeFileAtomic(paths.lock, JSON.stringify({ pid, at: isoNow }, null, 2));
  return { owned: true, holder: pid };
}

// ---------------------------------------------------------------------------
// Durable state / heartbeat / events / recovery-state I/O
// ---------------------------------------------------------------------------

export async function readProjectStateSafe(paths) {
  try {
    const raw = await readFile(paths.state, "utf8");
    return { ok: true, state: projectStateSchema.parse(JSON.parse(raw)) };
  } catch (e) {
    return { ok: false, state: null, error: e.message };
  }
}

export function validateProjectStateTransition(previousState, nextState) {
  if (previousState?.state === "NEEDS_HUMAN" && nextState?.state === "RUNNING") {
    throw new Error("ILLEGAL_STATE_TRANSITION: NEEDS_HUMAN -> RUNNING");
  }
  return nextState;
}

export async function writeProjectState(paths, state) {
  const validated = projectStateSchema.parse(state);
  const previous = await readProjectStateSafe(paths);
  if (previous.ok) validateProjectStateTransition(previous.state, validated);
  await writeFileAtomic(paths.state, JSON.stringify(validated, null, 2) + "\n");
  return validated;
}

export async function writeHeartbeat(paths, { pid, isoNow, state }) {
  await writeFileAtomic(paths.heartbeat, JSON.stringify({ at: isoNow, pid, state }, null, 2));
}

export async function appendEvents(paths, events, isoNow) {
  if (!events || events.length === 0) return;
  const lines = events.map((e) => JSON.stringify({ at: isoNow, ...e })).join("\n") + "\n";
  await appendFile(paths.events, lines);
}

export function defaultRecoveryState() {
  return {
    schema_version: 1,
    orca: { unavailableSinceMs: null, attempts: 0, nextRetryAtMs: 0 },
    terminalCrashes: {},
    lastSummaryAtMs: null,
  };
}

export async function readRecoveryState(paths) {
  try {
    const raw = JSON.parse(await readFile(paths.recoveryState, "utf8"));
    const defaults = defaultRecoveryState();
    return { ...defaults, ...raw, orca: { ...defaults.orca, ...raw.orca } };
  } catch {
    return defaultRecoveryState();
  }
}

export async function writeRecoveryState(paths, recoveryState) {
  await writeFileAtomic(paths.recoveryState, JSON.stringify(recoveryState, null, 2));
}

async function readReportCursor(paths) {
  try {
    const parsed = JSON.parse(await readFile(paths.reportCursor, "utf8"));
    return { seenRuns: parsed.seenRuns ?? [], seenJobs: parsed.seenJobs ?? [] };
  } catch {
    return { seenRuns: [], seenJobs: [] };
  }
}

async function writeReportCursor(paths, cursor) {
  await writeFileAtomic(paths.reportCursor, JSON.stringify(cursor, null, 2));
}

// ---------------------------------------------------------------------------
// Dispatch checkpoint (runs/<run_id>/dispatch.json) - the "checkpoint" §15
// step 8 rebuilds a terminal from. Written by the Control Tower; Supervisor
// only ever reads it. Missing/invalid => fail closed, never invent a launch
// command.
// ---------------------------------------------------------------------------

const dispatchRoleSchema = z.object({
  title: z.string().min(1),
  command: z.string().min(1),
  worktree: z.string().min(1).optional(),
});

const dispatchCheckpointSchema = z.object({
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  attempt: z.number().int().positive(),
  worktree: z.string().min(1),
  roles: z.record(z.string(), dispatchRoleSchema),
});

export async function readDispatchCheckpoint(paths, runId) {
  if (!runId) return null;
  try {
    const raw = await readFile(path.join(paths.runsDir, runId, "dispatch.json"), "utf8");
    return dispatchCheckpointSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function appendRecoveryLog(paths, runId, entry) {
  if (!runId) return;
  const dir = path.join(paths.runsDir, runId);
  await mkdir(dir, { recursive: true });
  const line = `at=${entry.at} reason=${entry.reason} role=${entry.role} old_terminal=${entry.old_terminal} new_terminal=${entry.new_terminal}\n`;
  await appendFile(path.join(dir, "recovery.log"), line);
}

// ---------------------------------------------------------------------------
// Git dirty check (§15 crash matrix "Git dirty": pause, write attribution
// report; never clean/stash/reset).
// ---------------------------------------------------------------------------

async function defaultGitExec(args, { cwd }) {
  return execFileAsync("git", args, { cwd, windowsHide: true });
}

export async function checkWorktreeGitStatus(worktreePath, { gitExec = defaultGitExec } = {}) {
  let statusOut;
  try {
    statusOut = await gitExec(["status", "--short"], { cwd: worktreePath });
  } catch (e) {
    return { exists: false, clean: true, shortStatus: "", diffFiles: [], error: e.message };
  }
  let diffOut;
  try {
    diffOut = await gitExec(["diff", "--name-only"], { cwd: worktreePath });
  } catch {
    diffOut = { stdout: "" };
  }
  const shortStatus = (statusOut.stdout ?? "").trim();
  const diffFiles = (diffOut.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { exists: true, clean: shortStatus.length === 0, shortStatus, diffFiles };
}

export async function writeDirtyAttributionReport(paths, runId, { worktreePath, gitStatus, isoNow }) {
  const dir = runId ? path.join(paths.runsDir, runId) : paths.runsDir;
  await mkdir(dir, { recursive: true });
  const md = [
    "# Dirty attribution report",
    "",
    `- at: ${isoNow}`,
    `- worktree: ${worktreePath}`,
    "",
    "## git status --short",
    "",
    "```",
    gitStatus.shortStatus || "(empty)",
    "```",
    "",
    "## git diff --name-only",
    "",
    "```",
    gitStatus.diffFiles.join("\n") || "(empty)",
    "```",
    "",
    "Supervisor paused rather than resetting/stashing/cleaning. A human must",
    "attribute this state before automatic recovery continues.",
    "",
  ].join("\n");
  await writeFileAtomic(path.join(dir, "dirty_attribution_report.md"), md);
}

// ---------------------------------------------------------------------------
// §15 steps 6-9: active-terminal health check and crash recovery.
// ---------------------------------------------------------------------------

// F005: while the relay executor owns a mid-flight DISPATCH_FIX (stage
// "dispatched"), the executor is the sole authority over the Worker terminal.
// The supervisor must never create/send a Worker terminal behind it (that
// would bypass the executor's at-most-once recovery_attempted guard and allow
// an unbounded rebuild loop). Reads the relay executor checkpoint defensively:
// a missing/corrupt checkpoint is NOT a dispatch in flight, so it never blocks
// legacy recovery.
export async function relayDispatchInFlight(paths) {
  try {
    const raw = await readFile(paths.relayExecutorState, "utf8");
    const exec = JSON.parse(raw);
    return exec?.dispatch_fix?.stage === "dispatched";
  } catch {
    return false;
  }
}

export async function recoverActiveTerminal(ctx, state, recoveryState, isoNow) {
  const events = [];
  const recoveries = [];
  const ref = state.active_terminal;
  if (!ref) return { state, recoveryState, events, recoveries };

  // F005: never rebuild/resume the Worker terminal while the relay executor is
  // mid-dispatch. The executor owns that lifecycle (and its own at-most-once
  // recovery); a supervisor rebuild here would create a second authority with
  // the same exact-title worker and bypass the executor's recovery guard.
  if (ref.role === "worker" && (await relayDispatchInFlight(ctx.paths))) {
    events.push({ type: "worker_terminal_owned_by_executor", dispatch_stage: "dispatched" });
    return { state, recoveryState, events, recoveries };
  }

  let terminals;
  try {
    terminals = await ctx.orca.listTerminals();
  } catch (e) {
    events.push({ type: "orca_list_terminals_failed", error: e.message });
    return { state, recoveryState, events, recoveries };
  }

  const resolved = resolveActiveTerminal(terminals, ref);

  if (resolved.found && resolved.method === "handle") {
    return { state, recoveryState, events, recoveries };
  }

  if (resolved.found && resolved.method === "title") {
    // ORCA restarted: same process, only the handle drifted. Relink the
    // checkpoint to the new handle; never trust/reuse the old one, but this
    // is not a crash - no resume prompt, no resend.
    const newState = projectStateSchema.parse({
      ...state,
      active_terminal: { ...ref, handle: resolved.terminal.handle },
      last_checkpoint: isoNow,
      updated_at: isoNow,
    });
    events.push({
      type: "terminal_relinked",
      role: ref.role,
      old_handle: ref.handle,
      new_handle: resolved.terminal.handle,
      candidate_count: resolved.candidateCount,
      ambiguous_title: resolved.ambiguous,
    });
    recoveries.push(`Relinked ${ref.role} terminal after ORCA restart (old=${ref.handle} new=${resolved.terminal.handle})`);
    await appendRecoveryLog(ctx.paths, state.active_run_id, {
      at: isoNow,
      reason: "orca_restart_relink",
      role: ref.role,
      old_terminal: ref.handle,
      new_terminal: resolved.terminal.handle,
    });
    return { state: newState, recoveryState, events, recoveries };
  }

  // Not found at all: a real crash. Gate rebuild attempts by the process
  // crash retry/backoff policy (max 3, 10/30/120s) - never an unbounded
  // rebuild loop.
  const crashKey = ref.role;
  const crashEntry = recoveryState.terminalCrashes[crashKey] ?? defaultRecoveryEntry();
  const nowMs = ctx.now();
  if (!canAttemptRecovery(crashEntry, nowMs)) {
    events.push({ type: "terminal_recovery_backoff", role: ref.role, next_retry_at: formatIso(crashEntry.nextRetryAtMs) });
    return { state, recoveryState, events, recoveries };
  }

  // Three automatic create attempts are the hard cap. The third failure's
  // 120-second cooldown is persisted; once it expires, escalate without a
  // fourth create call.
  if ((crashEntry.attempts ?? 0) >= PROCESS_CRASH_BACKOFF_MS.length) {
    const escalated = escalateToNeedsHuman(
      state,
      "REPEATED_TERMINAL_CRASH",
      `${ref.role} terminal failed to rebuild ${crashEntry.attempts} times`,
      isoNow
    );
    events.push({ type: "terminal_recovery_exhausted", role: ref.role, attempts: crashEntry.attempts });
    return { state: escalated, recoveryState, events, recoveries };
  }

  const checkpoint = await readDispatchCheckpoint(ctx.paths, state.active_run_id);
  if (!checkpoint || !checkpoint.roles?.[ref.role]) {
    const updatedEntry = recordRecoveryFailure(crashEntry, nowMs);
    const newRecoveryState = { ...recoveryState, terminalCrashes: { ...recoveryState.terminalCrashes, [crashKey]: updatedEntry } };
    events.push({ type: "terminal_recovery_checkpoint_missing", role: ref.role, run_id: state.active_run_id });
    if (updatedEntry.exhausted) {
      const escalated = escalateToNeedsHuman(
        state,
        "CHECKPOINT_MISSING",
        `no usable dispatch checkpoint for run ${state.active_run_id} role ${ref.role}`,
        isoNow
      );
      return { state: escalated, recoveryState: newRecoveryState, events, recoveries };
    }
    return { state, recoveryState: newRecoveryState, events, recoveries };
  }

  const roleSpec = checkpoint.roles[ref.role];
  const worktreePath = roleSpec.worktree ?? checkpoint.worktree;

  if (ref.role === "worker") {
    const gitStatus = await checkWorktreeGitStatus(worktreePath, { gitExec: ctx.gitExec });
    if (!gitStatus.exists) {
      const escalated = escalateToNeedsHuman(state, "CHECKPOINT_MISSING", `worktree missing: ${worktreePath}`, isoNow);
      events.push({ type: "terminal_recovery_worktree_missing", worktree: worktreePath });
      return { state: escalated, recoveryState, events, recoveries };
    }
    if (!gitStatus.clean) {
      await writeDirtyAttributionReport(ctx.paths, state.active_run_id, { worktreePath, gitStatus, isoNow });
      const escalated = escalateToNeedsHuman(state, "DIRTY_ATTRIBUTION_UNKNOWN", `uncommitted changes in ${worktreePath}`, isoNow);
      events.push({ type: "dirty_attribution_paused", worktree: worktreePath });
      return { state: escalated, recoveryState, events, recoveries };
    }
  }

  let created;
  try {
    created = await ctx.orca.createTerminal({ worktree: worktreePath, title: roleSpec.title, command: roleSpec.command });
  } catch (e) {
    const updatedEntry = recordRecoveryFailure(crashEntry, nowMs);
    const newRecoveryState = { ...recoveryState, terminalCrashes: { ...recoveryState.terminalCrashes, [crashKey]: updatedEntry } };
    events.push({ type: "terminal_create_failed", role: ref.role, error: e.message });
    if (updatedEntry.exhausted) {
      const escalated = escalateToNeedsHuman(
        state,
        "REPEATED_TERMINAL_CRASH",
        `${ref.role} terminal failed to rebuild ${updatedEntry.attempts} times`,
        isoNow
      );
      return { state: escalated, recoveryState: newRecoveryState, events, recoveries };
    }
    return { state, recoveryState: newRecoveryState, events, recoveries };
  }

  const newHandle = created.handle ?? created.terminal?.handle;
  const resumePrompt = buildResumePrompt(ref.role, state, { runId: state.active_run_id });
  try {
    await ctx.orca.sendTerminal({ handle: newHandle, text: resumePrompt, enter: true });
  } catch (e) {
    events.push({ type: "resume_prompt_send_failed", role: ref.role, error: e.message });
  }

  const newState = projectStateSchema.parse({
    ...state,
    active_terminal: { role: ref.role, handle: newHandle, title: roleSpec.title },
    last_checkpoint: isoNow,
    updated_at: isoNow,
  });
  const newRecoveryState = {
    ...recoveryState,
    terminalCrashes: { ...recoveryState.terminalCrashes, [crashKey]: recordRecoverySuccess() },
  };
  events.push({ type: "terminal_rebuilt", role: ref.role, old_handle: ref.handle ?? null, new_handle: newHandle });
  recoveries.push(`Rebuilt ${ref.role} terminal (old=${ref.handle ?? "none"} new=${newHandle}), delivered resume prompt`);
  await appendRecoveryLog(ctx.paths, state.active_run_id, {
    at: isoNow,
    reason: "terminal_rebuilt",
    role: ref.role,
    old_terminal: ref.handle ?? "none",
    new_terminal: newHandle,
  });

  return { state: newState, recoveryState: newRecoveryState, events, recoveries };
}

// ---------------------------------------------------------------------------
// §15 steps 10-11: watch durable reports, hand events to the Control Tower.
// Never resends a job, never judges DONE/NEEDS_DECISION/FAILED. A
// login_wall NEEDS_DECISION result is the one case escalated directly
// (§15 Chrome/CDP policy: login wall => NEEDS_HUMAN/AUTH_REQUIRED).
// ---------------------------------------------------------------------------

export async function scanDurableReports(ctx, state, isoNow) {
  const events = [];
  let authRequired = false;
  let authRequiredDetail = null;
  const cursor = await readReportCursor(ctx.paths);

  let runDirs = [];
  try {
    runDirs = await readdir(ctx.paths.runsDir);
  } catch {
    runDirs = [];
  }
  for (const runId of runDirs) {
    for (const [kind, file] of [
      ["worker", "worker_report.md"],
      ["reviewer", "reviewer_report.md"],
    ]) {
      const key = `${runId}:${kind}`;
      if (cursor.seenRuns.includes(key)) continue;
      if (await pathExists(path.join(ctx.paths.runsDir, runId, file))) {
        events.push({
          type: "durable_report",
          run_id: runId,
          report: kind,
          action: "control_tower_handoff_requested",
        });
        cursor.seenRuns.push(key);
      }
    }
  }

  let jobDirs = [];
  try {
    jobDirs = await readdir(ctx.paths.jobsDir);
  } catch {
    jobDirs = [];
  }
  for (const jobId of jobDirs) {
    if (cursor.seenJobs.includes(jobId)) continue;
    const resultPath = path.join(ctx.paths.jobsDir, jobId, "result.json");
    if (!(await pathExists(resultPath))) continue;
    let result;
    try {
      result = JSON.parse(await readFile(resultPath, "utf8"));
    } catch {
      continue;
    }
    events.push({ type: "job_result", job_id: jobId, state: result.state, detections: result.detections ?? [] });
    if (result.state === "FAILED" && (result.detections ?? []).includes("cdp_unreachable")) {
      let job = null;
      try {
        job = JSON.parse(await readFile(path.join(ctx.paths.jobsDir, jobId, "job.json"), "utf8"));
      } catch {
        job = null;
      }
      if (typeof job?.conversation_url === "string" && job.conversation_url.length > 0) {
        events.push({
          type: "browser_recovery_required",
          job_id: jobId,
          action: "start_approved_automation_chrome",
          conversation_url: job.conversation_url,
          resend: false,
          auto_login: false,
        });
      }
    }
    cursor.seenJobs.push(jobId);
    if (result.state === "NEEDS_DECISION" && (result.detections ?? []).includes("login_wall")) {
      authRequired = true;
      authRequiredDetail = `job ${jobId} hit a login wall`;
    }
  }

  await writeReportCursor(ctx.paths, cursor);
  return { events, authRequired, authRequiredDetail };
}

// ---------------------------------------------------------------------------
// Morning summary (§19) - update after every significant tick, at least
// every 30 minutes regardless.
// ---------------------------------------------------------------------------

async function maybeWriteMorningSummary(ctx, paths, { state, orcaStatus, recoveryState, isoNow, significant, recoveries }) {
  const nowMs = ctx.now();
  const last = recoveryState.lastSummaryAtMs;
  const shouldWrite = significant || last === null || nowMs - last >= MORNING_SUMMARY_MAX_INTERVAL_MS;
  if (!shouldWrite) return recoveryState;
  const data = await gatherMorningSummaryData(paths, {
    nowIso: isoNow,
    projectState: state,
    orca: orcaStatus,
    pid: ctx.pid,
    automaticRecoveries: recoveries,
  });
  await writeMorningSummary(paths, data);
  return { ...recoveryState, lastSummaryAtMs: nowMs };
}

// ---------------------------------------------------------------------------
// Main loop (§15 "Supervisor loop", steps 1-12)
// ---------------------------------------------------------------------------

function normalizeCtx(ctxIn) {
  const runtimeRoot = ctxIn.runtimeRoot;
  const env = ctxIn.env ?? process.env;
  const relay = ctxIn.relay ?? readRelayConfigFromEnv(env);
  return {
    runtimeRoot,
    paths: ctxIn.paths ?? resolveRuntimePaths(runtimeRoot),
    orca: ctxIn.orca,
    pid: ctxIn.pid ?? process.pid,
    now: ctxIn.now ?? (() => Date.now()),
    isAlive: ctxIn.isAlive ?? defaultIsAlive,
    gitExec: ctxIn.gitExec ?? defaultGitExec,
    sleep: ctxIn.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    maxIterations: ctxIn.maxIterations ?? Infinity,
    intervalMs: ctxIn.intervalMs ?? HEARTBEAT_INTERVAL_MS,
    mode: ctxIn.mode ?? env.GBB_SUPERVISOR_MODE ?? "legacy",
    relay,
    relayDeps: ctxIn.relayDeps ?? null,
    workerWorktree: ctxIn.workerWorktree ?? env.GBB_RELAY_WORKTREE ?? null,
    workerCommand: ctxIn.workerCommand ?? env.GBB_RELAY_WORKER_COMMAND ?? "opencode",
    cardId: ctxIn.cardId ?? env.GBB_RELAY_CARD_ID ?? null,
  };
}

function readRelayConfigFromEnv(env = process.env) {
  const repo = env.GBB_RELAY_REPO ?? null;
  const issue = env.GBB_RELAY_ISSUE ?? null;
  const pr = env.GBB_RELAY_PR ?? null;
  if (!repo || !issue || !pr) return null;
  const issueNum = Number(issue);
  const prNum = Number(pr);
  if (!Number.isInteger(issueNum) || !Number.isInteger(prNum)) return null;
  return { repo, issue: issueNum, pr: prNum };
}

// ---------------------------------------------------------------------------
// github_relay_v1 mode (§4): GitHub relay state is the single routing
// authority. This Supervisor is a deterministic executor only - it polls the
// relay kernel, hands the action to the actuator executor, and applies any ACK
// the executor produced back into relay state. It never judges
// PASS/FIX_REQUIRED itself, never writes code, never merges. Long executor
// waits (`pending`) never block one tick: the durable execution checkpoint
// carries the stage across ticks.
// ---------------------------------------------------------------------------

// Production default relay deps: real GitHub read/write via the `gh` CLI, a
// detached WebGPT actuator child process, and the same ORCA adapter the legacy
// loop uses. Every part is injectable for tests via `ctx.relayDeps`.
function defaultRelayDeps({ runtimeRoot, paths, orca, workerWorktree, workerCommand, cardId }) {
  const actuatorPath = process.env.GBB_WEBGPT_ACTUATOR ?? "C:\\Users\\Lupun\\AppData\\Local\\Temp\\opencode\\pw\\ct-web-review.mjs";
  return {
    fetchSnapshot: fetchSnapshotViaGh,
    postComment: postGitHubComment({ runtimeRoot }),
    webgpt: {
      dispatchReview: dispatchWebGPTReview({ actuatorPath, runtimeRoot }),
    },
    orca,
    worktree: workerWorktree ?? null,
    workerCommand: workerCommand ?? "opencode",
    cardId: cardId ?? null,
    checkpointPath: paths.relayExecutorState,
  };
}

function postGitHubComment({ runtimeRoot }) {
  return async function postComment({ repo, issue, body }) {
    const dir = path.join(runtimeRoot, "runs", "github_relay");
    await mkdir(dir, { recursive: true });
    const bodyFile = path.join(dir, `notification_${Date.now()}.txt`);
    await writeFile(bodyFile, body, "utf8");
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["api", "--method", "POST", `repos/${repo}/issues/${issue}/comments`, "-F", `body=@${bodyFile}`],
        { windowsHide: true, timeout: 60_000 }
      );
      const parsed = JSON.parse(stdout);
      if (!parsed || !Number.isInteger(parsed.id) || parsed.id <= 0) {
        throw new Error("gh api returned no positive comment id");
      }
      return { id: parsed.id };
    } finally {
      try {
        await import("node:fs/promises").then((fs) => fs.rm(bodyFile, { force: true }));
      } catch {
        // best effort cleanup
      }
    }
  };
}

function dispatchWebGPTReview({ actuatorPath, runtimeRoot }) {
  return async function dispatchReview({ prompt, repo, issue, pr, headSha }) {
    if (!existsSync(actuatorPath)) {
      throw new Error(`WEBGPT_FRESH_CONTEXT_ACTUATOR_NOT_REUSABLE: ${actuatorPath}`);
    }
    // Node --check gives a cheap deterministic "actuator is runnable" proof
    // before we detach a child (§9 adapter health).
    execFileSync(process.execPath, ["--check", actuatorPath], { windowsHide: true, stdio: "ignore" });
    const dir = path.join(runtimeRoot, "runs", "github_relay");
    await mkdir(dir, { recursive: true });
    const packPath = path.join(dir, `review_pack_${Date.now()}_${headSha?.slice(0, 8) ?? "x"}.txt`);
    const resultPath = path.join(dir, `review_result_${Date.now()}_${headSha?.slice(0, 8) ?? "x"}.json`);
    await writeFile(packPath, prompt, "utf8");
    const child = spawn(
      process.execPath,
      [actuatorPath, "--pack", packPath, "--result", resultPath, "--timeout-sec", "600"],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
    return {
      ok: true,
      conversation_url: null,
      pack_path: packPath,
      result_path: resultPath,
      pid: child.pid,
    };
  };
}

export async function runRelayStep(ctx, paths, { nowMs, isoNow }) {
  const tickEvents = [];
  const relay = ctx.relay;

  // Heartbeat first: liveness proof continues every tick, independent of
  // relay config or any long executor wait.
  await writeHeartbeat(paths, { pid: ctx.pid, isoNow, state: "github_relay_v1" });

  if (!relay) {
    tickEvents.push({ type: "relay_config_missing", detail: "GBB_RELAY_REPO/ISSUE/PR required" });
    await appendEvents(paths, tickEvents, isoNow);
    return { stop: false, at: isoNow, reason: "RELAY_CONFIG_MISSING", events: tickEvents };
  }

  const deps = ctx.relayDeps ?? defaultRelayDeps({
    runtimeRoot: ctx.runtimeRoot,
    paths,
    orca: ctx.orca,
    workerWorktree: ctx.workerWorktree,
    workerCommand: ctx.workerCommand,
    cardId: ctx.cardId,
  });
  // Injected deps may omit the checkpoint path; the executor always writes its
  // durable stage through deps.checkpointPath, so it must be deterministic.
  if (!deps.checkpointPath) deps.checkpointPath = paths.relayExecutorState;

  // 1) Poll the kernel: fetch snapshot, evaluate, apply decision (kernel
  // writes relay state). Transport failure becomes a terminal state here.
  let poll;
  try {
    poll = await runPoll({
      repo: relay.repo,
      issue: relay.issue,
      pr: relay.pr,
      statePath: paths.relayState,
      now: isoNow,
      fetchSnapshot: deps.fetchSnapshot,
    });
  } catch (e) {
    // Corrupt/missing relay state must fail closed, never crash the loop.
    tickEvents.push({ type: "relay_poll_failed", error: e.message });
    await appendEvents(paths, tickEvents, isoNow);
    return { stop: false, at: isoNow, reason: "RELAY_POLL_FAILED", error: e.message, events: tickEvents };
  }
  if (!poll.action) {
    tickEvents.push({ type: "relay_poll_failed", code: poll.code, error: poll.error });
    await appendEvents(paths, tickEvents, isoNow);
    return { stop: false, at: isoNow, reason: "RELAY_POLL_FAILED", error: poll.error, events: tickEvents };
  }

  // 2) Hand the action to the actuator executor (deterministic side effects;
  // returns `pending` instead of blocking on long waits).
  const relayState = await readStateFile(paths.relayState);
  let result;
  try {
    result = await executeAction({
      action: poll.action,
      relayState,
      deps,
      checkpointPath: paths.relayExecutorState,
      nowMs,
      nowIso: isoNow,
    });
  } catch (e) {
    // A corrupt executor checkpoint fails closed into an event; never crash
    // the tick and never trigger a side effect on an unreadable checkpoint.
    tickEvents.push({ type: "relay_executor_failed", error: e.message });
    await appendEvents(paths, tickEvents, isoNow);
    return { stop: false, at: isoNow, reason: "RELAY_EXECUTOR_FAILED", error: e.message, events: tickEvents };
  }

  // 3) If the executor produced an ACK, apply it into relay state. A failed
  // ACK never marks an event processed (kernel rule, preserved).
  if (result.ack) {
    const ackOut = applyAck(relayState, {
      actionId: result.ack.actionId,
      result: result.ack.result,
      reason: result.ack.reason ?? null,
      notificationCommentId: result.ack.notificationCommentId ?? null,
      now: isoNow,
    });
    if (ackOut.changed) {
      await writeStateFile(paths.relayState, ackOut.state);
    }
    tickEvents.push({ type: "relay_ack", status: ackOut.status, action: poll.action.action });
  }

  tickEvents.push({ type: "relay_executor", action: poll.action.action, status: result.status, reason: result.reason });
  if (Array.isArray(result.events)) tickEvents.push(...result.events);
  await appendEvents(paths, tickEvents, isoNow);

  return {
    stop: false,
    at: isoNow,
    reason: result.reason,
    status: result.status,
    action: poll.action.action,
    events: tickEvents,
  };
}

export async function runLoopOnce(ctxIn) {
  const ctx = normalizeCtx(ctxIn);
  const { paths } = ctx;
  await ensureRuntimeDirs(paths);
  const nowMs = ctx.now();
  const isoNow = formatIso(nowMs);
  const tickEvents = [];
  const recoveries = [];

  // Step 2: confirm/acquire lock ownership.
  const lock = await acquireOrConfirmLock(paths, { pid: ctx.pid, isAlive: ctx.isAlive, isoNow });
  if (!lock.owned) {
    return { stop: true, reason: "LOCK_NOT_OWNED", holder: lock.holder, at: isoNow };
  }

  // github_relay_v1 mode: GitHub relay state is the single routing authority.
  // Legacy project_state / static-board logic is bypassed entirely in this
  // mode (§4). The heartbeat continues every tick; long executor waits return
  // `pending` so one tick never blocks on a ten-minute WebGPT wait.
  if (ctx.mode === "github_relay_v1") {
    return runRelayStep(ctx, paths, { nowMs, isoNow });
  }

  // Step 3: read project state.
  const stateResult = await readProjectStateSafe(paths);

  // Step 1: heartbeat (written even when state is unreadable - the
  // heartbeat's only job is proving the process is alive).
  await writeHeartbeat(paths, { pid: ctx.pid, isoNow, state: stateResult.state?.state ?? "UNKNOWN" });

  if (!stateResult.ok) {
    tickEvents.push({ type: "supervisor_state_unreadable", detail: stateResult.error });
    await appendEvents(paths, tickEvents, isoNow);
    return { stop: false, at: isoNow, reason: "STATE_UNREADABLE" };
  }

  let state = stateResult.state;
  let recoveryState = await readRecoveryState(paths);

  // Step 5: ORCA health (always checked - needed for the morning summary
  // even once the project is in a stop state).
  const orcaEntry = recoveryState.orca;
  const unavailableElapsedMs = orcaEntry.unavailableSinceMs === null ? 0 : nowMs - orcaEntry.unavailableSinceMs;
  const retryDue = nowMs >= (orcaEntry.nextRetryAtMs ?? 0);
  const escalationProbeDue = orcaEntry.unavailableSinceMs !== null && unavailableElapsedMs >= ORCA_UNAVAILABLE_ESCALATE_MS;
  let orcaStatus;
  let orcaEval;
  if (!retryDue && !escalationProbeDue) {
    orcaStatus = { ok: false, state: "retry_backoff" };
    orcaEval = { ...orcaEntry, escalate: false };
  } else {
    orcaStatus = await ctx.orca.status();
    orcaEval = evaluateOrcaAvailability(orcaEntry, { ok: orcaStatus.ok, nowMs });
  }
  recoveryState = {
    ...recoveryState,
    orca: {
      unavailableSinceMs: orcaEval.unavailableSinceMs,
      attempts: orcaEval.attempts,
      nextRetryAtMs: orcaEval.nextRetryAtMs,
    },
  };
  if (orcaEval.escalate && !isStopState(state.state)) {
    state = escalateToNeedsHuman(
      state,
      "ORCA_UNAVAILABLE",
      `unreachable since ${formatIso(orcaEval.unavailableSinceMs)}`,
      isoNow
    );
    tickEvents.push({ type: "escalate_needs_human", reason: "ORCA_UNAVAILABLE" });
  }

  // Step 4 + steps 6-9: terminal health/recovery is "starting a new agent",
  // so it is skipped entirely once the project has reached a stop state.
  if (!isStopState(state.state) && orcaStatus.ok) {
    const recovery = await recoverActiveTerminal(ctx, state, recoveryState, isoNow);
    state = recovery.state;
    recoveryState = recovery.recoveryState;
    tickEvents.push(...recovery.events);
    recoveries.push(...recovery.recoveries);
  }

  // Steps 10-11: forward durable reports as events; never decide.
  const reportScan = await scanDurableReports(ctx, state, isoNow);
  tickEvents.push(...reportScan.events);
  if (reportScan.authRequired && !isStopState(state.state)) {
    state = escalateToNeedsHuman(state, "AUTH_REQUIRED", reportScan.authRequiredDetail, isoNow);
    tickEvents.push({ type: "escalate_needs_human", reason: "AUTH_REQUIRED" });
  }

  if (JSON.stringify(state) !== JSON.stringify(stateResult.state)) {
    await writeProjectState(paths, state);
  }

  recoveryState = await maybeWriteMorningSummary(ctx, paths, {
    state,
    orcaStatus,
    recoveryState,
    isoNow,
    significant: tickEvents.length > 0,
    recoveries,
  });
  await writeRecoveryState(paths, recoveryState);
  await appendEvents(paths, tickEvents, isoNow);

  return { stop: false, at: isoNow, projectState: state.state, events: tickEvents };
}

// Step 12 lives in what this function does NOT do: no code edits, no
// pass/rework verdicts. Drives runLoopOnce on an injectable interval;
// `maxIterations` lets tests run a bounded number of ticks with an instant
// fake `sleep` instead of a real 15s wait.
export async function runSupervisor(ctxIn) {
  const ctx = normalizeCtx(ctxIn);
  let i = 0;
  let lastOutcome = null;
  while (i < ctx.maxIterations) {
    lastOutcome = await runLoopOnce(ctx);
    i += 1;
    if (lastOutcome.stop) break;
    if (i < ctx.maxIterations) await ctx.sleep(ctx.intervalMs);
  }
  return { iterations: i, lastOutcome };
}

// ---------------------------------------------------------------------------
// Keep-awake lifecycle (§15 "Keep-awake": suppress on start, release on
// exit - Supervisor owns this, not the launching PowerShell script, so it
// still releases on Ctrl+C / SIGTERM / an uncaught crash's exit handler).
// ---------------------------------------------------------------------------

function keepAwakeScriptPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "keep-awake.ps1");
}

function runPowerShell(args) {
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { windowsHide: true }, () => resolve());
  });
}

function releaseKeepAwakeSync(scriptPath) {
  try {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Release"], {
      windowsHide: true,
      timeout: 5_000,
    });
  } catch {
    // best-effort on shutdown
  }
}

async function main() {
  const runtimeRoot = process.env.GBB_RUNTIME || "D:\\AIWORK_RUNTIME\\GPT_BROWSER_BRIDGE";
  const orcaPath = process.env.GBB_ORCA || resolveOrcaCli();
  const orca = new OrcaAdapter({ orcaPath });
  const scriptPath = keepAwakeScriptPath();

  console.log(`[boot] GBB supervisor starting (pid=${process.pid}) runtime=${runtimeRoot}`);
  await runPowerShell(["-File", scriptPath]);

  const shutdown = () => {
    releaseKeepAwakeSync(scriptPath);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => releaseKeepAwakeSync(scriptPath));

  const result = await runSupervisor({ runtimeRoot, orca });
  console.log(`[exit] GBB supervisor stopped: ${result.lastOutcome?.reason ?? "unknown"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
