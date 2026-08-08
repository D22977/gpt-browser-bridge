// GPT_BROWSER_BRIDGE - GitHub Relay Executor v1 (GBB-GH-02)
//
// Thin deterministic actuator executor for the GBB-GH-01 relay kernel. It sits
// between the Supervisor and the real side effects (WebGPT fresh-chat review,
// OpenCode Worker terminal, GitHub human notification). It interprets ONLY the
// fixed kernel action enum (NOOP / REQUEST_REVIEW / DISPATCH_FIX /
// AWAITING_HUMAN_MERGE / HUMAN_INTERVENTION / NOTIFY_HUMAN); any unknown action
// produces zero external side effects and fails closed.
//
// Hard boundaries:
//   - The executor never judges PASS/FIX_REQUIRED itself; it only verifies an
//     exact-head MRMP_REVIEW_RESULT_V1 receipt exists on GitHub (machine shape
//     only, never review content).
//   - Sending a WebGPT prompt alone is NOT review completion. Success is only
//     ACKed once a valid exact-head review receipt is observed on GitHub.
//   - A failed ACK never marks an event processed (kernel rule, preserved).
//   - Long WebGPT waits never block one Supervisor tick: the executor returns
//     `pending` and the durable execution checkpoint carries the stage across
//     ticks/restarts (sending -> sent -> receipt_observed / timed_out).
//   - The executor is deterministic and fully injected (GitHub fetch/post,
//     WebGPT dispatcher, ORCA adapter); no live model, no network in unit tests.
//
// Spec: GBB-GH-02 §5..§16. This file may only read (never edit) the kernel and
// adapter modules.

import { readFile } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { isSha40, READY_MARKER, parseReviewResults, REVIEW_PROTOCOL } from "./github_relay.mjs";
import { buildTerminalTitle } from "./adapters/orca_adapter.mjs";

export const EXECUTOR_SCHEMA_VERSION = 1;
export const EXECUTOR_PROTOCOL = "GBB_GH_RELAY_EXECUTOR_V1";
export const HUMAN_NOTIFICATION_PROTOCOL = "GBB_GH_HUMAN_NOTIFICATION_V1";
export const READY_FOR_REVIEW_PROTOCOL = "GBB_GH_READY_FOR_REVIEW_V1";
export const REVIEW_TIMEOUT_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Strict GH-02-local Worker-completion READY validator (F002).
//
// The kernel's findReadyComment/readyCommentSha deliberately accept any
// comment carrying the READY_FOR_REVIEW marker with an explicit head_sha; that
// loose shape is what authorises REQUEST_REVIEW in the kernel. It is NOT a
// Worker-completion proof. Here the executor demands the full machine shape of
// a GBB_GH_READY_FOR_REVIEW_V1 comment before it ever ACKs a DISPATCH_FIX
// succeeded: the exact protocol, the relay PR number, the card binding, an
// explicit valid 40-hex head_sha, a head that is BOTH different from the
// reviewed head AND equal to the current PR head, and a comment posted at or
// after dispatch. Anything weaker (marker-only, wrong/missing protocol,
// wrong/missing PR, missing/malformed head, same head, non-current head,
// pre-dispatch READY) is NOT completion.
// ---------------------------------------------------------------------------

function readyField(body, name) {
  if (typeof body !== "string") return null;
  const m = body.match(new RegExp(`(^|[^A-Za-z0-9_])${name}:\\s*([^\\r\\n]+)`));
  return m ? m[2].trim() : null;
}

