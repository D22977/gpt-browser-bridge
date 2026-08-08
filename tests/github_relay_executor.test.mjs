// GPT_BROWSER_BRIDGE - GitHub Relay Executor v1 tests (GBB-GH-02)
// node:test only. No third-party test framework, no new dependencies.
// Deterministic, fully injected: no live GitHub, no WebGPT, no ORCA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createExecutorState,
  readExecutorState,
  writeExecutorState,
  buildReviewPrompt,
  buildWorkerPrompt,
  buildNotificationBody,
  findExactHeadReview,
  findExistingNotification,
  executeAction,
  EXECUTOR_PROTOCOL,
  HUMAN_NOTIFICATION_PROTOCOL,
  REVIEW_TIMEOUT_MS,
} from "../src/github_relay_executor.mjs";
import { createInitialState, applyAck, applyDecision } from "../src/github_relay.mjs";

const REPO = "D22977/MEP-";
const ISSUE = 3;
const PR = 4;
const HEAD_A = "f8e644871036f190b6e6385f3969f65ec9b016fb";
const HEAD_B = "111122223333444455556666777788889999aaaa";
const NOW = "2026-08-07T16:00:00+08:00";
const NOW_MS = Date.parse(NOW);

function baseRelayState(overrides = {}) {
  const base = createInitialState(REPO, ISSUE, PR, NOW);
  return {
    ...base,
    observed: { ...base.observed, current_head_sha: HEAD_A },
    ...overrides,
  };
}

function comment(id, body, created_at = NOW) {
  return { id, body, created_at };
}

function readyComment(id, head = HEAD_A, created_at = NOW) {
  return comment(
    id,
    `READY_FOR_REVIEW\n\nprotocol: GBB_GH_READY_FOR_REVIEW_V1\nbase_sha: ${HEAD_A}\nhead_sha: ${head}\n`,
    created_at
  );
}

function reviewComment(id, { decision, head = HEAD_A, pr_number = PR, created_at = NOW }) {
  const result = {
    protocol: "MRMP_REVIEW_RESULT_V1",
    card_id: "GBB-GH-02",
    pr_number,
    reviewed_head_sha: head,
    decision,
  };
  return comment(id, `Review:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\``, created_at);
}

function snapshot(comments = [], extra = {}) {
  return {
    repo: REPO,
    issue_number: ISSUE,
    pr_number: PR,
    head: { sha: HEAD_A, state: "OPEN", draft: true },
    comments,
    ...extra,
  };
}

function requestReviewAction(extra = {}) {
  return {
    protocol: "GBB_GH_ACTION_V1",
    action: "REQUEST_REVIEW",
    action_id: `${REPO}:${PR}:${HEAD_A}:REQUEST_REVIEW`,
    event_key: `${REPO}:${PR}:${HEAD_A}:READY`,
    repo: REPO,
    issue_number: ISSUE,
    pr_number: PR,
    current_head_sha: HEAD_A,
    pr_state: "OPEN",
    pr_draft: true,
    reviewed_head_sha: null,
    repair_rounds: 0,
    terminal: false,
    terminal_state: null,
    reason: "CURRENT_HEAD_READY_FOR_REVIEW",
    ...extra,
  };
}

function pendingAction(action, { head = HEAD_A } = {}) {
  return {
    action_id: action.action_id,
    event_key: action.event_key,
    action: action.action,
    head_sha: head,
    created_at: NOW,
  };
}

