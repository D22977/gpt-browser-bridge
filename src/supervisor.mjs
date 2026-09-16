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

import { readFile, appendFile, mkdir, stat, readdir, open } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import writeFileAtomic from "write-file-atomic";

import { projectStateSchema } from "./contracts.mjs";
import { OrcaAdapter, resolveOrcaCli, resolveActiveTerminal } from "./adapters/orca_adapter.mjs";
import {
  buildLogicalEventKey,
  classifyFutureConsumerBinding,
  deliverResumeOnce,
  findExistingDelivery,
  matchWaitToDecision,
  normalizeCurrentComments,
  parseControlDecision,
  validatePreSendAuthorityBinding,
  validateWaitTuple,
} from "./adapters/herdr_resume.mjs";
import { gatherMorningSummaryData, writeMorningSummary } from "./morning_summary.mjs";

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
    lock: path.join(root, "locks", "supervisor.lock"),
    sendLease: path.join(root, "locks", "supervisor.send"),
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

async function defaultIsAlive(pid, livenessExec = execFileAsync) {
  try {
    const { stdout } = await livenessExec("tasklist", ["/FI", `PID eq ${pid}`], { windowsHide: true });
    if (typeof stdout !== "string") return null;
    // Only tasklist's explicit no-task result proves that this PID is dead.
    if (/no tasks/i.test(stdout)) return false;
    if (stdout.includes(String(pid))) return true;
    return null;
  } catch {
    return null;
  }
}

function validLockRecord(record) {
  return Boolean(record && typeof record === "object" && !Array.isArray(record)
    && Number.isInteger(record.pid) && record.pid > 0
    && typeof record.at === "string" && record.at.length > 0
    && (record.host_id === undefined || (typeof record.host_id === "string" && record.host_id.length > 0))
    && record.fencing_handoff === undefined
    && (record.fence === undefined || (Number.isInteger(record.fence) && record.fence > 0))
    && (record.lease_expires_at === undefined
      || (typeof record.lease_expires_at === "string" && Number.isFinite(Date.parse(record.lease_expires_at)))));
}

function lockFence(record) {
  return Number.isInteger(record?.fence) && record.fence > 0 ? record.fence : 1;
}

function currentLeaseIsValid(record, isoNow) {
  if (record?.lease_expires_at === undefined) return true;
  const expiresAt = Date.parse(record.lease_expires_at);
  const currentAt = Date.parse(isoNow);
  return Number.isFinite(expiresAt) && Number.isFinite(currentAt) && expiresAt > currentAt;
}

async function readLockRecord(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false };
    return { present: true, error: new Error("LOCK_STATE_UNREADABLE") };
  }
  try {
    const record = JSON.parse(raw);
    if (!validLockRecord(record)) throw new Error("LOCK_RECORD_INVALID");
    return { present: true, record };
  } catch {
    return { present: true, error: new Error("LOCK_STATE_UNREADABLE") };
  }
}

async function createExclusiveJson(filePath, value) {
  let handle;
  try {
    handle = await open(filePath, "wx");
    await handle.writeFile(JSON.stringify(value));
    await handle.close();
    return { created: true };
  } catch (error) {
    try { await handle?.close(); } catch { /* preserve the original result */ }
    if (error?.code === "EEXIST") return { created: false };
    return { created: false, error };
  }
}

// Re-run every tick (not just at startup): if a live process other than us
// owns the lock, we stop rather than fight it (duplicate scheduler
// invocation). If nobody alive owns it (Supervisor was killed), stale
// takeover would require an identity-bound cleanup primitive that is not
// available here. Absent-lock acquisition uses an OS-level exclusive create.
// A live owner is never replaced by a second host; the monotonic fence plus
// the per-event physical send lease closes the prompt race without trusting
// self-authored handoffs.
export async function acquireOrConfirmLock(paths, { pid, hostId = null, authorizedHostIds = [], handoffToken = null, isAlive, isoNow }) {
  const guardPath = `${path.resolve(paths.lock)}.takeover`;
  if (!Number.isInteger(pid) || pid <= 0 || typeof isoNow !== "string" || !isoNow) {
    return { owned: false, holder: null, reason: "CONTROL_REQUIRED_LOCK_STATE_UNREADABLE" };
  }
  const newRecord = { pid, at: isoNow, fence: 1, ...(hostId ? { host_id: hostId } : {}) };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const guardState = await readLockRecord(guardPath);
    if (guardState.error) return { owned: false, holder: null, reason: "CONTROL_REQUIRED_LOCK_STATE_UNREADABLE" };
    if (guardState.present) {
      const guard = guardState.record;
      const sameHostGuard = typeof guard.host_id === "string" && guard.host_id.length > 0
        && typeof hostId === "string" && hostId.length > 0
        && guard.host_id === hostId;
      if (!sameHostGuard) {
        return { owned: false, holder: guard.pid, reason: "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN" };
      }
      if (guard.pid === pid) {
        return { owned: false, holder: guard.pid, reason: "LOCK_ACQUIRE_IN_FLIGHT" };
      }
      let guardLive;
      try {
        guardLive = typeof isAlive === "function" ? await isAlive(guard.pid) : null;
      } catch {
        return { owned: false, holder: guard.pid, reason: "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN" };
      }
      if (guardLive !== false) {
        return {
          owned: false,
          holder: guard.pid,
          reason: guardLive === true ? "LOCK_ACQUIRE_IN_FLIGHT" : "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN",
        };
      }
      return { owned: false, holder: guard.pid, reason: "CONTROL_REQUIRED_TAKEOVER_GUARD_CLEANUP_UNPROVEN" };
    }

    const state = await readLockRecord(paths.lock);
    if (state.error) return { owned: false, holder: null, reason: "CONTROL_REQUIRED_LOCK_STATE_UNREADABLE" };
    if (!state.present) {
      const created = await createExclusiveJson(paths.lock, newRecord);
      if (created.error) return { owned: false, holder: null, reason: "CONTROL_REQUIRED_LOCK_STATE_UNREADABLE" };
      if (created.created) return { owned: true, holder: pid, fence: newRecord.fence };
      continue;
    }

    const current = state.record;
    const currentHostId = current.host_id ?? null;
    const requestedHostId = hostId ?? null;
    const hostMismatch = currentHostId !== requestedHostId;
    const authorizedSecondHost = Boolean(currentHostId && requestedHostId && hostMismatch && authorizedHostIds.includes(requestedHostId));
    if (hostMismatch && !authorizedSecondHost) {
      return {
        owned: false,
        holder: current.pid,
        reason: currentHostId && requestedHostId ? "HOST_IDENTITY_REJECTED" : "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN",
      };
    }
    if (authorizedSecondHost) {
      let liveOwner;
      try {
        liveOwner = typeof isAlive === "function" ? await isAlive(current.pid) : null;
      } catch {
        return { owned: false, holder: current.pid, reason: "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN" };
      }
      if (!liveOwner) {
        return { owned: false, holder: current.pid, reason: "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN" };
      }
      return { owned: false, holder: current.pid, reason: "CONTROL_REQUIRED_LIVE_OWNER_UNFENCED" };
    }
    if (current.pid === pid) {
      if (!currentLeaseIsValid(current, isoNow)) {
        return { owned: false, holder: pid, reason: "CONTROL_REQUIRED_FENCING_REVALIDATION_FAILED" };
      }
      const refreshed = {
        ...newRecord,
        fence: lockFence(current),
        ...(current.lease_expires_at ? { lease_expires_at: current.lease_expires_at } : {}),
      };
      await writeFileAtomic(paths.lock, JSON.stringify(refreshed));
      return { owned: true, holder: pid, fence: refreshed.fence };
    }
    let liveOwner;
    try {
      liveOwner = typeof isAlive === "function" ? await isAlive(current.pid) : null;
    } catch {
      return { owned: false, holder: current.pid, reason: "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN" };
    }
    if (liveOwner === null) {
      return { owned: false, holder: current.pid, reason: "CONTROL_REQUIRED_CROSS_HOST_LIVENESS_UNPROVEN" };
    }
    if (liveOwner) {
      return { owned: false, holder: current.pid };
    }
    return { owned: false, holder: current.pid, reason: "CONTROL_REQUIRED_TAKEOVER_GUARD_CLEANUP_UNPROVEN" };
  }
  return { owned: false, holder: null, reason: "LOCK_ACQUIRE_RACE_UNRESOLVED" };
}