/** Strict, GH-02-local READY validation. Returns { ok, reason, headSha } | { ok: false, reason }. */
export function strictWorkerReady(comment, { prNumber, cardId, reviewedHead, currentHead, dispatchedAt }) {
  if (!comment || typeof comment.body !== "string") return { ok: false, reason: "missing_comment" };
  if (!comment.body.includes(READY_MARKER)) return { ok: false, reason: "missing_marker" };
  const protocol = readyField(comment.body, "protocol");
  if (protocol !== READY_FOR_REVIEW_PROTOCOL) return { ok: false, reason: "wrong_or_missing_protocol" };
  const readyPr = readyField(comment.body, "pr_number");
  if (readyPr === null || String(readyPr) !== String(prNumber)) return { ok: false, reason: "wrong_or_missing_pr" };
  if (cardId !== null && readyField(comment.body, "card_id") !== cardId) return { ok: false, reason: "wrong_or_missing_card_id" };
  const readySha = readyField(comment.body, "head_sha");
  if (!readySha || !isSha40(readySha)) return { ok: false, reason: "missing_or_malformed_head" };
  const headSha = readySha.toLowerCase();
  if (reviewedHead && headSha === String(reviewedHead).toLowerCase()) return { ok: false, reason: "same_reviewed_head" };
  if (currentHead && headSha !== String(currentHead).toLowerCase()) return { ok: false, reason: "not_current_head" };
  const readyAt = comment.created_at ? Date.parse(comment.created_at) : null;
  if (dispatchedAt !== null && (readyAt === null || Number.isNaN(readyAt) || readyAt < dispatchedAt)) {
    return { ok: false, reason: "pre_dispatch_ready" };
  }
  // F004: the READY contract also binds worker_self_review and merge_performed
  // to false. Any other value is NOT a Worker completion proof.
  if (readyField(comment.body, "worker_self_review") !== "false") return { ok: false, reason: "worker_self_review_not_false" };
  if (readyField(comment.body, "merge_performed") !== "false") return { ok: false, reason: "merge_performed_not_false" };
  return { ok: true, headSha };
}

/** Find the strictest Worker-completion READY among all comments, or null. */
export function findStrictWorkerReady(comments, opts) {
  const list = Array.isArray(comments) ? comments : [];
  let best = null;
  for (const c of list) {
    const verdict = strictWorkerReady(c, opts);
    if (!verdict.ok) continue;
    if (!best || (c.created_at ?? "") > (best.comment.created_at ?? "")) {
      best = { comment: c, verdict };
    }
  }
  return best ? best.verdict : null;
}

// ---------------------------------------------------------------------------
// Durable execution checkpoint (execution evidence only, never authority).
// ---------------------------------------------------------------------------

export function createExecutorState(nowIso) {
  return {
    schema_version: EXECUTOR_SCHEMA_VERSION,
    protocol: EXECUTOR_PROTOCOL,
    request_review: null,
    dispatch_fix: null,
    updated_at: nowIso ?? null,
  };
}

function validateExecutorState(value) {
  if (!value || typeof value !== "object") throw new Error("executor state is not an object");
  if (value.schema_version !== EXECUTOR_SCHEMA_VERSION) throw new Error("unsupported executor state schema_version");
  if (value.protocol !== EXECUTOR_PROTOCOL) throw new Error("executor state protocol mismatch");
  if (!("request_review" in value) || !("dispatch_fix" in value)) throw new Error("executor state missing fields");
  return value;
}

