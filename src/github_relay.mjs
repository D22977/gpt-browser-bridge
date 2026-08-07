// GPT_BROWSER_BRIDGE - GitHub Relay Kernel v1 (GBB-GH-01)
//
// Deterministic, model-free relay between a GitHub Issue/PR and future
// adapters (GBB-GH-02a WebGPTAdapter, GBB-GH-02b OpenCodeAdapter). This file
// never starts a model, never writes GitHub, never merges and never dispatches
// a worker. It only turns a GitHub snapshot plus durable relay state into a
// deterministic next action (NOOP / REQUEST_REVIEW / DISPATCH_FIX /
// AWAITING_HUMAN_MERGE / HUMAN_INTERVENTION) and persists exactly-once-ish
// dispatch checkpoints.
//
// Spec: GBB-GH-01 — GitHub Relay Kernel v1 (§1..§20).
//
// Hard boundaries:
//   - `evaluate()` is pure: given snapshot + state it never mutates either.
//   - An action becomes processed ONLY through a `succeeded` ACK.
//   - A `failed` ACK never marks anything processed.
//   - A pending action blocks any second dispatch until it is ACKed.
//   - Terminal state permanently stops the card and always requests a human
//     notification for the downstream adapter.
//   - Repair is capped at MAX_REPAIR_ROUNDS=2.
//
// Runtime checkpoint lives at
//   D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\runs\<run_id>\github_relay.json
// and is a durable execution checkpoint only, never an authority board.

import { readFile, writeFile, rename, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SCHEMA_VERSION = 1;
export const PROTOCOL_ACTION = "GBB_GH_RELAY_ACTION_V1";
export const PROTOCOL_STATE = "GBB_GH_RELAY_STATE_V1";
export const REVIEW_PROTOCOL = "MRMP_REVIEW_RESULT_V1";
export const READY_MARKER = "READY_FOR_REVIEW";

export const ACTION_ENUM = [
  "NOOP",
  "REQUEST_REVIEW",
  "DISPATCH_FIX",
  "AWAITING_HUMAN_MERGE",
  "HUMAN_INTERVENTION",
];

export const DECISION_ENUM = ["PASS", "FIX_REQUIRED", "BLOCKED"];

// Terminal-class adapter failures. On `ack --result failed` with one of these
// reasons the kernel enters terminal and clears the pending action; the
// downstream adapter owns posting the actual human-intervention comment.
export const TERMINAL_FAILURE_REASONS = [
  "WEBGPT_ADAPTER_HEALTH_FAILED",
  "OPENCODE_ADAPTER_START_FAILED",
  "TRANSPORT_BLOCKED",
];

export const DEFAULT_MAX_REPAIR_ROUNDS = 2;
export const DEFAULT_COOLDOWN_MINUTES = 5;

const SHA40_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isSha40(value) {
  return typeof value === "string" && SHA40_RE.test(value.toLowerCase());
}

function clone(value) {
  return structuredClone(value);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Extract the first balanced JSON object substring starting at `i`. */
function readBalanced(text, i) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

/** Extract every parseable JSON object embedded in a comment body. */
export function extractJsonObjects(text) {
  if (typeof text !== "string") return [];
  const out = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text)) !== null) {
    const value = safeParse(m[1]);
    if (value) out.push(value);
  }
  if (out.length) return out;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    const block = readBalanced(text, i);
    if (block) {
      const value = safeParse(block);
      if (value) out.push(value);
      i += block.length;
    }
  }
  return out;
}

function isValidReview(obj, prNumber) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.protocol !== REVIEW_PROTOCOL) return false;
  if (typeof obj.card_id !== "string" || !obj.card_id) return false;
  if (obj.pr_number !== prNumber) return false;
  if (typeof obj.reviewed_head_sha !== "string") return false;
  if (!isSha40(obj.reviewed_head_sha.trim())) return false;
  return DECISION_ENUM.includes(obj.decision);
}

/**
 * Scan comments for MRMP_REVIEW_RESULT_V1 attempts.
 * Returns the newest valid result (by created_at), a hasValid flag and a
 * malformed flag set when a review attempt exists but never validates.
 */