export async function confirmLockOwnership(paths, { pid, hostId = null, handoffToken = null, fence = null, isoNow }) {
  if (typeof isoNow !== "string" || !isoNow || !Number.isFinite(Date.parse(isoNow))) {
    return { owned: false, holder: pid, reason: "CONTROL_REQUIRED_FENCING_REVALIDATION_FAILED" };
  }
  const state = await readLockRecord(paths.lock);
  if (state.error) return { owned: false, holder: null, reason: "CONTROL_REQUIRED_LOCK_STATE_UNREADABLE" };
  if (!state.present) return { owned: false, holder: null, reason: "LOCK_NOT_OWNED" };
  if (state.record.pid !== pid || (state.record.host_id ?? null) !== (hostId ?? null)) {
    return { owned: false, holder: state.record.pid, reason: "LOCK_NOT_OWNED" };
  }
  if (fence !== null && (!Number.isInteger(fence) || fence !== lockFence(state.record))) {
    return { owned: false, holder: pid, reason: "CONTROL_REQUIRED_FENCE_CHANGED" };
  }
  if (!currentLeaseIsValid(state.record, isoNow)) {
    return { owned: false, holder: pid, reason: "CONTROL_REQUIRED_FENCING_REVALIDATION_FAILED" };
  }
  return { owned: true, holder: pid, fence: lockFence(state.record) };
}