function fakeDeps(overrides = {}) {
  const calls = { dispatch: 0, postComment: 0, listTerminals: 0, createTerminal: 0, sendTerminal: 0, fetchSnapshot: 0 };
  const deps = {
    fetchSnapshot: async () => {
      calls.fetchSnapshot += 1;
      return snapshot([]);
    },
    postComment: async ({ body }) => {
      calls.postComment += 1;
      return { id: 9001 };
    },
    webgpt: {
      dispatchReview: async () => {
        calls.dispatch += 1;
        return { conversationUrl: "https://chatgpt.com/c/abc", conversation_url: "https://chatgpt.com/c/abc", packPath: "/tmp/x", pack_path: "/tmp/x" };
      },
    },
    orca: {
      listTerminals: async () => {
        calls.listTerminals += 1;
        return [];
      },
      createTerminal: async () => {
        calls.createTerminal += 1;
        return { handle: "term-worker", terminal: { handle: "term-worker" } };
      },
      sendTerminal: async () => {
        calls.sendTerminal += 1;
        return { accepted: true };
      },
    },
    worktree: null,
    workerCommand: "opencode",
    cardId: "GBB-GH-02",
    checkpointPath: null,
    ...overrides,
  };
  return { deps, calls };
}

async function tempCheckpoint(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "gbbgh02-exec-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "checkpoint.json");
}

function inflightSent(actionId, head = HEAD_A, dispatchedAt = NOW) {
  return {
    request_review: { action_id: actionId, head_sha: head, stage: "sent", dispatched_at: dispatchedAt },
    dispatch_fix: null,
  };
}

// ---------------------------------------------------------------------------
// Durable execution checkpoint
// ---------------------------------------------------------------------------

test("createExecutorState returns a fresh schema-versioned state", () => {
  const s = createExecutorState(NOW);
  assert.equal(s.schema_version, 1);
  assert.equal(s.protocol, EXECUTOR_PROTOCOL);
  assert.equal(s.request_review, null);
  assert.equal(s.dispatch_fix, null);
});

test("readExecutorState returns fresh state when the checkpoint file is missing", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const s = await readExecutorState(checkpointPath);
  assert.equal(s.protocol, EXECUTOR_PROTOCOL);
  assert.equal(s.request_review, null);
});

test("readExecutorState fails closed on a corrupt checkpoint", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  await writeFile(checkpointPath, "{not json", "utf8");
  await assert.rejects(() => readExecutorState(checkpointPath), /not valid JSON/);
});

test("readExecutorState fails closed on a schema mismatch", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  await writeFile(checkpointPath, JSON.stringify({ schema_version: 99, protocol: EXECUTOR_PROTOCOL, request_review: null, dispatch_fix: null }), "utf8");
  await assert.rejects(() => readExecutorState(checkpointPath), /schema_version/);
});

test("writeExecutorState persists and round-trips", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const state = createExecutorState(NOW);
  state.request_review = { action_id: "a", head_sha: HEAD_A, stage: "sent", dispatched_at: NOW };
  await writeExecutorState(checkpointPath, state);
  const reloaded = await readExecutorState(checkpointPath);
  assert.equal(reloaded.request_review.stage, "sent");
});

// ---------------------------------------------------------------------------
// Prompt / message builders (deterministic, never review prose)
// ---------------------------------------------------------------------------

test("buildReviewPrompt binds repo/issue/pr and the exact expected head SHA", () => {
  const prompt = buildReviewPrompt({ repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD_A, cardId: "GBB-GH-02" });
  assert.ok(prompt.includes(REPO));
  assert.ok(prompt.includes(`issue_number: ${ISSUE}`));
  assert.ok(prompt.includes(`pr_number: ${PR}`));
  assert.ok(prompt.includes(`expected_head_sha: ${HEAD_A}`));
  assert.ok(prompt.includes("MRMP_REVIEW_RESULT_V1"));
  assert.ok(prompt.includes("Do not modify files."));
  assert.ok(prompt.includes("<!-- GBB:END -->"));
});

test("buildWorkerPrompt instructs repair against the exact head and a strict READY post", () => {
  const prompt = buildWorkerPrompt({ repo: REPO, issueNumber: ISSUE, prNumber: PR, headSha: HEAD_A, cardId: "GBB-GH-02" });
  assert.ok(prompt.includes(REPO));
  assert.ok(prompt.includes(String(PR)));
  assert.ok(prompt.includes(HEAD_A));
  assert.ok(prompt.includes("MRMP_REVIEW_RESULT_V1 FIX_REQUIRED"));
  assert.ok(prompt.includes("READY_FOR_REVIEW"));
});