export function parseReviewResults(comments, prNumber) {
  const list = Array.isArray(comments) ? comments : [];
  const ordered = list
    .filter((c) => c && typeof c.body === "string" && c.body.includes(REVIEW_PROTOCOL))
    .map((c) => ({
      id: c.id ?? null,
      created_at: c.created_at ?? "",
      body: c.body,
      result: extractJsonObjects(c.body).find((o) => o && o.protocol === REVIEW_PROTOCOL) ?? null,
    }))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  let hasValid = false;
  let malformed = false;
  const valid = [];
  for (const entry of ordered) {
    if (!entry.result || !isValidReview(entry.result, prNumber)) {
      malformed = true;
      continue;
    }
    hasValid = true;
    valid.push(entry);
  }
  const newest = valid.length ? valid[valid.length - 1] : null;
  return { newest, hasValid, malformed };
}

/** Find the newest comment carrying the READY_FOR_REVIEW marker. */
export function findReadyComment(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const ready = list.filter((c) => c && typeof c.body === "string" && c.body.includes(READY_MARKER));
  ready.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  return ready.length ? ready[ready.length - 1] : null;
}

/**
 * Extract the explicit `head_sha:` field from a READY comment, or null.
 * Binds a READY to the head it was posted for. Any 40-char SHA that appears
 * earlier in the body (e.g. `base_sha:`) must never be mistaken for the head,
 * so we match the exact `head_sha:` field rather than the first SHA. The
 * non-word boundary also rejects composite fields such as `reviewed_head_sha:`.
 */
export function readyCommentSha(comment) {
  if (!comment || typeof comment.body !== "string") return null;
  const m = comment.body.match(/(^|[^A-Za-z0-9_])head_sha:\s*([0-9a-fA-F]{40})/);
  if (!m) return null;
  const head = m[2].toLowerCase();
  return isSha40(head) ? head : null;
}

function cooldownSatisfied(state, now) {
  if (!state.repair.last_repair_at) return true;
  const last = Date.parse(state.repair.last_repair_at);
  const current = Date.parse(now);
  if (Number.isNaN(last) || Number.isNaN(current)) return true;
  return current - last >= state.repair.cooldown_minutes * 60 * 1000;
}

// Event keys and action ids are the idempotency surface (§9): a given head
// only ever produces one dispatch regardless of duplicate comments.
const readyEventKey = (repo, pr, head) => `${repo}:${pr}:${head}:READY`;
const fixEventKey = (repo, pr, head) => `${repo}:${pr}:${head}:FIX_REQUIRED`;
const passEventKey = (repo, pr, head) => `${repo}:${pr}:${head}:PASS`;
const requestReviewActionId = (repo, pr, head) => `${repo}:${pr}:${head}:REQUEST_REVIEW`;
const dispatchFixActionId = (repo, pr, head) => `${repo}:${pr}:${head}:DISPATCH_FIX`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function createInitialState(repo, issueNumber, prNumber, now) {
  return {
    schema_version: SCHEMA_VERSION,
    protocol: PROTOCOL_STATE,
    repo,
    issue_number: issueNumber,
    pr_number: prNumber,
    observed: {
      current_head_sha: null,
      pr_state: null,
      pr_draft: null,
      last_ready_head_sha: null,
      last_reviewed_head_sha: null,
      last_review_decision: null,
      last_review_comment_id: null,
      observed_at: now ?? null,
    },
    pending_action: null,
    processed_event_keys: [],
    repair: {
      rounds: 0,
      max_rounds: DEFAULT_MAX_REPAIR_ROUNDS,
      cooldown_minutes: DEFAULT_COOLDOWN_MINUTES,
      last_repair_at: null,
    },
    terminal: {
      active: false,
      state: null,
      reason: null,
      entered_at: null,
      notification_required: false,
      notification_event_key: null,
      notification_comment_id: null,
    },
    updated_at: now ?? null,
  };
}