async function releasePhysicalSendLease(leasePath, record) {
  try {
    const raw = await readFile(leasePath, "utf8");
    if (raw === JSON.stringify(record)) await unlink(leasePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function claimPhysicalSendLease(paths, { pid, hostId = null, fence, logicalKey, nowMs }) {
  const readNowMs = typeof nowMs === "function" ? nowMs : () => nowMs;
  let firstNowMs;
  try { firstNowMs = readNowMs(); } catch { firstNowMs = Number.NaN; }
  if (!Number.isInteger(fence) || fence <= 0 || typeof logicalKey !== "string" || !logicalKey || !Number.isFinite(firstNowMs)) {
    return { allow: false, decision: "CONTROL_REQUIRED", reason: "CONTROL_REQUIRED_FENCE_CHANGED" };
  }
  const isoNow = formatIso(firstNowMs);
  const state = await readLockRecord(paths.lock);
  if (state.error) return { allow: false, decision: "CONTROL_REQUIRED", reason: "CONTROL_REQUIRED_LOCK_STATE_UNREADABLE" };
  if (!state.present || state.record.pid !== pid || (state.record.host_id ?? null) !== (hostId ?? null)) {
    return { allow: false, decision: "CONTROL_REQUIRED", reason: "LOCK_NOT_OWNED" };
  }
  if (lockFence(state.record) !== fence) {
    return { allow: false, decision: "CONTROL_REQUIRED", reason: "CONTROL_REQUIRED_FENCE_CHANGED" };
  }
  if (!currentLeaseIsValid(state.record, isoNow)) {
    return { allow: false, decision: "CONTROL_REQUIRED", reason: "CONTROL_REQUIRED_FENCING_REVALIDATION_FAILED" };
  }
  const leaseKey = Buffer.from(logicalKey).toString("base64url");
  const leasePath = `${paths.sendLease ?? `${paths.lock}.send`}.${leaseKey}`;
  const lease = { pid, host_id: hostId, fence, logical_event_key: logicalKey, at: isoNow };
  const created = await createExclusiveJson(leasePath, lease);
  if (created.error) return { allow: false, decision: "CONTROL_REQUIRED", reason: "CONTROL_REQUIRED_PHYSICAL_SEND_LEASE_UNREADABLE" };
  if (!created.created) return { allow: false, decision: "CONTROL_REQUIRED", reason: "CONTROL_REQUIRED_PHYSICAL_SEND_LEASE_HELD" };

  let finalNowMs;
  try { finalNowMs = readNowMs(); } catch { finalNowMs = Number.NaN; }
  const reread = await readLockRecord(paths.lock);
  if (!Number.isFinite(finalNowMs) || reread.error || !reread.present || reread.record.pid !== pid || (reread.record.host_id ?? null) !== (hostId ?? null) || lockFence(reread.record) !== fence || !currentLeaseIsValid(reread.record, formatIso(finalNowMs))) {
    await releasePhysicalSendLease(leasePath, lease);
    return { allow: false, decision: "CONTROL_REQUIRED", reason: "CONTROL_REQUIRED_FENCE_CHANGED" };
  }
  return { allow: true, release: async () => releasePhysicalSendLease(leasePath, lease) };
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
    residentConsumer: null,
    lastSummaryAtMs: null,
  };
}

export async function readRecoveryState(paths) {
  try {
    const raw = JSON.parse(await readFile(paths.recoveryState, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("RECOVERY_STATE_NOT_OBJECT");
    if (raw.residentConsumer !== null && raw.residentConsumer !== undefined && (typeof raw.residentConsumer !== "object" || Array.isArray(raw.residentConsumer))) {
      throw new Error("RECOVERY_STATE_RESIDENT_CONSUMER_INVALID");
    }
    const defaults = defaultRecoveryState();
    return { ...defaults, ...raw, orca: { ...defaults.orca, ...raw.orca } };
  } catch (error) {
    if (error?.code === "ENOENT") return defaultRecoveryState();
    return {
      ...defaultRecoveryState(),
      control_required: true,
      recovery_state_error: String(error?.message ?? error),
    };
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

export async function recoverActiveTerminal(ctx, state, recoveryState, isoNow) {
  const events = [];
  const recoveries = [];
  const ref = state.active_terminal;
  if (!ref) return { state, recoveryState, events, recoveries };

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

function authorityFingerprint(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

// The Supervisor is only a resident transport loop. It rereads the durable
// GitHub decision and delivery comments, delegates exact physical admission to
// the adapter, and records transport outcomes. It never interprets the
// decision as semantic Control authority.
export async function runResumeDeliveryCheck(ctx, {
  isoNow = new Date().toISOString(),
  deliveryState = null,
  persistDeliveryState = null,
  revalidateOwnership = null,
  claimPhysicalSend = null,
} = {}) {
  const cfg = ctx?.resumeDelivery;
  if (!cfg) return { events: [], delivered: false, duplicate: false };
  const ownershipRevalidator = revalidateOwnership ?? cfg.revalidateOwnership;
  const events = [];
  const consumer = classifyFutureConsumerBinding(cfg.futureConsumerBinding);
  if (!consumer.bound) {
    events.push({ type: "resume_delivery_future_consumer_binding_missing", reason: consumer.state });
    return { events, delivered: false, duplicate: false, reason: consumer.state };
  }

  if (typeof cfg.readAuthority !== "function") {
    const reason = "CONTROL_REQUIRED_AUTHORITY_READER_MISSING";
    events.push({ type: "resume_delivery_authority_reader_missing", reason });
    return { events, delivered: false, duplicate: false, reason };
  }
  if (typeof cfg.readComments !== "function") {
    const reason = "CONTROL_REQUIRED_COMMENTS_READER_MISSING";
    events.push({ type: "resume_delivery_comments_reader_missing", reason });
    return { events, delivered: false, duplicate: false, reason };
  }

  let initialAuthority = null;
  try {
    initialAuthority = await cfg.readAuthority({ phase: "start" });
  } catch (error) {
    const reason = "CONTROL_REQUIRED_AUTHORITY_READ_FAILED";
    events.push({ type: "resume_delivery_authority_read_failed", reason, error: String(error?.message ?? error) });
    return { events, delivered: false, duplicate: false, reason };
  }
  if (initialAuthority?.ok === false) {
    const reason = initialAuthority.reason ?? "CONTROL_REQUIRED_AUTHORITY_READ_FAILED";
    events.push({ type: "resume_delivery_authority_rejected", reason });
    return { events, delivered: false, duplicate: false, reason };
  }
  const authority = initialAuthority?.value ?? initialAuthority ?? {};
  const initialBindingCheck = validatePreSendAuthorityBinding(authority.binding, authority.binding);
  if (!initialBindingCheck.ok) {
    const reason = `CONTROL_REQUIRED_${initialBindingCheck.reason}`;
    events.push({ type: "resume_delivery_authority_binding_invalid", reason });
    return { events, delivered: false, duplicate: false, reason };
  }
  const waitTuple = authority.waitTuple ?? cfg.waitTuple;
  const tupleCheck = validateWaitTuple(waitTuple);
  if (!tupleCheck.ok) {
    events.push({ type: "resume_delivery_wait_tuple_invalid", reason: "INVALID_WAIT_TUPLE", errors: tupleCheck.errors });
    return { events, delivered: false, duplicate: false, reason: "INVALID_WAIT_TUPLE" };
  }

  let decisionBody;
  try {
    decisionBody = authority.decisionBody ?? (cfg.readDecisionBody
      ? await cfg.readDecisionBody({ sourceTerminalReceipt: tupleCheck.waitTuple.source_terminal_receipt, waitTuple: tupleCheck.waitTuple })
      : cfg.decisionBody);
  } catch (error) {
    const reason = "CONTROL_REQUIRED_DECISION_READ_FAILED";
    events.push({ type: "resume_delivery_decision_read_failed", reason, error: String(error?.message ?? error) });
    return { events, delivered: false, duplicate: false, reason };
  }
  const parsed = parseControlDecision(decisionBody);
  const matched = matchWaitToDecision(tupleCheck.waitTuple, parsed);
  if (!matched.ok) {
    events.push({ type: "resume_delivery_decision_not_applicable", reason: matched.reason });
    return { events, delivered: false, duplicate: false, reason: matched.reason };
  }

  let comments;
  try {
    comments = normalizeCurrentComments(await cfg.readComments({ waitTuple: tupleCheck.waitTuple, decision: parsed.decision, phase: "initial" }));
  } catch (error) {
    const reason = "CONTROL_REQUIRED_COMMENTS_READ_FAILED";
    events.push({ type: "resume_delivery_comments_read_failed", reason, error: String(error?.message ?? error) });
    return { events, delivered: false, duplicate: false, reason };
  }
  const logicalKey = buildLogicalEventKey(tupleCheck.waitTuple, parsed);
  const existing = findExistingDelivery(comments, logicalKey, cfg.protocol);
  if (existing) {
    events.push({ type: "resume_delivery_duplicate", decision: "NO_OP_DUPLICATE", receipt_id: existing.receipt_id });
    return { events, delivered: false, duplicate: true, reason: "NO_OP_DUPLICATE" };
  }

  const persist = persistDeliveryState ?? cfg.persistDeliveryState;
  const timedQuotaState = cfg.timedQuotaState ?? (deliveryState?.wake_at ? deliveryState : null);
  const startingFingerprint = authorityFingerprint(authority.fingerprint ?? authority.binding ?? null);
  const beforeSend = async (details) => {
    try {
      const latestRaw = await cfg.readAuthority({ phase: "before_send", logicalKey: details.logicalKey });
      if (latestRaw?.ok === false) return { allow: false, decision: "CONTROL_REQUIRED", reason: latestRaw.reason ?? "CONTROL_REQUIRED_AUTHORITY_REVALIDATION_FAILED" };
      const latest = latestRaw?.value ?? latestRaw ?? {};
      const initialBinding = authority.binding;
      const latestBinding = latest.binding;
      const bindingCheck = validatePreSendAuthorityBinding(initialBinding, latestBinding);
      if (!bindingCheck.ok) return { allow: false, decision: "CONTROL_REQUIRED", reason: bindingCheck.reason };
      const latestFingerprint = authorityFingerprint(latest.fingerprint ?? latest.binding ?? null);
      if (startingFingerprint !== null && latestFingerprint !== startingFingerprint) return { allow: false, decision: "CONTROL_REQUIRED", reason: "AUTHORITY_CHANGED" };
      const latestComments = normalizeCurrentComments(await cfg.readComments({ waitTuple: tupleCheck.waitTuple, decision: parsed.decision, logicalKey: details.logicalKey, phase: "before_send" }));
      const duplicate = findExistingDelivery(latestComments, details.logicalKey, cfg.protocol);
      if (duplicate) return { allow: false, decision: "NO_OP_DUPLICATE", reason: "NO_OP_DUPLICATE" };
      if (typeof ownershipRevalidator === "function") {
        const ownership = await ownershipRevalidator({ logicalKey: details.logicalKey, waitTuple: details.waitTuple });
        if (!ownership?.owned) return { allow: false, decision: "CONTROL_REQUIRED", reason: ownership?.reason ?? "CONTROL_REQUIRED_LOCK_NOT_OWNED" };
      }
    } catch (error) {
      return { allow: false, decision: "CONTROL_REQUIRED", reason: "CONTROL_REQUIRED_AUTHORITY_REVALIDATION_FAILED", error: String(error?.message ?? error) };
    }
    return { allow: true };
  };
  const beforePhysicalSend = async (details) => {
    const gate = await beforeSend(details);
    if (!gate.allow) return gate;
    if (cfg.herdr?.physicalPromptBoundary === true && typeof claimPhysicalSend !== "function") {
      return { allow: false, decision: "CONTROL_REQUIRED", reason: "CONTROL_REQUIRED_PHYSICAL_SEND_LEASE_BINDING_MISSING" };
    }
    if (typeof claimPhysicalSend !== "function") return gate;
    try {
      const claim = await claimPhysicalSend(details);
      if (claim?.allow === false) return claim;
      return { allow: true, release: claim?.release };
    } catch (error) {
      return { allow: false, decision: "CONTROL_REQUIRED", reason: "CONTROL_REQUIRED_PHYSICAL_SEND_LEASE_UNREADABLE", error: String(error?.message ?? error) };
    }
  };

  try {
    const result = await deliverResumeOnce({
      waitTuple: tupleCheck.waitTuple,
      decisionBody,
      comments,
      herdr: cfg.herdr,
      publishReceipt: cfg.publishReceipt,
      protocol: cfg.protocol,
      now: () => isoNow,
      deliveryState,
      timedQuotaState,
      quotaRoutePolicy: cfg.quotaRoutePolicy,
      consumerHostId: cfg.consumerHostId,
      authorizedHostIds: cfg.authorizedHostIds,
      persistDeliveryState: persist,
      beforeSend,
      beforePhysicalSend,
    });
    if (result.decision === "DELIVERED") {
      events.push({
        type: "resume_delivery_delivered",
        decision: result.decision,
        logical_event_key: result.logical_key,
        receipt_id: result.receipt_id,
        target: {
          herdr_workspace_id: result.receipt.target_herdr_workspace_id,
          herdr_pane_id: result.receipt.target_herdr_pane_id,
          herdr_agent_session: result.receipt.target_herdr_agent_session,
        },
      });
      return { events, delivered: true, duplicate: false, receipt: result.receipt, state: result.receipt };
    }
    if (result.decision === "NO_OP_DUPLICATE") {
      events.push({ type: "resume_delivery_duplicate", decision: result.decision, receipt_id: result.existing_receipt_id ?? null });
      return { events, delivered: false, duplicate: true, reason: result.decision };
    }
    if (result.decision === "NO_BLIND_RETRY") {
      events.push({ type: "resume_delivery_no_blind_retry", decision: result.decision, logical_event_key: result.logical_key, receipt_id: result.receipt_id ?? null });
      return { events, delivered: false, duplicate: false, noBlindRetry: true, reason: result.decision };
    }
    if (result.decision === "WAIT_UNTIL_WAKE") {
      events.push({ type: "resume_delivery_waiting", decision: result.decision, logical_event_key: result.logical_key, wake_at: result.wake_at, wake_at_ms: result.wake_at_ms, reason: result.decision });
      return { events, delivered: false, duplicate: false, reason: result.decision, wake_at: result.wake_at, wake_at_ms: result.wake_at_ms };
    }
    if (result.decision === "RETRY_SCHEDULED") {
      events.push({ type: "resume_delivery_retry_scheduled", decision: result.decision, logical_event_key: result.logical_key, wake_at: result.state?.wake_at, wake_at_ms: result.state?.wake_at_ms });
      return { events, delivered: false, duplicate: false, reason: result.decision, state: result.state };
    }
    if (result.decision === "CONTROL_REQUIRED") {
      events.push({ type: "resume_delivery_control_required", decision: result.decision, logical_event_key: result.logical_key, reason: result.reason });
      return { events, delivered: false, duplicate: false, reason: result.reason ?? result.decision };
    }
    events.push({ type: "resume_delivery_rejected", decision: result.decision, reason: result.reason });
    return { events, delivered: false, duplicate: false, reason: result.reason ?? result.decision };
  } catch (error) {
    const reason = "CONTROL_REQUIRED_RESUME_DELIVERY_FAILED";
    events.push({ type: "resume_delivery_failed", reason, error: String(error?.message ?? error) });
    return { events, delivered: false, duplicate: false, reason };
  }
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
// Execution Registry / Admission (non-authoritative layer over Supervisor)
// ---------------------------------------------------------------------------

import {
  MAX_WORKERS,
  MAX_REVIEWERS,
  MAX_WRITERS_PER_REF,
  registryEntrySchema,
  ALLOWED_TRANSITIONS,
  currentAuthoritySchema,
} from "./contracts.mjs";

export function createRegistry() {
  return { entries: {} };
}

// ---------------------------------------------------------------------------
// Path / ref / worktree canonicalization (F4/F5)
// ---------------------------------------------------------------------------

// Normalize a repo-relative path: forward slashes only, collapse repeated
// separators, reject traversal and absolute forms.  Returns the canonical
// form or null for inputs that cannot be valid repo-relative paths.
export function canonicalizeRepoRelativePath(p) {
  if (typeof p !== "string" || p.length === 0) return null;
  // Reject absolute paths (drive letters, UNC, bare leading slash)
  if (/^(?:[A-Za-z]:|\\\\|\/)/.test(p)) return null;
  // Normalize to forward slashes, collapse repeated
  let normalized = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  // Remove leading ./ segments
  normalized = normalized.replace(/^\.\//, "");
  // Reject any remaining traversal
  if (/\.\./.test(normalized)) return null;
  // Reject bare "." which is not a valid allowlist path
  if (normalized === ".") return null;
  // Remove trailing slash unless it's the root "."
  normalized = normalized.replace(/\/$/, "") || ".";
  return normalized.toLowerCase();
}

// Canonical ref: lower-cased, must be a valid refs/ path or exact 40-hex SHA.
export function canonicalizeRef(ref) {
  if (typeof ref !== "string") return null;
  const lower = ref.toLowerCase().trim();
  if (/^refs\/[^\s]+$/.test(lower)) return lower;
  if (/^[0-9a-f]{40}$/.test(lower)) return lower;
  return null;
}

// Canonical worktree: forward-slash normalized, lower-cased, no trailing slash, no repeated separators.
export function canonicalizeWorktree(wt) {
  if (typeof wt !== "string" || wt.length === 0) return null;
  return wt.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
}

// Check if two allowlist path sets have any overlapping entry.
// Paths are first canonicalized. Two paths overlap when either is a
// prefix of the other (normalized with trailing slash) or they are equal.
// F5: fail-closed - reject any path that cannot be canonicalized.
export function checkPathOverlap(pathsA, pathsB) {
  const canonA = pathsA.map(canonicalizeRepoRelativePath);
  const canonB = pathsB.map(canonicalizeRepoRelativePath);
  // Fail-closed: if any path is invalid (null), treat as overlap
  if (canonA.includes(null) || canonB.includes(null)) return true;
  for (const a of canonA) {
    const normA = a.endsWith("/") ? a : `${a}/`;
    for (const b of canonB) {
      const normB = b.endsWith("/") ? b : `${b}/`;
      if (a === b || normA.startsWith(normB) || normB.startsWith(normA)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Canonical admission validator (shared by admitEntry and reconstructRegistry)
// ---------------------------------------------------------------------------

// Validate a single entry against the current registry and authority context.
// Returns {ok, reason?}.  `existingCardIds` is the set of card_ids already
// admitted or expected from durable receipts.
export function validateEntryAdmission(registry, entry, existingCardIds) {
  const { card_id, role, ref, generation, allowlist_paths, worktree, fence, fence_id, lease_id } = entry;

  if (registry.entries[card_id]) {
    if (registry.entries[card_id].generation !== generation) {
      return { ok: false, reason: `GENERATION_MISMATCH: ${card_id}` };
    }
    return { ok: false, reason: `ALREADY_ADMITTED: ${card_id}` };
  }

  // Reject entries whose card_id was already seen during reconstruction
  if (existingCardIds.has(card_id)) {
    return { ok: false, reason: `DUPLICATE_CARD: ${card_id}` };
  }

  const activeEntries = Object.values(registry.entries).filter(
    (e) => e.state !== "RELEASED"
  );

  if (role === "worker") {
    const activeWorkers = activeEntries.filter((e) => e.role === "worker");
    if (activeWorkers.length >= MAX_WORKERS) {
      return { ok: false, reason: `MAX_WORKERS: limit ${MAX_WORKERS} reached` };
    }
    // Same-ref writer limit (canonical ref comparison - F5)
    const canonRef = canonicalizeRef(ref);
    if (!canonRef) {
      return { ok: false, reason: `INVALID_REF: ${ref}` };
    }
    const sameRefWriters = activeWorkers.filter((e) => canonicalizeRef(e.ref) === canonRef);
    if (sameRefWriters.length >= MAX_WRITERS_PER_REF) {
      return { ok: false, reason: `MAX_WRITERS_PER_REF: ref ${ref} already has a writer` };
    }
    // Distinct canonical worktrees required for workers (F5)
    const canonWt = canonicalizeWorktree(worktree);
    if (!canonWt) {
      return { ok: false, reason: `INVALID_WORKTREE: ${worktree}` };
    }
    for (const other of activeWorkers) {
      if (canonicalizeRef(other.ref) === canonRef) continue;
      const otherWt = canonicalizeWorktree(other.worktree);
      if (canonWt === otherWt) {
        return { ok: false, reason: `SAME_WORKTREE: ${card_id} shares worktree with ${other.card_id}` };
      }
      if (checkPathOverlap(allowlist_paths, other.allowlist_paths)) {
        return { ok: false, reason: `OVERLAPPING_PATHS: ${card_id} overlaps with ${other.card_id}` };
      }
    }
  } else if (role === "reviewer") {
    const activeReviewers = activeEntries.filter((e) => e.role === "reviewer");
    if (activeReviewers.length >= MAX_REVIEWERS) {
      return { ok: false, reason: `MAX_REVIEWERS: limit ${MAX_REVIEWERS} reached` };
    }
  }

  // Fence must match current authority fence
  if (fence_id && registry.currentFenceId && fence_id !== registry.currentFenceId) {
    return { ok: false, reason: `FENCE_MISMATCH: ${card_id}` };
  }
  // Lease must be present and non-empty
  if (!lease_id) {
    return { ok: false, reason: `LEASE_MISSING: ${card_id}` };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Admission gate: validates slot limits, ref uniqueness, path disjointness,
// generation binding, and duplicate card_id. Returns {ok, reason?}.
// ---------------------------------------------------------------------------

export function admitEntry(registry, rawEntry, isoNow) {
  const parsed = registryEntrySchema.parse(rawEntry);
  const validation = validateEntryAdmission(registry, parsed, new Set());
  if (!validation.ok) return validation;

  registry.entries[parsed.card_id] = { ...parsed, state: "ADMITTED", heartbeat_at: parsed.heartbeat_at || isoNow };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Heartbeat: bound to exact process/session/fence ownership proof (F3)
// ---------------------------------------------------------------------------

export function heartbeatEntry(registry, cardId, { isoNow, pid, fence, fence_id } = {}) {
  if (!registry.entries[cardId]) return false;
  const entry = registry.entries[cardId];
  // F3: Heartbeat REQUIRES exact process, fence, and fence_id ownership proof
  if (pid === undefined || entry.process.pid !== pid) return false;
  if (fence === undefined || entry.fence !== fence) return false;
  if (fence_id === undefined || entry.fence_id !== fence_id) return false;
  // F3: Validate lease is still current
  if (entry.lease_expiry) {
    const expiryMs = Date.parse(entry.lease_expiry);
    const nowMs = Date.parse(isoNow);
    if (Number.isFinite(expiryMs) && Number.isFinite(nowMs) && expiryMs <= nowMs) return false;
  }
  registry.entries[cardId] = { ...entry, heartbeat_at: isoNow };
  return true;
}

// ---------------------------------------------------------------------------
// State machine: explicit allowed transitions only (F4)
// ---------------------------------------------------------------------------

// Reclassify entry state with explicit transition validation.
// Only allowed transitions from ALLOWED_TRANSITIONS are accepted.
// F3: State mutation REQUIRES exact process/fence/fence_id ownership proof.
export function reclassifyEntry(registry, cardId, newState, { pid, fence, fence_id, isoNow } = {}) {
  if (!registry.entries[cardId]) return { ok: false, reason: "ENTRY_NOT_FOUND" };
  const entry = registry.entries[cardId];
  const allowed = ALLOWED_TRANSITIONS[entry.state];
  if (!allowed || !allowed.includes(newState)) {
    return { ok: false, reason: `INVALID_TRANSITION: ${entry.state} -> ${newState}` };
  }
  // F3: State mutation REQUIRES ownership proof - never optional
  if (pid === undefined || entry.process.pid !== pid) {
    return { ok: false, reason: "PID_MISMATCH" };
  }
  if (fence === undefined || entry.fence !== fence) {
    return { ok: false, reason: "FENCE_MISMATCH" };
  }
  if (fence_id === undefined || entry.fence_id !== fence_id) {
    return { ok: false, reason: "FENCE_ID_MISMATCH" };
  }
  // For RELEASED transition, additionally validate lease expiry (F4)
  if (newState === "RELEASED") {
    if (entry.lease_expiry) {
      const expiryMs = Date.parse(entry.lease_expiry);
      const nowMs = Date.parse(isoNow ?? new Date().toISOString());
      if (Number.isFinite(expiryMs) && Number.isFinite(nowMs) && expiryMs > nowMs) {
        return { ok: false, reason: "LEASE_NOT_EXPIRED: cannot release before lease expiry" };
      }
    }
  }
  registry.entries[cardId] = { ...entry, state: newState };
  return { ok: true };
}

// Find entries whose heartbeat is older than nowMs - staleThresholdMs.
export function findExpiredEntries(registry, nowMs, staleThresholdMs) {
  const expired = [];
  for (const [cardId, entry] of Object.entries(registry.entries)) {
    if (entry.state === "RELEASED") continue;
    const heartbeatMs = Date.parse(entry.heartbeat_at);
    if (Number.isFinite(heartbeatMs) && nowMs - heartbeatMs > staleThresholdMs) {
      expired.push(cardId);
    }
  }
  return expired;
}

// ---------------------------------------------------------------------------
// Reconstruction: join durable receipts + independently verified live
// observations; reject duplicates/conflicts; re-run canonical validator;
// never refresh heartbeat merely by reconstruction (F2).
// ---------------------------------------------------------------------------

// F2: Reconstruct from a joined set of durable authority receipts and
// independently verified live process/session observations on the exact
// identity tuple. Reject missing/duplicate/conflicting sides.
export function reconstructFromAuthorityAndObservations(durableReceipts, liveObservations, { currentFenceId = null } = {}) {
  const fresh = createRegistry();
  fresh.currentFenceId = currentFenceId;

  // Index durable receipts by card_id
  const receiptMap = new Map();
  for (const receipt of durableReceipts) {
    const parsed = registryEntrySchema.parse(receipt);
    if (receiptMap.has(parsed.card_id)) {
      return { ok: false, reason: `DUPLICATE_DURABLE_RECEIPT: ${parsed.card_id}`, entries: fresh.entries };
    }
    receiptMap.set(parsed.card_id, parsed);
  }

  // Index live observations by card_id
  const liveMap = new Map();
  for (const obs of liveObservations) {
    const parsed = registryEntrySchema.parse(obs);
    if (liveMap.has(parsed.card_id)) {
      return { ok: false, reason: `DUPLICATE_LIVE_OBSERVATION: ${parsed.card_id}`, entries: fresh.entries };
    }
    liveMap.set(parsed.card_id, parsed);
  }

  // Join on exact identity tuple: card_id, generation, ref, head, tree,
  // worktree, process.pid, process.started_at, session, lease_id, fence, fence_id
  const joinedEntries = [];
  const allCardIds = new Set([...receiptMap.keys(), ...liveMap.keys()]);

  for (const cardId of allCardIds) {
    const receipt = receiptMap.get(cardId);
    const live = liveMap.get(cardId);

    // F2: Both sides must be present - reject missing sides
    if (!receipt) {
      return { ok: false, reason: `MISSING_DURABLE_RECEIPT: ${cardId}`, entries: fresh.entries };
    }
    if (!live) {
      return { ok: false, reason: `MISSING_LIVE_OBSERVATION: ${cardId}`, entries: fresh.entries };
    }

    // F2: Verify exact identity tuple match
    if (receipt.generation !== live.generation) {
      return { ok: false, reason: `GENERATION_MISMATCH: ${cardId} receipt=${receipt.generation} live=${live.generation}`, entries: fresh.entries };
    }
    if (canonicalizeRef(receipt.ref) !== canonicalizeRef(live.ref)) {
      return { ok: false, reason: `REF_MISMATCH: ${cardId}`, entries: fresh.entries };
    }
    if (receipt.head !== live.head) {
      return { ok: false, reason: `HEAD_MISMATCH: ${cardId}`, entries: fresh.entries };
    }
    if (receipt.tree !== live.tree) {
      return { ok: false, reason: `TREE_MISMATCH: ${cardId}`, entries: fresh.entries };
    }
    if (canonicalizeWorktree(receipt.worktree) !== canonicalizeWorktree(live.worktree)) {
      return { ok: false, reason: `WORKTREE_MISMATCH: ${cardId}`, entries: fresh.entries };
    }
    if (receipt.process.pid !== live.process.pid) {
      return { ok: false, reason: `PID_MISMATCH: ${cardId}`, entries: fresh.entries };
    }
    if (receipt.process.started_at !== live.process.started_at) {
      return { ok: false, reason: `PROCESS_STARTED_AT_MISMATCH: ${cardId}`, entries: fresh.entries };
    }
    if (receipt.lease_id !== live.lease_id) {
      return { ok: false, reason: `LEASE_ID_MISMATCH: ${cardId}`, entries: fresh.entries };
    }
    if (receipt.fence !== live.fence) {
      return { ok: false, reason: `FENCE_MISMATCH: ${cardId}`, entries: fresh.entries };
    }
    if (receipt.fence_id !== live.fence_id) {
      return { ok: false, reason: `FENCE_ID_MISMATCH: ${cardId}`, entries: fresh.entries };
    }

    // F2: Full session identity must match (exact tuple, not conditional)
    const rSession = receipt.session ?? {};
    const lSession = live.session ?? {};
    if ((rSession.workspace_id ?? null) !== (lSession.workspace_id ?? null)) {
      return { ok: false, reason: `SESSION_WORKSPACE_MISMATCH: ${cardId}`, entries: fresh.entries };
    }
    if ((rSession.pane_id ?? null) !== (lSession.pane_id ?? null)) {
      return { ok: false, reason: `SESSION_PANE_MISMATCH: ${cardId}`, entries: fresh.entries };
    }
    if ((rSession.agent_session ?? null) !== (lSession.agent_session ?? null)) {
      return { ok: false, reason: `SESSION_AGENT_MISMATCH: ${cardId}`, entries: fresh.entries };
    }
    // F2: Lease expiry must match
    if (receipt.lease_expiry !== live.lease_expiry) {
      return { ok: false, reason: `LEASE_EXPIRY_MISMATCH: ${cardId}`, entries: fresh.entries };
    }

    // Use the live observation as the source of truth for the reconstructed entry
    // but preserve the receipt's admitted_at timestamp
    joinedEntries.push({ ...live, admitted_at: receipt.admitted_at });
  }

  // Re-run the same canonical admission validator used for live admission
  for (const entry of joinedEntries) {
    const alreadyAdmitted = new Set(Object.keys(fresh.entries));
    const validation = validateEntryAdmission(fresh, entry, alreadyAdmitted);
    if (!validation.ok) {
      return { ok: false, reason: validation.reason, entries: fresh.entries };
    }
    fresh.entries[entry.card_id] = { ...entry };
  }

  return { ok: true, entries: fresh.entries };
}

// Legacy reconstruction: DEPRECATED - rebuilds from live observations only
// (no durable authority join). This bypass is no longer safe because it
// accepts self-asserted live records without proving a matching durable
// authority record. Use reconstructFromAuthorityAndObservations instead.
// Throws on invocation to prevent accidental use in production paths.
export function reconstructRegistry(registry, liveEntries, isoNow, { currentFenceId = null } = {}) {
  throw new Error("DEPRECATED: reconstructRegistry is no longer safe. Use reconstructFromAuthorityAndObservations with durable receipts + verified observations.");
}

// ---------------------------------------------------------------------------
// Admission with Supervisor authority context (wires into real path)
// ---------------------------------------------------------------------------

// Admit an entry under a specific Supervisor authority fence.
// `authorityFence` is the current lock fence; entries must match it.
// F3: validates lease expiry against current time and compares lease_id.
export function admitEntryWithAuthority(registry, rawEntry, isoNow, { authorityFence, authorityFenceId, leaseId }) {
  const parsed = registryEntrySchema.parse(rawEntry);
  if (authorityFence !== undefined && parsed.fence !== authorityFence) {
    return { ok: false, reason: `FENCE_MISMATCH: entry fence ${parsed.fence} != authority ${authorityFence}` };
  }
  if (authorityFenceId && parsed.fence_id !== authorityFenceId) {
    return { ok: false, reason: `FENCE_ID_MISMATCH: ${parsed.card_id}` };
  }
  if (!leaseId) {
    return { ok: false, reason: `LEASE_MISSING: ${parsed.card_id}` };
  }
  // F3: Validate lease_id equality (not just presence)
  if (parsed.lease_id !== leaseId) {
    return { ok: false, reason: `LEASE_ID_MISMATCH: ${parsed.card_id}` };
  }
  // F3: Validate lease is still current
  if (parsed.lease_expiry) {
    const expiryMs = Date.parse(parsed.lease_expiry);
    const nowMs = Date.parse(isoNow);
    if (Number.isFinite(expiryMs) && Number.isFinite(nowMs) && expiryMs <= nowMs) {
      return { ok: false, reason: `LEASE_EXPIRED: ${parsed.card_id}` };
    }
  }
  const validation = validateEntryAdmission(registry, parsed, new Set());
  if (!validation.ok) return validation;

  registry.entries[parsed.card_id] = { ...parsed, state: "ADMITTED", heartbeat_at: parsed.heartbeat_at || isoNow };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main loop (§15 "Supervisor loop", steps 1-12)
// ---------------------------------------------------------------------------

function normalizeCtx(ctxIn) {
  const runtimeRoot = ctxIn.runtimeRoot;
  const livenessExec = ctxIn.livenessExec ?? execFileAsync;
  return {
    runtimeRoot,
    paths: ctxIn.paths ?? resolveRuntimePaths(runtimeRoot),
    orca: ctxIn.orca,
    pid: ctxIn.pid ?? process.pid,
    hostId: ctxIn.hostId ?? null,
    authorizedHostIds: ctxIn.authorizedHostIds ?? [],
    handoffToken: ctxIn.handoffToken ?? null,
    now: ctxIn.now ?? (() => Date.now()),
    isAlive: ctxIn.isAlive ?? ((pid) => defaultIsAlive(pid, livenessExec)),
    gitExec: ctxIn.gitExec ?? defaultGitExec,
    sleep: ctxIn.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    maxIterations: ctxIn.maxIterations ?? Infinity,
    intervalMs: ctxIn.intervalMs ?? HEARTBEAT_INTERVAL_MS,
    resumeDelivery: ctxIn.resumeDelivery ?? ctxIn.residentConsumer,
    // F1: registry/admission inputs carried into production path
    registry: ctxIn.registry ?? createRegistry(),
    admissionFence: ctxIn.admissionFence ?? undefined,
    admissionFenceId: ctxIn.admissionFenceId ?? undefined,
    admissionLeaseId: ctxIn.admissionLeaseId ?? undefined,
    // F2: reconstruction inputs
    durableReceipts: ctxIn.durableReceipts ?? [],
    liveObservations: ctxIn.liveObservations ?? [],
    // F1: pending admission entries injected by the resident consumer
    pendingAdmissions: ctxIn.pendingAdmissions ?? [],
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
  const lock = await acquireOrConfirmLock(paths, { pid: ctx.pid, hostId: ctx.hostId, authorizedHostIds: ctx.authorizedHostIds, handoffToken: ctx.handoffToken, isAlive: ctx.isAlive, isoNow });
  if (!lock.owned) {
    return { stop: true, reason: lock.reason ?? "LOCK_NOT_OWNED", holder: lock.holder, at: isoNow };
  }

  // F1: Registry reconstruction from durable receipts + live observations
  // under the ACQUIRED lock/fence. Derive fence from lock, not caller context.
  let registry = ctx.registry;
  if (ctx.durableReceipts.length > 0 || ctx.liveObservations.length > 0) {
    const reconResult = reconstructFromAuthorityAndObservations(
      ctx.durableReceipts,
      ctx.liveObservations,
      { currentFenceId: lock.fence ?? null }
    );
    if (!reconResult.ok) {
      tickEvents.push({ type: "registry_reconstruction_rejected", reason: reconResult.reason });
      await appendEvents(paths, tickEvents, isoNow);
      return { stop: false, at: isoNow, reason: `REGISTRY_RECONSTRUCTION_REJECTED: ${reconResult.reason}` };
    }
    registry = { entries: reconResult.entries, currentFenceId: lock.fence ?? null };
  }

  // F1: Admission gate - admit pending entries under the ACQUIRED lock/fence.
  // Derive admission authority from the actual lock, not caller self-asserted fields.
  // On ANY rejection, fail-closed: no project-state read, no terminal recovery,
  // no resume delivery, no physical send.
  const admissionResults = [];
  let admissionRejected = false;
  const lockAuthorityFence = lock.fence;
  const lockAuthorityFenceId = ctx.admissionFenceId;
  for (const rawEntry of ctx.pendingAdmissions) {
    const result = admitEntryWithAuthority(registry, rawEntry, isoNow, {
      authorityFence: lockAuthorityFence,
      authorityFenceId: lockAuthorityFenceId,
      leaseId: ctx.admissionLeaseId,
    });
    admissionResults.push({ card_id: rawEntry.card_id, ...result });
    if (!result.ok) {
      tickEvents.push({ type: "registry_admission_rejected", card_id: rawEntry.card_id, reason: result.reason });
      admissionRejected = true;
    }
  }

  // F1: If any admission was rejected, fail-closed before any downstream work.
  if (admissionRejected) {
    await appendEvents(paths, tickEvents, isoNow);
    return { stop: false, at: isoNow, reason: "REGISTRY_ADMISSION_REJECTED", events: tickEvents, registry, admissionResults };
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
  if (recoveryState.control_required && !isStopState(state.state)) {
    const reason = "CONTROL_REQUIRED_RECOVERY_STATE_UNREADABLE";
    tickEvents.push({ type: "supervisor_recovery_state_unreadable", reason, detail: recoveryState.recovery_state_error });
    await appendEvents(paths, tickEvents, isoNow);
    return { stop: false, at: isoNow, reason };
  }

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

  if (ctx.resumeDelivery) {
    const resume = await runResumeDeliveryCheck(ctx, {
      isoNow,
      deliveryState: recoveryState.residentConsumer,
      persistDeliveryState: async (nextState) => {
        if (ctx.resumeDelivery.persistDeliveryState) await ctx.resumeDelivery.persistDeliveryState(nextState);
        recoveryState = { ...recoveryState, residentConsumer: nextState };
        await writeRecoveryState(paths, recoveryState);
      },
      revalidateOwnership: async () => confirmLockOwnership(paths, {
        pid: ctx.pid,
        hostId: ctx.hostId,
        handoffToken: ctx.handoffToken,
        fence: lock.fence,
        isoNow: formatIso(ctx.now()),
      }),
      claimPhysicalSend: async (details) => claimPhysicalSendLease(paths, {
        pid: ctx.pid,
        hostId: ctx.hostId,
        fence: lock.fence,
        logicalKey: details.logicalKey,
        nowMs: () => ctx.now(),
      }),
    });
    tickEvents.push(...resume.events);
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

  return { stop: false, at: isoNow, projectState: state.state, events: tickEvents, registry, admissionResults };
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