test("buildNotificationBody carries the human protocol, action id, and terminal reason", () => {
  const body = buildNotificationBody({ actionId: "id-x", prNumber: PR, headSha: HEAD_A, terminalState: "BLOCKED_FOR_HUMAN", reason: "TRANSPORT_BLOCKED" });
  assert.ok(body.includes(HUMAN_NOTIFICATION_PROTOCOL));
  assert.ok(body.includes("action_id: id-x"));
  assert.ok(body.includes(`head_sha: ${HEAD_A}`));
  assert.ok(body.includes("TRANSPORT_BLOCKED"));
});

// ---------------------------------------------------------------------------
// Receipt / comment helpers (machine-shape only)
// ---------------------------------------------------------------------------

test("findExactHeadReview returns null when no review matches the exact head", () => {
  const comments = [reviewComment(1, { decision: "PASS", head: "111122223333444455556666777788889999aaaa" })];
  assert.equal(findExactHeadReview(comments, PR, HEAD_A), null);
});

test("findExactHeadReview returns the newest exact-head receipt only", () => {
  const older = reviewComment(1, { decision: "FIX_REQUIRED", head: HEAD_A, created_at: "2026-08-07T15:00:00+08:00" });
  const newer = reviewComment(2, { decision: "PASS", head: HEAD_A, created_at: "2026-08-07T16:00:00+08:00" });
  const found = findExactHeadReview([older, newer], PR, HEAD_A);
  assert.ok(found);
  assert.equal(found.result.decision, "PASS");
  assert.equal(found.id, 2);
});

test("findExistingNotification matches the exact action id", () => {
  const body = buildNotificationBody({ actionId: "id-y", prNumber: PR, headSha: HEAD_A, terminalState: "BLOCKED_FOR_HUMAN", reason: "X" });
  const comments = [comment(1, "noise"), comment(2, body)];
  const found = findExistingNotification(comments, "id-y");
  assert.ok(found);
  assert.equal(found.id, 2);
  assert.equal(findExistingNotification(comments, "id-z"), null);
});

// ---------------------------------------------------------------------------
// executeAction: REQUEST_REVIEW
// ---------------------------------------------------------------------------

test("NOOP with no inflight work is a pure noop", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const relayState = baseRelayState();
  const action = { ...requestReviewAction(), action: "NOOP", action_id: null, reason: "NO_ACTIONABLE_EVENT" };
  const { deps, calls } = fakeDeps();
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "noop");
  assert.equal(out.ack, null);
  assert.equal(calls.dispatch, 0);
  assert.equal(calls.postComment, 0);
});

test("fresh REQUEST_REVIEW dispatches WebGPT exactly once, persists sent, returns pending", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const relayState = baseRelayState({ pending_action: pendingAction(requestReviewAction()) });
  const action = requestReviewAction();
  const { deps, calls } = fakeDeps();
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(calls.dispatch, 1);
  assert.equal(out.status, "pending");
  assert.equal(out.reason, "WEBGPT_DISPATCHED");
  assert.equal(out.ack, null);
  const state = await readExecutorState(checkpointPath);
  assert.equal(state.request_review.stage, "sent");
  assert.equal(state.request_review.head_sha, HEAD_A);
});

test("REQUEST_REVIEW with a dispatch error fails closed with an ACK", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const relayState = baseRelayState({ pending_action: pendingAction(requestReviewAction()) });
  const action = requestReviewAction();
  const { deps } = fakeDeps();
  deps.webgpt.dispatchReview = async () => {
    throw new Error("browser crashed");
  };
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "WEBGPT_ADAPTER_HEALTH_FAILED");
  assert.deepEqual(out.ack, { actionId: action.action_id, result: "failed", reason: "WEBGPT_ADAPTER_HEALTH_FAILED" });
  const state = await readExecutorState(checkpointPath);
  assert.equal(state.request_review.stage, "dispatch_failed");
});