export async function readExecutorState(checkpointPath) {
  if (!checkpointPath) return createExecutorState(null);
  let raw;
  try {
    raw = await readFile(checkpointPath, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return createExecutorState(null);
    throw new Error(`github_relay_executor: cannot read checkpoint: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`github_relay_executor: checkpoint is not valid JSON: ${e.message}`);
  }
  return validateExecutorState(parsed);
}

export async function writeExecutorState(checkpointPath, state) {
  const dir = path.dirname(checkpointPath);
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  await writeFileAtomic(checkpointPath, JSON.stringify(state, null, 2) + "\n");
  return state;
}

// ---------------------------------------------------------------------------
// Deterministic prompt / message builders (§6, §11, §14).
// ---------------------------------------------------------------------------

export function buildReviewPrompt({ repo, issueNumber, prNumber, headSha, cardId, reviewScope }) {
  const scope = reviewScope ?? cardId ?? "GBB";
  return [
    "Perform a fresh-context read-only review.",
    "",
    "Read the connected private GitHub repository directly.",
    "",
    `repo: ${repo}`,
    `issue_number: ${issueNumber}`,
    `pr_number: ${prNumber}`,
    `expected_head_sha: ${headSha}`,
    `card_id: ${cardId ?? "unknown"}`,
    `review_scope: ${scope}`,
    "",
    `Review exact PR head ${headSha}.`,
    "",
    "Write exactly one machine-readable review result to the GitHub Issue:",
    "```json",
    JSON.stringify(
      {
        protocol: REVIEW_PROTOCOL,
        card_id: cardId ?? "unknown",
        pr_number: prNumber,
        reviewed_head_sha: headSha,
        decision: "PASS|FIX_REQUIRED|BLOCKED",
      },
      null,
      2
    ),
    "```",
    "",
    "Do not modify files.",
    "Do not merge or close anything.",
    "End the ChatGPT response with <!-- GBB:END -->.",
  ].join("\n");
}

export function buildWorkerPrompt({ repo, issueNumber, prNumber, headSha, cardId }) {
  return [
    `GitHub relay worker dispatch (${cardId ?? "GBB"}).`,
    `repo: ${repo} issue: ${issueNumber} pr: ${prNumber} head: ${headSha}`,
    "",
    "1. Read the current GitHub Issue/PR.",
    "2. Read the latest exact-head MRMP_REVIEW_RESULT_V1 FIX_REQUIRED review on the Issue.",
    "3. Repair only that review's findings.",
    "4. Run the required tests.",
    "5. Append a commit and push normally.",
    "6. Post a strict READY_FOR_REVIEW comment bound to the NEW head.",
    "7. Stop.",
  ].join("\n");
}

export function buildNotificationBody({ actionId, prNumber, headSha, terminalState, reason }) {
  return [
    "```",
    "GBB_GH_HUMAN_NOTIFICATION_V1",
    `action_id: ${actionId}`,
    `pr_number: ${prNumber ?? "null"}`,
    `head_sha: ${headSha ?? "null"}`,
    `terminal_state: ${terminalState ?? "null"}`,
    `reason: ${reason ?? "null"}`,
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Receipt / comment helpers (pure).
// ---------------------------------------------------------------------------

// The newest valid MRMP_REVIEW_RESULT_V1 receipt whose reviewed_head_sha equals
// the expected head, or null. Machine-shape only; never inspects review prose.
export function findExactHeadReview(comments, prNumber, headSha) {
  const { newest } = parseReviewResults(comments, prNumber);
  if (!newest) return null;
  const reviewed = newest.result.reviewed_head_sha.trim().toLowerCase();
  return reviewed === String(headSha).toLowerCase() ? newest : null;
}

// Newest existing human-notification comment carrying the exact action_id.
export function findExistingNotification(comments, actionId) {
  const list = Array.isArray(comments) ? comments : [];
  const matches = list.filter(
    (c) =>
      c &&
      typeof c.body === "string" &&
      c.body.includes(HUMAN_NOTIFICATION_PROTOCOL) &&
      c.body.includes(`action_id: ${actionId}`)
  );
  matches.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  return matches.length ? matches[matches.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Action handlers.
// ---------------------------------------------------------------------------

function ackOk(actionId) {
  return { actionId, result: "succeeded" };
}

function ackFailed(actionId, reason) {
  return { actionId, result: "failed", reason };
}

function ackNotify(actionId, notificationCommentId) {
  return { actionId, result: "succeeded", notificationCommentId };
}

function noop(reason) {
  return { status: "noop", reason, receipt: null, ack: null, events: [] };
}

function fail(reason, ack, events = []) {
  return { status: "failed", reason, receipt: null, ack, events };
}

function pending(reason, receipt = null) {
  return { status: "pending", reason, receipt, ack: null, events: [] };
}

function executed(reason, ack, receipt = null, events = []) {
  return { status: "executed", reason, receipt, ack, events };
}

// ---------------------------------------------------------------------------
// REQUEST_REVIEW: dispatch fresh WebGPT once, then wait non-blockingly across
// ticks for an exact-head GitHub receipt. Only the receipt may ACK success.
// ---------------------------------------------------------------------------

async function continueRequestReview({ relayState, action, state, deps, nowIso, nowMs }) {
  const pr = relayState.pr_number ?? action.pr_number;
  const repo = relayState.repo ?? action.repo;
  const issue = relayState.issue_number ?? action.issue_number;
  const head = action.current_head_sha ?? relayState.observed?.current_head_sha ?? state.request_review?.head_sha;
  const actionId = action.action_id ?? state.request_review?.action_id;

  let snapshot;
  try {
    snapshot = await deps.fetchSnapshot({ repo, issue, pr });
  } catch (e) {
    return fail("TRANSPORT_BLOCKED", ackFailed(actionId, "TRANSPORT_BLOCKED"));
  }

  const receipt = findExactHeadReview(snapshot.comments, pr, head);
  if (receipt) {
    state.request_review = {
      ...state.request_review,
      stage: "receipt_observed",
      receipt_comment_id: receipt.id ?? null,
      observed_at: nowIso,
    };
    state.updated_at = nowIso;
    await writeExecutorState(deps.checkpointPath, state);
    return executed(
      "REVIEW_RECEIPT_OBSERVED",
      ackOk(actionId),
      { comment_id: receipt.id ?? null, decision: receipt.result?.decision ?? null },
      [{ type: "review_receipt_observed", comment_id: receipt.id ?? null }]
    );
  }

  const dispatchedAt = state.request_review?.dispatched_at
    ? Date.parse(state.request_review.dispatched_at)
    : null;
  if (dispatchedAt !== null && !Number.isNaN(dispatchedAt) && nowMs - dispatchedAt >= REVIEW_TIMEOUT_MS) {
    state.request_review = { ...state.request_review, stage: "timed_out" };
    state.updated_at = nowIso;
    await writeExecutorState(deps.checkpointPath, state);
    return fail("WEBGPT_ADAPTER_HEALTH_FAILED", ackFailed(actionId, "WEBGPT_ADAPTER_HEALTH_FAILED"));
  }

  return pending("REVIEW_RECEIPT_WAIT");
}

async function startRequestReview({ action, state, deps, nowIso }) {
  const repo = action.repo;
  const issue = action.issue_number;
  const pr = action.pr_number;
  const head = action.current_head_sha;
  const cardId = deps.cardId ?? null;

  const prompt = buildReviewPrompt({ repo, issueNumber: issue, prNumber: pr, headSha: head, cardId });

  // Persist "sending" BEFORE dispatching so a crash in the dispatch window is
  // observable on restart and fails closed instead of re-sending (§9).
  state.request_review = { action_id: action.action_id, head_sha: head, stage: "sending", dispatched_at: nowIso };
  state.updated_at = nowIso;
  await writeExecutorState(deps.checkpointPath, state);

  let dispatch;
  try {
    dispatch = await deps.webgpt.dispatchReview({ prompt, repo, issue, pr, headSha: head });
  } catch (e) {
    state.request_review = { ...state.request_review, stage: "dispatch_failed", error: e?.message ?? "dispatch failed" };
    state.updated_at = nowIso;
    await writeExecutorState(deps.checkpointPath, state);
    return fail("WEBGPT_ADAPTER_HEALTH_FAILED", ackFailed(action.action_id, "WEBGPT_ADAPTER_HEALTH_FAILED"));
  }

  state.request_review = { ...state.request_review, stage: "sent", dispatched_at: nowIso };
  state.updated_at = nowIso;
  await writeExecutorState(deps.checkpointPath, state);
  return pending("WEBGPT_DISPATCHED", {
    conversation_url: dispatch?.conversation_url ?? dispatch?.conversationUrl ?? null,
    pack_path: dispatch?.pack_path ?? dispatch?.packPath ?? null,
  });
}

async function handleRequestReview({ relayState, action, state, deps, nowIso, nowMs }) {
  const inflight = state.request_review;
  if (inflight && inflight.action_id === action.action_id) {
    if (inflight.stage === "sent" || inflight.stage === "receipt_observed") {
      return continueRequestReview({ relayState, action, state, deps, nowIso, nowMs });
    }
    if (inflight.stage === "sending") {
      // Crash in the dispatch window: cannot prove whether the browser send
      // completed. Fail closed rather than re-sending a duplicate review (§9).
      return fail("WEBGPT_ADAPTER_HEALTH_FAILED", ackFailed(action.action_id, "WEBGPT_ADAPTER_HEALTH_FAILED"));
    }
    // dispatch_failed / timed_out with a re-dispatched action: start fresh.
    state.request_review = null;
  }
  return startRequestReview({ action, state, deps, nowIso });
}

// ---------------------------------------------------------------------------
// DISPATCH_FIX: deterministic OpenCode Worker terminal (find before create).
// ---------------------------------------------------------------------------

function workerTerminalTitle(relayState, action) {
  const pr = relayState.pr_number ?? action.pr_number;
  const attempt = (relayState.repair?.rounds ?? 0) + 1;
  return buildTerminalTitle(`GH-${pr}`, attempt, "worker");
}

async function handleDispatchFix({ relayState, action, state, deps, nowIso }) {
  const repo = relayState.repo ?? action.repo;
  const issue = relayState.issue_number ?? action.issue_number;
  const pr = relayState.pr_number ?? action.pr_number;
  const actionId = action.action_id ?? relayState?.pending_action?.action_id ?? state.dispatch_fix?.action_id;
  const title = workerTerminalTitle(relayState, action);

  // Continuation: a durable dispatch checkpoint already exists for this
  // action. Completion READY is checked FIRST (F002 strict machine shape); if
  // absent, the Worker terminal health is checked. A terminal that disappears
  // gets at most ONE durable find-before-create recovery; a second
  // disappearance or a failed recovery start fails closed into terminal/HUMAN
  // — never an infinite pending loop (F003).
  if (state.dispatch_fix && state.dispatch_fix.action_id === actionId && state.dispatch_fix.stage === "dispatched") {
    const reviewedHead = state.dispatch_fix.reviewed_head_sha ?? relayState.observed?.current_head_sha ?? action.current_head_sha ?? null;
    const dispatchedAt = state.dispatch_fix.dispatched_at ? Date.parse(state.dispatch_fix.dispatched_at) : null;

    // 1) Completion proof first: a strict GBB_GH_READY_FOR_REVIEW_V1 comment
    // bound to the relay PR, the card, and a NEW PR head — a valid 40-hex SHA,
    // different from the reviewed head, equal to the current PR head, posted
    // at/after dispatch, with worker_self_review:false and
    // merge_performed:false. Marker-only or head-only comments are NEVER
    // completion (F002/F004).
    let snapshot;
    try {
      snapshot = await deps.fetchSnapshot({ repo, issue, pr });
    } catch (e) {
      return fail("TRANSPORT_BLOCKED", ackFailed(actionId, "TRANSPORT_BLOCKED"));
    }
    const currentHead = snapshot?.head?.sha ?? null;
    const strict = findStrictWorkerReady(snapshot.comments, {
      prNumber: pr,
      cardId: deps.cardId ?? null,
      reviewedHead,
      currentHead,
      dispatchedAt,
    });
    if (strict && strict.ok) {
      const readySha = strict.headSha;
      state.dispatch_fix = {
        ...state.dispatch_fix,
        stage: "completion_observed",
        completion_head_sha: readySha,
        completed_at: nowIso,
      };
      state.updated_at = nowIso;
      await writeExecutorState(deps.checkpointPath, state);
      return executed(
        "WORKER_COMPLETION_OBSERVED",
        ackOk(actionId),
        { terminal_title: title, head_sha: readySha, handle: state.dispatch_fix.handle ?? null },
        [{ type: "worker_completion_observed", head_sha: readySha }]
      );
    }

    // 2) No completion proof yet. Verify the exact-title Worker terminal is
    // still alive; a live terminal means a healthy stall — keep monitoring
    // GitHub, never ACK, never relaunch.
    let terminals = [];
    try {
      terminals = await deps.orca.listTerminals();
    } catch (e) {
      return fail("OPENCODE_ADAPTER_START_FAILED", ackFailed(actionId, "OPENCODE_ADAPTER_START_FAILED"));
    }
    const existing = Array.isArray(terminals) ? terminals.find((t) => t?.title === title) : undefined;
    if (existing && existing.handle) {
      state.dispatch_fix = { ...state.dispatch_fix, handle: existing.handle };
      state.updated_at = nowIso;
      await writeExecutorState(deps.checkpointPath, state);
      return pending("WORKER_DISPATCH_WAIT", { terminal_title: title, handle: existing.handle });
    }

    // 3) The exact-title Worker terminal is GONE. At most ONE durable
    // find-before-create recovery; a second disappearance or a failed recovery
    // start fails closed into terminal/HUMAN (OPENCODE_ADAPTER_START_FAILED is
    // a kernel TERMINAL_FAILURE_REASON) — never an infinite pending loop.
    if (state.dispatch_fix.recovery_attempted) {
      return fail("OPENCODE_ADAPTER_START_FAILED", ackFailed(actionId, "OPENCODE_ADAPTER_START_FAILED"), [
        { type: "worker_terminal_lost", terminal_title: title },
      ]);
    }

    const prompt = buildWorkerPrompt({
      repo,
      issueNumber: issue,
      prNumber: pr,
      headSha: reviewedHead,
      cardId: deps.cardId ?? null,
    });
    try {
      let relist = [];
      try {
        relist = await deps.orca.listTerminals();
      } catch (e) {
        // A throw here is almost always a transient ORCA adapter problem (e.g.
        // ORCA restarting), NOT proof the terminal is dead. Never fail closed
        // into terminal/HUMAN on a single transient failure — defer the
        // recovery to the next tick instead (F005).
        return pending("WORKER_RECOVERY_DEFERRED", { terminal_title: title });
      }
      const reFound = Array.isArray(relist) ? relist.find((t) => t?.title === title) : undefined;
      if (reFound && reFound.handle) {
        state.dispatch_fix = { ...state.dispatch_fix, handle: reFound.handle, recovery_attempted: true, recovered_at: nowIso };
      } else {
        const created = await deps.orca.createTerminal({
          worktree: deps.worktree ?? null,
          title,
          command: deps.workerCommand ?? "opencode",
        });
        const handle = created?.handle ?? created?.terminal?.handle;
        if (!handle) throw new Error("createTerminal returned no handle");
        await deps.orca.sendTerminal({ handle, text: prompt, enter: true });
        state.dispatch_fix = { ...state.dispatch_fix, handle, recovery_attempted: true, recovered_at: nowIso };
      }
      state.updated_at = nowIso;
      await writeExecutorState(deps.checkpointPath, state);
      return pending("WORKER_DISPATCH_RECOVERED", { terminal_title: title, handle: state.dispatch_fix.handle ?? null });
    } catch (e) {
      return fail("OPENCODE_ADAPTER_START_FAILED", ackFailed(actionId, "OPENCODE_ADAPTER_START_FAILED"), [
        { type: "worker_terminal_recovery_failed", error: e?.message ?? "unknown" },
      ]);
    }
  }

  // Fresh dispatch: deterministic OpenCode Worker terminal (find before
  // create). Terminal start/reuse alone is NOT completion — persist a durable
  // checkpoint and return pending (no ACK) until GitHub proves a new-head
  // READY on a later tick (§F001-R3).
  const reviewedHead = relayState.observed?.current_head_sha ?? action.current_head_sha ?? null;
  const prompt = buildWorkerPrompt({
    repo,
    issueNumber: issue,
    prNumber: pr,
    headSha: reviewedHead,
    cardId: deps.cardId ?? null,
  });

  let terminals = [];
  try {
    terminals = await deps.orca.listTerminals();
  } catch (e) {
    return fail("OPENCODE_ADAPTER_START_FAILED", ackFailed(actionId, "OPENCODE_ADAPTER_START_FAILED"));
  }

  const existing = Array.isArray(terminals) ? terminals.find((t) => t?.title === title) : undefined;
  if (existing) {
    state.dispatch_fix = {
      action_id: actionId,
      terminal_title: title,
      reused: true,
      handle: existing.handle ?? null,
      reviewed_head_sha: reviewedHead,
      stage: "dispatched",
      dispatched_at: nowIso,
    };
    state.updated_at = nowIso;
    await writeExecutorState(deps.checkpointPath, state);
    return pending("WORKER_TERMINAL_REUSED", { terminal_title: title, handle: existing.handle ?? null });
  }

  let created;
  try {
    created = await deps.orca.createTerminal({
      worktree: deps.worktree ?? null,
      title,
      command: deps.workerCommand ?? "opencode",
    });
    const handle = created?.handle ?? created?.terminal?.handle;
    if (!handle) throw new Error("createTerminal returned no handle");
    await deps.orca.sendTerminal({ handle, text: prompt, enter: true });
  } catch (e) {
    return fail(
      "OPENCODE_ADAPTER_START_FAILED",
      ackFailed(actionId, "OPENCODE_ADAPTER_START_FAILED"),
      [{ type: "worker_terminal_start_failed", error: e?.message ?? "unknown" }]
    );
  }

  const handle = created?.handle ?? created?.terminal?.handle;
  state.dispatch_fix = {
    action_id: actionId,
    terminal_title: title,
    reused: false,
    handle,
    reviewed_head_sha: reviewedHead,
    stage: "dispatched",
    dispatched_at: nowIso,
  };
  state.updated_at = nowIso;
  await writeExecutorState(deps.checkpointPath, state);
  return pending("WORKER_TERMINAL_STARTED", { terminal_title: title, handle });
}

// ---------------------------------------------------------------------------
// NOTIFY_HUMAN: post exactly one GitHub Issue comment, reusing an existing
// same-action comment across a crash window (§14).
// ---------------------------------------------------------------------------

async function handleNotifyHuman({ relayState, action, state, deps, nowIso }) {
  const repo = relayState.repo ?? action.repo;
  const issue = relayState.issue_number ?? action.issue_number;
  const pr = relayState.pr_number ?? action.pr_number;
  const actionId = action.action_id;
  const head = relayState.observed?.current_head_sha ?? action.current_head_sha ?? null;
  const terminalState = relayState.terminal?.state ?? action.terminal_state ?? null;
  const reason = relayState.terminal?.reason ?? action.reason ?? null;

  const body = buildNotificationBody({ actionId, prNumber: pr, headSha: head, terminalState, reason });

  let snapshot;
  try {
    snapshot = await deps.fetchSnapshot({ repo, issue, pr });
  } catch (e) {
    return fail("TRANSPORT_BLOCKED", null);
  }

  const existing = findExistingNotification(snapshot.comments, actionId);
  if (existing && Number.isInteger(existing.id) && existing.id > 0) {
    state.updated_at = nowIso;
    await writeExecutorState(deps.checkpointPath, state);
    return executed(
      "NOTIFICATION_REUSED",
      ackNotify(actionId, existing.id),
      { comment_id: existing.id },
      [{ type: "notification_reused", comment_id: existing.id }]
    );
  }

  let posted;
  try {
    posted = await deps.postComment({ repo, issue, body });
  } catch (e) {
    return fail("TRANSPORT_BLOCKED", null, [{ type: "notification_post_failed", error: e?.message ?? "unknown" }]);
  }
  const commentId = posted?.id ?? posted?.comment_id ?? null;
  if (!Number.isInteger(commentId) || commentId <= 0) {
    return fail("TRANSPORT_BLOCKED", null, [{ type: "notification_invalid_receipt_id", id: commentId }]);
  }

  state.updated_at = nowIso;
  await writeExecutorState(deps.checkpointPath, state);
  return executed(
    "NOTIFICATION_POSTED",
    ackNotify(actionId, commentId),
    { comment_id: commentId },
    [{ type: "notification_posted", comment_id: commentId }]
  );
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

// executeAction: interpret one relay action. Returns
//   { status, reason, receipt, ack, events }
// where `ack` (if present) must be applied by the Supervisor via kernel
// applyAck(), and `status` is "executed" | "pending" | "failed" | "noop".
export async function executeAction({ action, relayState, deps, checkpointPath, nowMs, nowIso }) {
  const state = await readExecutorState(checkpointPath);
  const iso = nowIso ?? new Date(nowMs ?? Date.now()).toISOString();
  const ms = nowMs ?? Date.now();
  const depsRequired = deps ?? {};

  switch (action.action) {
    case "REQUEST_REVIEW":
      return handleRequestReview({ relayState, action, state, deps: depsRequired, nowIso: iso, nowMs: ms });

    case "NOOP": {
      const inflight = state.request_review;
      const pendingAction = relayState?.pending_action ?? null;
      if (inflight && inflight.stage === "sent" && pendingAction?.action === "REQUEST_REVIEW" && pendingAction.action_id === inflight.action_id) {
        return continueRequestReview({ relayState, action, state, deps: depsRequired, nowIso: iso, nowMs: ms });
      }
      if (inflight && inflight.stage === "sending" && pendingAction?.action === "REQUEST_REVIEW" && pendingAction.action_id === inflight.action_id) {
        return fail("WEBGPT_ADAPTER_HEALTH_FAILED", ackFailed(inflight.action_id, "WEBGPT_ADAPTER_HEALTH_FAILED"));
      }
      const pendingDispatch = relayState?.pending_action ?? null;
      if (pendingDispatch?.action === "DISPATCH_FIX" && state.dispatch_fix?.action_id === pendingDispatch.action_id) {
        return handleDispatchFix({ relayState, action, state, deps: depsRequired, nowIso: iso, nowMs: ms });
      }
      if (pendingDispatch?.action === "DISPATCH_FIX" && !state.dispatch_fix) {
        // Crash between kernel dispatch and executor start: the deterministic
        // find-before-create path recovers or fails closed (never duplicates).
        return handleDispatchFix({ relayState, action, state, deps: depsRequired, nowIso: iso, nowMs: ms });
      }
      return noop(action.reason ?? "NOOP");
    }

    case "DISPATCH_FIX":
      return handleDispatchFix({ relayState, action, state, deps: depsRequired, nowIso: iso, nowMs: ms });

    case "NOTIFY_HUMAN":
      return handleNotifyHuman({ relayState, action, state, deps: depsRequired, nowIso: iso, nowMs: ms });

    case "AWAITING_HUMAN_MERGE":
    case "HUMAN_INTERVENTION":
      // Terminal states: no side effect here. The kernel will emit NOTIFY_HUMAN
      // on the next tick until the notification receipt is ACKed (§15, §16).
      return noop("TERMINAL_STATE_NO_SIDE_EFFECT");

    default:
      // Unknown action: zero external side effects, fail closed (§5).
      return fail("UNKNOWN_ACTION", null, [{ type: "unknown_action_failed_closed", action: action.action }]);
  }
}