/** Validate a loaded relay state; throws on structural corruption. */
export function validateState(value) {
  if (!value || typeof value !== "object") throw new Error("relay state is not an object");
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported relay state schema_version");
  if (value.protocol !== PROTOCOL_STATE) throw new Error("relay state protocol mismatch");
  for (const key of ["repo", "issue_number", "pr_number", "observed", "pending_action", "processed_event_keys", "repair", "terminal"]) {
    if (!(key in value)) throw new Error(`relay state missing field: ${key}`);
  }
  if (!Array.isArray(value.processed_event_keys)) throw new Error("processed_event_keys must be an array");
  if (value.pending_action !== null && typeof value.pending_action !== "object") {
    throw new Error("pending_action must be null or an object");
  }
  if (typeof value.terminal !== "object" || typeof value.terminal.active !== "boolean") {
    throw new Error("terminal block corrupt");
  }
  if (typeof value.repair !== "object" || typeof value.repair.rounds !== "number") {
    throw new Error("repair block corrupt");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Evaluation (pure)
// ---------------------------------------------------------------------------

function baseAction(snapshot, state, action, reason, extra = {}) {
  const currentHead = snapshot.head?.sha ?? null;
  const newest = extra.newest ?? null;
  return {
    protocol: PROTOCOL_ACTION,
    action,
    action_id: extra.action_id ?? null,
    event_key: extra.event_key ?? null,
    repo: snapshot.repo ?? state.repo ?? null,
    issue_number: snapshot.issue_number ?? state.issue_number ?? null,
    pr_number: snapshot.pr_number ?? state.pr_number ?? null,
    current_head_sha: currentHead,
    pr_state: snapshot.head?.state ?? null,
    pr_draft: snapshot.head?.draft ?? null,
    reviewed_head_sha: newest ? newest.reviewed_head_sha : null,
    repair_rounds: state.repair.rounds,
    terminal: extra.terminal ?? false,
    terminal_state: extra.terminal_state ?? null,
    reason,
  };
}

/**
 * Deterministic next action from a snapshot plus relay state.
 * Pure: mutates neither argument.
 */
export function evaluate(snapshot, state, now) {
  if (state.terminal.active) {
    return baseAction(snapshot, state, "NOOP", "TERMINAL_STATE");
  }
  if (state.pending_action) {
    return baseAction(snapshot, state, "NOOP", "PENDING_ACTION_AWAITING_ACK");
  }

  const prNumber = snapshot.pr_number ?? state.pr_number;
  const { newest, hasValid, malformed } = parseReviewResults(snapshot.comments, prNumber);
  const currentHead = snapshot.head?.sha ?? null;

  const fresh = Boolean(newest && newest.result && newest.result.reviewed_head_sha.trim().toLowerCase() === currentHead);
  const decision = newest ? newest.result.decision : null;
  const reviewedSha = newest ? newest.result.reviewed_head_sha.trim().toLowerCase() : null;

  if (fresh && decision === "PASS") {
    return baseAction(snapshot, state, "AWAITING_HUMAN_MERGE", "FRESH_REVIEW_PASS", {
      newest: newest.result,
      event_key: passEventKey(snapshot.repo ?? state.repo, prNumber, currentHead),
      terminal: true,
      terminal_state: "PASS_AWAITING_MANUAL_MERGE",
    });
  }

  if (fresh && decision === "BLOCKED") {
    return baseAction(snapshot, state, "HUMAN_INTERVENTION", "REVIEW_BLOCKED", {
      newest: newest.result,
      event_key: passEventKey(snapshot.repo ?? state.repo, prNumber, currentHead),
      terminal: true,
      terminal_state: "BLOCKED_FOR_HUMAN",
    });
  }

  if (fresh && decision === "FIX_REQUIRED") {
    if (state.repair.rounds >= state.repair.max_rounds) {
      return baseAction(snapshot, state, "HUMAN_INTERVENTION", "MAX_REPAIR_ROUNDS_EXCEEDED", {
        newest: newest.result,
        event_key: fixEventKey(snapshot.repo ?? state.repo, prNumber, currentHead),
        terminal: true,
        terminal_state: "BLOCKED_FOR_HUMAN",
      });
    }
    if (!cooldownSatisfied(state, now)) {
      return baseAction(snapshot, state, "NOOP", "REPAIR_COOLDOWN", { newest: newest.result });
    }
    const key = fixEventKey(snapshot.repo ?? state.repo, prNumber, currentHead);
    if (state.processed_event_keys.includes(key)) {
      return baseAction(snapshot, state, "NOOP", "FIX_ALREADY_PROCESSED", { newest: newest.result });
    }
    return baseAction(snapshot, state, "DISPATCH_FIX", "FRESH_FIX_REQUIRED", {
      newest: newest.result,
      action_id: dispatchFixActionId(snapshot.repo ?? state.repo, prNumber, currentHead),
      event_key: key,
    });
  }

  if (malformed && !hasValid) {
    return baseAction(snapshot, state, "HUMAN_INTERVENTION", "REVIEW_RESULT_MALFORMED", {
      event_key: passEventKey(snapshot.repo ?? state.repo, prNumber, currentHead),
      terminal: true,
      terminal_state: "BLOCKED_FOR_HUMAN",
    });
  }

  // C. Current head has READY_FOR_REVIEW and no fresh review.
  // A READY marker must carry an explicit head_sha field that equals the live
  // head, otherwise we FAIL CLOSED: a SHA-less READY is never assumed to refer
  // to the current head (that could authorise review of a head the marker never
  // actually ratified, or of base SHA mistaken for head SHA).
  const ready = findReadyComment(snapshot.comments);
  const readySha = ready ? readyCommentSha(ready) : null;
  if (ready && readySha === currentHead) {
    const key = readyEventKey(snapshot.repo ?? state.repo, prNumber, currentHead);
    if (!state.processed_event_keys.includes(key)) {
      return baseAction(snapshot, state, "REQUEST_REVIEW", "CURRENT_HEAD_READY_FOR_REVIEW", {
        action_id: requestReviewActionId(snapshot.repo ?? state.repo, prNumber, currentHead),
        event_key: key,
      });
    }
  }

  return baseAction(snapshot, state, "NOOP", "NO_ACTIONABLE_EVENT", { newest: newest ? newest.result : null });
}

/** Apply a decision onto a copy of state; returns the new state (pure). */
export function applyDecision(state, decision, now) {
  const next = clone(state);
  next.observed.current_head_sha = decision.current_head_sha;
  if (decision.pr_state !== undefined && decision.pr_state !== null) {
    next.observed.pr_state = decision.pr_state;
  }
  if (decision.pr_draft !== undefined && decision.pr_draft !== null) {
    next.observed.pr_draft = decision.pr_draft;
  }
  next.observed.observed_at = now;
  if (decision.reviewed_head_sha) {
    next.observed.last_reviewed_head_sha = decision.reviewed_head_sha;
  }

  if (decision.action === "REQUEST_REVIEW") {
    next.observed.last_ready_head_sha = decision.current_head_sha;
    next.pending_action = {
      action_id: decision.action_id,
      event_key: decision.event_key,
      action: decision.action,
      head_sha: decision.current_head_sha,
      created_at: now,
    };
  } else if (decision.action === "DISPATCH_FIX") {
    next.pending_action = {
      action_id: decision.action_id,
      event_key: decision.event_key,
      action: decision.action,
      head_sha: decision.current_head_sha,
      created_at: now,
    };
  }

  if (decision.terminal) {
    next.terminal.active = true;
    next.terminal.state = decision.terminal_state;
    next.terminal.reason = decision.reason;
    next.terminal.entered_at = now;
    next.terminal.notification_required = true;
    next.terminal.notification_event_key = decision.event_key ?? null;
    next.pending_action = null;
  }

  next.updated_at = now;
  return next;
}

// ---------------------------------------------------------------------------
// ACK
// ---------------------------------------------------------------------------

/**
 * Apply an executor ACK onto a copy of state.
 * Returns { state, changed, status } where status explains the outcome.
 *   succeeded -> pending event key moves to processed; DISPATCH_FIX increments
 *                repair round exactly once.
 *   failed + terminal reason -> terminal entered, pending cleared, nothing
 *                marked processed.
 *   failed + non-terminal reason -> pending kept, nothing marked processed.
 *   no pending / id mismatch -> no-op (idempotent).
 */
export function applyAck(state, { actionId, result, reason = null, now }) {
  const next = clone(state);
  if (!next.pending_action) {
    return { state: next, changed: false, status: "NO_PENDING" };
  }
  if (next.pending_action.action_id !== actionId) {
    return { state: next, changed: false, status: "ACTION_ID_MISMATCH" };
  }

  if (result === "succeeded") {
    if (!next.processed_event_keys.includes(next.pending_action.event_key)) {
      next.processed_event_keys.push(next.pending_action.event_key);
    }
    if (next.pending_action.action === "DISPATCH_FIX") {
      next.repair.rounds += 1;
      next.repair.last_repair_at = now;
    }
    next.pending_action = null;
    next.updated_at = now;
    return { state: next, changed: true, status: "PROCESSED" };
  }

  if (result === "failed") {
    if (reason && TERMINAL_FAILURE_REASONS.includes(reason)) {
      next.terminal.active = true;
      next.terminal.state = "BLOCKED_FOR_HUMAN";
      next.terminal.reason = reason;
      next.terminal.entered_at = now;
      next.terminal.notification_required = true;
      next.terminal.notification_event_key = next.pending_action.event_key;
      next.pending_action = null;
      next.updated_at = now;
      return { state: next, changed: true, status: "TERMINAL_FAILURE" };
    }
    // Non-terminal failure: pending stays, never processed.
    return { state: next, changed: false, status: "FAILURE_NOT_PROCESSED" };
  }

  return { state: next, changed: false, status: "INVALID_RESULT" };
}

// ---------------------------------------------------------------------------
// Durable state IO (atomic replace: tmp -> fsync -> rename)
// ---------------------------------------------------------------------------

export async function readStateFile(statePath) {
  let raw;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw new Error(`unable to read relay state: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`relay state is not valid JSON: ${err.message}`);
  }
  validateState(parsed);
  return parsed;
}

export async function writeStateFile(statePath, state) {
  const dir = path.dirname(statePath);
  const tmp = `${statePath}.tmp`;
  const data = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(tmp, data, "utf8");
  const fh = await open(tmp, "a");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, statePath);
  return statePath;
}

// ---------------------------------------------------------------------------
// Live GitHub snapshot (read-only; poll only)
// ---------------------------------------------------------------------------

export async function fetchSnapshotViaGh({ repo, issue, pr }, execFn = execFileAsync) {
  const prResult = await execFn("gh", [
    "pr", "view", String(pr), "--repo", repo,
    "--json", "number,state,isDraft,headRefOid,comments",
  ]);
  const prData = JSON.parse(prResult.stdout);
  // An issue-read failure is a transport-level failure, NOT an "empty issue".
  // Swallowing it could produce a snapshot missing the READY/review comments and
  // silently authorise the wrong action. Propagate so runPoll() maps it to
  // exit 3 (TRANSPORT_BLOCKED) with the required human notification.
  const issueResult = await execFn("gh", [
    "issue", "view", String(issue), "--repo", repo,
    "--json", "number,state,comments",
  ]);
  const issueData = JSON.parse(issueResult.stdout);

  const mergeComments = (arr) =>
    (Array.isArray(arr) ? arr : []).map((c) => ({
      id: c.id ?? null,
      body: c.body ?? "",
      created_at: c.createdAt ?? "",
    }));

  const comments = [...mergeComments(prData.comments), ...mergeComments(issueData.comments)];
  comments.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  return {
    repo,
    issue_number: Number(issue),
    pr_number: Number(pr),
    head: {
      sha: prData.headRefOid ?? null,
      state: prData.state ?? null,
      draft: prData.isDraft ?? null,
    },
    comments,
  };
}

// ---------------------------------------------------------------------------
// Poll orchestration
// ---------------------------------------------------------------------------

/**
 * Run one poll cycle. When `dryRun` is true the GitHub snapshot is still
 * fetched for real and the action is computed, but neither state nor GitHub
 * is modified. Returns { code, action, error? }.
 */
export async function runPoll({ repo, issue, pr, statePath, now, dryRun = false, fetchSnapshot = fetchSnapshotViaGh }) {
  let state;
  try {
    state = await readStateFile(statePath);
  } catch (err) {
    return { code: 4, error: err.message };
  }
  if (!state) {
    state = createInitialState(repo, issue, pr, now);
  }

  let snapshot;
  try {
    snapshot = await fetchSnapshot({ repo, issue, pr });
  } catch (err) {
    const currentHead = state.observed.current_head_sha ?? null;
    const decision = baseAction(
      { repo, issue_number: Number(issue), pr_number: Number(pr), head: { sha: currentHead, state: null, draft: null } },
      state,
      "HUMAN_INTERVENTION",
      "TRANSPORT_BLOCKED",
      { terminal: true, terminal_state: "TRANSPORT_BLOCKED" },
    );
    if (!dryRun) {
      const next = applyDecision(state, decision, now);
      await writeStateFile(statePath, next);
    }
    return { code: 3, action: decision, error: err.message };
  }

  const decision = evaluate(snapshot, state, now);
  if (!dryRun) {
    const next = applyDecision(state, decision, now);
    await writeStateFile(statePath, next);
  }
  return { code: 0, action: decision };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(message) {
  return `usage error: ${message}

evaluate:
  node src/github_relay.mjs evaluate --snapshot <snapshot.json> --state <state.json> [--now <ISO8601>]

poll:
  node src/github_relay.mjs poll --repo <owner/repo> --issue <n> --pr <n> --state <state.json> [--now <ISO8601>] [--dry-run]

ack:
  node src/github_relay.mjs ack --state <state.json> --action-id <id> --result succeeded|failed [--reason <code>] [--now <ISO8601>]`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(usage(`unexpected argument: ${a}`));
    const key = a.slice(2);
    if (key === "dry-run") {
      args.dry_run = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(usage(`missing value for ${a}`));
    args[key] = value;
    i += 1;
  }
  return args;
}

function requireArgs(args, keys) {
  for (const key of keys) {
    if (!args[key]) throw new Error(usage(`missing --${key}`));
  }
}

function parseNow(nowArg) {
  if (!nowArg) return new Date().toISOString();
  if (Number.isNaN(Date.parse(nowArg))) throw new Error(usage(`invalid --now: ${nowArg}`));
  return new Date(nowArg).toISOString();
}

export async function main(argv) {
  const command = argv[0];
  if (!command) {
    process.stderr.write(usage("no subcommand"));
    return 2;
  }
  let args;
  try {
    args = parseArgs(argv.slice(1));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  try {
    return await dispatchCommand(command, args);
  } catch (err) {
    // CLI/schema/usage validation must exit deterministically with code 2 and
    // no stack trace, regardless of where it is raised.
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    return 2;
  }
}

async function dispatchCommand(command, args) {
  if (command === "evaluate") {
    requireArgs(args, ["snapshot", "state"]);
    const now = parseNow(args.now);
    let snapshot;
    try {
      snapshot = safeParse(await readFile(args.snapshot, "utf8"));
    } catch (err) {
      process.stderr.write(`evaluate: cannot read snapshot: ${err.message}\n`);
      return 2;
    }
    if (!snapshot || typeof snapshot !== "object") {
      process.stderr.write("evaluate: snapshot is not valid JSON object\n");
      return 2;
    }
    let state;
    try {
      state = await readStateFile(args.state);
    } catch (err) {
      process.stderr.write(`evaluate: corrupt relay state: ${err.message}\n`);
      return 4;
    }
    if (!state) {
      state = createInitialState(
        snapshot.repo ?? null,
        snapshot.issue_number ?? null,
        snapshot.pr_number ?? null,
        now,
      );
    }
    const action = evaluate(snapshot, state, now);
    process.stdout.write(`${JSON.stringify(action, null, 2)}\n`);
    return 0;
  }

  if (command === "poll") {
    requireArgs(args, ["repo", "issue", "pr", "state"]);
    const now = parseNow(args.now);
    const result = await runPoll({
      repo: args.repo,
      issue: Number(args.issue),
      pr: Number(args.pr),
      statePath: args.state,
      now,
      dryRun: Boolean(args.dry_run),
    });
    if (result.action) {
      process.stdout.write(`${JSON.stringify(result.action, null, 2)}\n`);
    }
    if (result.error) {
      process.stderr.write(`poll: ${result.error}\n`);
    }
    return result.code;
  }

  if (command === "ack") {
    requireArgs(args, ["state", "action-id", "result"]);
    if (!["succeeded", "failed"].includes(args.result)) {
      process.stderr.write(usage(`--result must be succeeded|failed, got ${args.result}`));
      return 2;
    }
    const now = parseNow(args.now);
    let state;
    try {
      state = await readStateFile(args.state);
    } catch (err) {
      process.stderr.write(`ack: corrupt relay state: ${err.message}\n`);
      return 4;
    }
    if (!state) {
      process.stderr.write("ack: relay state file does not exist\n");
      return 4;
    }
    const out = applyAck(state, {
      actionId: args["action-id"],
      result: args.result,
      reason: args.reason ?? null,
      now,
    });
    if (out.changed) {
      await writeStateFile(args.state, out.state);
    }
    process.stdout.write(`${JSON.stringify({ acked: true, status: out.status }, null, 2)}\n`);
    return 0;
  }

  process.stderr.write(usage(`unknown subcommand: ${command}`));
  return 2;
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