test("crash between kernel decision and executor dispatch fails closed, never re-sends", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = requestReviewAction();
  const relayState = baseRelayState({ pending_action: pendingAction(action) });
  const { deps, calls } = fakeDeps();
  await writeExecutorState(checkpointPath, { ...createExecutorState(NOW), request_review: { action_id: action.action_id, head_sha: HEAD_A, stage: "sending", dispatched_at: NOW }, dispatch_fix: null });
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "WEBGPT_ADAPTER_HEALTH_FAILED");
  assert.equal(calls.dispatch, 0);
});

test("NOOP with sent inflight + exact-head receipt observes the receipt and ACKs succeeded", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = { ...requestReviewAction(), action: "NOOP", reason: "PENDING_ACTION_AWAITING_ACK" };
  const relayState = baseRelayState({ pending_action: pendingAction(requestReviewAction()) });
  const { deps } = fakeDeps();
  deps.fetchSnapshot = async () => snapshot([reviewComment(1, { decision: "PASS", head: HEAD_A })]);
  await writeExecutorState(checkpointPath, { ...createExecutorState(NOW), ...inflightSent(action.action_id), updated_at: NOW });
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "executed");
  assert.equal(out.reason, "REVIEW_RECEIPT_OBSERVED");
  assert.deepEqual(out.ack, { actionId: action.action_id, result: "succeeded" });
  assert.equal(out.receipt.decision, "PASS");
});

test("NOOP with sent inflight and no receipt yet returns pending (never blocks one tick)", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = { ...requestReviewAction(), action: "NOOP", reason: "PENDING_ACTION_AWAITING_ACK" };
  const relayState = baseRelayState({ pending_action: pendingAction(requestReviewAction()) });
  const { deps } = fakeDeps();
  deps.fetchSnapshot = async () => snapshot([]);
  await writeExecutorState(checkpointPath, { ...createExecutorState(NOW), ...inflightSent(action.action_id), updated_at: NOW });
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "pending");
  assert.equal(out.reason, "REVIEW_RECEIPT_WAIT");
  assert.equal(out.ack, null);
});

test("NOOP with sent inflight times out into a failed ACK after REVIEW_TIMEOUT_MS", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = { ...requestReviewAction(), action: "NOOP", reason: "PENDING_ACTION_AWAITING_ACK" };
  const relayState = baseRelayState({ pending_action: pendingAction(requestReviewAction()) });
  const { deps } = fakeDeps();
  deps.fetchSnapshot = async () => snapshot([]);
  const dispatchedAt = new Date(NOW_MS - REVIEW_TIMEOUT_MS - 60_000).toISOString();
  await writeExecutorState(checkpointPath, { ...createExecutorState(NOW), ...inflightSent(action.action_id, HEAD_A, dispatchedAt), updated_at: NOW });
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "WEBGPT_ADAPTER_HEALTH_FAILED");
});

// ---------------------------------------------------------------------------
// executeAction: DISPATCH_FIX
// ---------------------------------------------------------------------------

test("DISPATCH_FIX starts a deterministic worker terminal and stays pending (no premature succeeded ACK)", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = requestReviewAction({ action: "DISPATCH_FIX", action_id: `${REPO}:${PR}:${HEAD_A}:DISPATCH_FIX`, event_key: `${REPO}:${PR}:${HEAD_A}:FIX_REQUIRED`, reason: "FRESH_FIX_REQUIRED" });
  const relayState = baseRelayState({ pending_action: pendingAction(action) });
  const { deps, calls } = fakeDeps();
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "pending", "terminal start must not ACK succeeded");
  assert.equal(out.reason, "WORKER_TERMINAL_STARTED");
  assert.equal(out.ack, null, "no ACK until GitHub proves Worker completion");
  assert.equal(calls.listTerminals, 1);
  assert.equal(calls.createTerminal, 1);
  assert.equal(calls.sendTerminal, 1);
  assert.ok(out.receipt.terminal_title.includes("-worker"));
  const checkpoint = await readExecutorState(checkpointPath);
  assert.equal(checkpoint.dispatch_fix.stage, "dispatched");
  assert.equal(checkpoint.dispatch_fix.reviewed_head_sha, HEAD_A);
});

test("DISPATCH_FIX reuses an existing same-title terminal and stays pending (no duplicate, no ACK)", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = requestReviewAction({ action: "DISPATCH_FIX", action_id: `${REPO}:${PR}:${HEAD_A}:DISPATCH_FIX`, event_key: `${REPO}:${PR}:${HEAD_A}:FIX_REQUIRED`, reason: "FRESH_FIX_REQUIRED" });
  const relayState = baseRelayState({ pending_action: pendingAction(action) });
  const { deps, calls } = fakeDeps();
  deps.orca.listTerminals = async () => [{ title: "GBB-GH-4-A1-worker", handle: "term-old" }];
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "pending");
  assert.equal(out.reason, "WORKER_TERMINAL_REUSED");
  assert.equal(out.ack, null);
  assert.equal(calls.createTerminal, 0);
  assert.equal(calls.sendTerminal, 0);
  const state = await readExecutorState(checkpointPath);
  assert.equal(state.dispatch_fix.reused, true);
});

test("DISPATCH_FIX with ORCA start failure fails closed with an ACK", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = requestReviewAction({ action: "DISPATCH_FIX", action_id: `${REPO}:${PR}:${HEAD_A}:DISPATCH_FIX`, event_key: `${REPO}:${PR}:${HEAD_A}:FIX_REQUIRED`, reason: "FRESH_FIX_REQUIRED" });
  const relayState = baseRelayState({ pending_action: pendingAction(action) });
  const { deps } = fakeDeps();
  deps.orca.createTerminal = async () => {
    throw new Error("orca offline");
  };
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "OPENCODE_ADAPTER_START_FAILED");
  assert.deepEqual(out.ack, { actionId: action.action_id, result: "failed", reason: "OPENCODE_ADAPTER_START_FAILED" });
});

test("DISPATCH_FIX continuation without a new-head READY stays pending with no ACK and no duplicate launch", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = requestReviewAction({ action: "DISPATCH_FIX", action_id: `${REPO}:${PR}:${HEAD_A}:DISPATCH_FIX`, event_key: `${REPO}:${PR}:${HEAD_A}:FIX_REQUIRED`, reason: "FRESH_FIX_REQUIRED" });
  const relayState = baseRelayState({ pending_action: pendingAction(action) });
  const { deps, calls } = fakeDeps();

  // Tick 1: terminal start -> pending (checkpoint persisted, stage dispatched).
  deps.fetchSnapshot = async () => snapshot([]);
  const first = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(first.status, "pending");

  // Tick 2: NOOP continuation, still no READY on GitHub -> pending, no ACK,
  // same terminal reused (never a second launch).
  const noopAction = { ...action, action: "NOOP", action_id: null, event_key: null, reason: "PENDING_ACTION_AWAITING_ACK" };
  deps.fetchSnapshot = async () => snapshot([]);
  const second = await executeAction({ action: noopAction, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(second.status, "pending");
  assert.equal(second.reason, "WORKER_DISPATCH_WAIT");
  assert.equal(second.ack, null, "no succeeded ACK without GitHub proof");
  assert.equal(calls.createTerminal, 1, "must not relaunch a duplicate worker terminal");

  const checkpoint = await readExecutorState(checkpointPath);
  assert.equal(checkpoint.dispatch_fix.stage, "dispatched");
  assert.equal(checkpoint.dispatch_fix.action_id, action.action_id);
});

test("DISPATCH_FIX ACKs succeeded only after a strict READY bound to a NEW PR head", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = requestReviewAction({ action: "DISPATCH_FIX", action_id: `${REPO}:${PR}:${HEAD_A}:DISPATCH_FIX`, event_key: `${REPO}:${PR}:${HEAD_A}:FIX_REQUIRED`, reason: "FRESH_FIX_REQUIRED" });
  const relayState = baseRelayState({ pending_action: pendingAction(action) });
  const { deps, calls } = fakeDeps();

  // Tick 1: terminal start -> pending.
  deps.fetchSnapshot = async () => snapshot([]);
  const first = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(first.status, "pending");

  // Tick 2: Worker pushed a new head and posted a strict READY for it.
  const noopAction = { ...action, action: "NOOP", action_id: null, event_key: null, reason: "PENDING_ACTION_AWAITING_ACK" };
  deps.fetchSnapshot = async () => snapshot([readyComment(7, HEAD_B)], { head: { sha: HEAD_B, state: "OPEN", draft: true } });
  const second = await executeAction({ action: noopAction, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(second.status, "executed");
  assert.equal(second.reason, "WORKER_COMPLETION_OBSERVED");
  assert.deepEqual(second.ack, { actionId: action.action_id, result: "succeeded" });
  assert.equal(calls.createTerminal, 1, "completion must not relaunch the worker");

  const checkpoint = await readExecutorState(checkpointPath);
  assert.equal(checkpoint.dispatch_fix.stage, "completion_observed");
  assert.equal(checkpoint.dispatch_fix.completion_head_sha, HEAD_B);

  // The ACK must be applicable by the kernel: event processed, repair round bumped.
  const ackOut = applyAck(relayState, { actionId: second.ack.actionId, result: second.ack.result, now: NOW });
  assert.equal(ackOut.status, "PROCESSED");
  assert.equal(ackOut.state.pending_action, null);
  assert.ok(ackOut.state.processed_event_keys.includes(action.event_key));
  assert.equal(ackOut.state.repair.rounds, 1);
});

test("DISPATCH_FIX ignores a READY bound to the same reviewed head (stall protection)", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = requestReviewAction({ action: "DISPATCH_FIX", action_id: `${REPO}:${PR}:${HEAD_A}:DISPATCH_FIX`, event_key: `${REPO}:${PR}:${HEAD_A}:FIX_REQUIRED`, reason: "FRESH_FIX_REQUIRED" });
  const relayState = baseRelayState({ pending_action: pendingAction(action) });
  const { deps } = fakeDeps();
  deps.fetchSnapshot = async () => snapshot([]);
  await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });

  // A READY for the OLD reviewed head (HEAD_A) must not count as completion.
  const noopAction = { ...action, action: "NOOP", action_id: null, event_key: null, reason: "PENDING_ACTION_AWAITING_ACK" };
  deps.fetchSnapshot = async () => snapshot([readyComment(7, HEAD_A)], { head: { sha: HEAD_A, state: "OPEN", draft: true } });
  const out = await executeAction({ action: noopAction, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "pending", "same-head READY must not ACK completion");
  assert.equal(out.ack, null);
});

test("DISPATCH_FIX ignores a READY bound to a head that is not the current PR head (strict binding)", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = requestReviewAction({ action: "DISPATCH_FIX", action_id: `${REPO}:${PR}:${HEAD_A}:DISPATCH_FIX`, event_key: `${REPO}:${PR}:${HEAD_A}:FIX_REQUIRED`, reason: "FRESH_FIX_REQUIRED" });
  const relayState = baseRelayState({ pending_action: pendingAction(action) });
  const { deps } = fakeDeps();
  deps.fetchSnapshot = async () => snapshot([]);
  await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });

  // READY claims HEAD_B but the PR head has NOT advanced -> worker must wait.
  const noopAction = { ...action, action: "NOOP", action_id: null, event_key: null, reason: "PENDING_ACTION_AWAITING_ACK" };
  deps.fetchSnapshot = async () => snapshot([readyComment(7, HEAD_B)], { head: { sha: HEAD_A, state: "OPEN", draft: true } });
  const out = await executeAction({ action: noopAction, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "pending", "READY must be bound to the actual current PR head");
  assert.equal(out.ack, null);
});

test("DISPATCH_FIX stays pending across repeated no-READY ticks (stalled worker keeps the loop alive)", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = requestReviewAction({ action: "DISPATCH_FIX", action_id: `${REPO}:${PR}:${HEAD_A}:DISPATCH_FIX`, event_key: `${REPO}:${PR}:${HEAD_A}:FIX_REQUIRED`, reason: "FRESH_FIX_REQUIRED" });
  const relayState = baseRelayState({ pending_action: pendingAction(action) });
  const { deps, calls } = fakeDeps();
  deps.fetchSnapshot = async () => snapshot([]);

  await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });

  const noopAction = { ...action, action: "NOOP", action_id: null, event_key: null, reason: "PENDING_ACTION_AWAITING_ACK" };
  for (let i = 0; i < 5; i += 1) {
    const out = await executeAction({ action: noopAction, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
    assert.equal(out.status, "pending");
    assert.equal(out.reason, "WORKER_DISPATCH_WAIT");
    assert.equal(out.ack, null, "a stalled worker must never be ACKed succeeded");
  }
  assert.equal(calls.createTerminal, 1, "exactly one terminal across all stall ticks");
});

// ---------------------------------------------------------------------------
// executeAction: NOTIFY_HUMAN
// ---------------------------------------------------------------------------

test("NOTIFY_HUMAN posts exactly one notification comment and ACKs with its id", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const actionId = `${REPO}:${PR}:TRANSPORT_BLOCKED:NOTIFY_HUMAN`;
  const action = requestReviewAction({ action: "NOTIFY_HUMAN", action_id: actionId, reason: "TRANSPORT_BLOCKED", terminal: true, terminal_state: "TRANSPORT_BLOCKED" });
  const relayState = baseRelayState({ terminal: { active: true, state: "TRANSPORT_BLOCKED", reason: "TRANSPORT_BLOCKED", entered_at: NOW, notification_required: true, notification_event_key: "x", notification_comment_id: null } });
  const { deps, calls } = fakeDeps();
  deps.fetchSnapshot = async () => snapshot([]);
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "executed");
  assert.equal(out.reason, "NOTIFICATION_POSTED");
  assert.equal(calls.postComment, 1);
  assert.deepEqual(out.ack, { actionId, result: "succeeded", notificationCommentId: 9001 });
  const ackOut = applyAck(relayState, { actionId: out.ack.actionId, result: out.ack.result, notificationCommentId: out.ack.notificationCommentId, now: NOW });
  assert.equal(ackOut.status, "NOTIFICATION_RECORDED");
});

test("NOTIFY_HUMAN reuses an existing same-action notification across a crash window", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const actionId = `${REPO}:${PR}:TRANSPORT_BLOCKED:NOTIFY_HUMAN`;
  const action = requestReviewAction({ action: "NOTIFY_HUMAN", action_id: actionId, reason: "TRANSPORT_BLOCKED", terminal: true, terminal_state: "TRANSPORT_BLOCKED" });
  const relayState = baseRelayState({ terminal: { active: true, state: "TRANSPORT_BLOCKED", reason: "TRANSPORT_BLOCKED", entered_at: NOW, notification_required: true, notification_event_key: "x", notification_comment_id: null } });
  const { deps, calls } = fakeDeps();
  const existingBody = buildNotificationBody({ actionId, prNumber: PR, headSha: HEAD_A, terminalState: "TRANSPORT_BLOCKED", reason: "TRANSPORT_BLOCKED" });
  deps.fetchSnapshot = async () => snapshot([comment(500, existingBody)]);
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "executed");
  assert.equal(out.reason, "NOTIFICATION_REUSED");
  assert.equal(calls.postComment, 0);
  assert.deepEqual(out.ack, { actionId, result: "succeeded", notificationCommentId: 500 });
});

test("NOTIFY_HUMAN with a post failure fails closed with no ACK", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = requestReviewAction({ action: "NOTIFY_HUMAN", action_id: `${REPO}:${PR}:TRANSPORT_BLOCKED:NOTIFY_HUMAN`, reason: "TRANSPORT_BLOCKED", terminal: true, terminal_state: "TRANSPORT_BLOCKED" });
  const relayState = baseRelayState({ terminal: { active: true, state: "TRANSPORT_BLOCKED", reason: "TRANSPORT_BLOCKED", entered_at: NOW, notification_required: true, notification_event_key: "x", notification_comment_id: null } });
  const { deps } = fakeDeps();
  deps.fetchSnapshot = async () => snapshot([]);
  deps.postComment = async () => {
    throw new Error("gh offline");
  };
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "TRANSPORT_BLOCKED");
  assert.equal(out.ack, null);
});

// ---------------------------------------------------------------------------
// executeAction: terminal states and unknown actions
// ---------------------------------------------------------------------------

test("terminal states AWAITING_HUMAN_MERGE / HUMAN_INTERVENTION produce zero side effects", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  for (const actionName of ["AWAITING_HUMAN_MERGE", "HUMAN_INTERVENTION"]) {
    const relayState = baseRelayState({ terminal: { active: true, state: "BLOCKED_FOR_HUMAN", reason: "REVIEW_BLOCKED", entered_at: NOW, notification_required: true, notification_event_key: "x", notification_comment_id: null } });
    const action = requestReviewAction({ action: actionName, reason: "TERMINAL_STATE_NO_SIDE_EFFECT" });
    const { deps, calls } = fakeDeps();
    const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
    assert.equal(out.status, "noop");
    assert.equal(out.reason, "TERMINAL_STATE_NO_SIDE_EFFECT");
    assert.equal(out.ack, null);
    assert.equal(calls.dispatch, 0);
    assert.equal(calls.postComment, 0);
    assert.equal(calls.createTerminal, 0);
  }
});

test("an unknown action fails closed with zero external side effects", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const relayState = baseRelayState();
  const action = requestReviewAction({ action: "SELF_MERGE", reason: "UNKNOWN" });
  const { deps, calls } = fakeDeps();
  const out = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "UNKNOWN_ACTION");
  assert.equal(out.ack, null);
  assert.equal(calls.dispatch, 0);
  assert.equal(calls.postComment, 0);
  assert.equal(calls.createTerminal, 0);
  assert.equal(calls.fetchSnapshot, 0);
});

test("executeAction applies the kernel decision flow end-to-end: REQUEST_REVIEW -> receipt -> ack", async (t) => {
  const checkpointPath = await tempCheckpoint(t);
  const action = requestReviewAction();
  const relayState = baseRelayState({ pending_action: pendingAction(action) });
  const { deps, calls } = fakeDeps();

  // First tick: dispatch (no receipt yet on GitHub).
  deps.fetchSnapshot = async () => snapshot([]);
  const first = await executeAction({ action, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(first.status, "pending");
  assert.equal(calls.dispatch, 1);

  // Second tick: the exact-head receipt is now present -> observed, ACK.
  const noopAction = { ...action, action: "NOOP", reason: "PENDING_ACTION_AWAITING_ACK" };
  deps.fetchSnapshot = async () => snapshot([reviewComment(7, { decision: "PASS", head: HEAD_A })]);
  const second = await executeAction({ action: noopAction, relayState, deps: { ...deps, checkpointPath }, checkpointPath, nowMs: NOW_MS, nowIso: NOW });
  assert.equal(second.status, "executed");
  assert.equal(second.reason, "REVIEW_RECEIPT_OBSERVED");
  assert.deepEqual(second.ack, { actionId: action.action_id, result: "succeeded" });

  // The ack the executor returns must be applicable by the kernel supervisor.
  const ackOut = applyAck(relayState, { actionId: second.ack.actionId, result: second.ack.result, now: NOW });
  assert.equal(ackOut.status, "PROCESSED");
  assert.equal(ackOut.state.pending_action, null);
  assert.ok(ackOut.state.processed_event_keys.includes(action.event_key));
});
