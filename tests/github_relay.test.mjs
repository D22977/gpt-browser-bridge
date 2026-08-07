// GPT_BROWSER_BRIDGE - GitHub Relay Kernel v1 tests (GBB-GH-01)
// node:test only. No third-party test framework, no new dependencies.
// Covers the 22 mandatory cases in GBB-GH-01 §15 plus ACK/recovery details.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../src/github_relay.mjs", import.meta.url));
const NODE = process.execPath;

import {
  SCHEMA_VERSION,
  PROTOCOL_ACTION,
  REVIEW_PROTOCOL,
  READY_MARKER,
  TERMINAL_FAILURE_REASONS,
  createInitialState,
  validateState,
  evaluate,
  applyDecision,
  applyAck,
  readStateFile,
  writeStateFile,
  extractJsonObjects,
  parseReviewResults,
  findReadyComment,
  readyCommentSha,
  runPoll,
  fetchSnapshotViaGh,
} from "../src/github_relay.mjs";

const REPO = "D22977/MEP-";
const ISSUE = 3;
const PR = 4;
const HEAD_A = "f8e644871036f190b6e6385f3969f65ec9b016fb";
const HEAD_B = "111122223333444455556666777788889999aaaa";
const HEAD_C = "22223333444455556666777788889999aaaabbbb";

const NOW = "2026-08-07T16:00:00+08:00";

function makeState(overrides = {}) {
  const base = createInitialState(REPO, ISSUE, PR, NOW);
  const merged = { ...base, ...overrides };
  merged.observed = { ...base.observed, ...(overrides.observed ?? {}) };
  merged.repair = { ...base.repair, ...(overrides.repair ?? {}) };
  merged.terminal = { ...base.terminal, ...(overrides.terminal ?? {}) };
  return merged;
}

function comment(id, body, created_at = NOW) {
  return { id, body, created_at };
}

function readyComment(id, headSha, created_at = NOW, baseSha = HEAD_A) {
  return comment(
    id,
    `## READY_FOR_REVIEW\nprotocol: GBB_GH_READY_FOR_REVIEW_V1\nbase_sha: ${baseSha}\nhead_sha: ${headSha}\n`,
    created_at,
  );
}

function reviewComment(id, { decision, head = HEAD_A, pr_number = PR, created_at = NOW, card_id = "MRMP-P1-001" }) {
  const result = {
    protocol: REVIEW_PROTOCOL,
    card_id,
    pr_number,
    reviewed_head_sha: head,
    decision,
  };
  return comment(id, `Review:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\``, created_at);
}

function snapshot(head = HEAD_A, comments = [], extra = {}) {
  return {
    repo: REPO,
    issue_number: ISSUE,
    pr_number: PR,
    head: { sha: head, state: "OPEN", draft: true },
    comments,
    ...extra,
  };
}

function actionOf(decision) {
  return decision.action;
}

test("1. current READY -> REQUEST_REVIEW", () => {
  const state = makeState();
  const snap = snapshot(HEAD_A, [readyComment(1, HEAD_A)]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "REQUEST_REVIEW");
  assert.equal(d.protocol, PROTOCOL_ACTION);
  assert.equal(d.action_id, `${REPO}:${PR}:${HEAD_A}:REQUEST_REVIEW`);
  assert.equal(d.event_key, `${REPO}:${PR}:${HEAD_A}:READY`);
  assert.equal(d.reason, "CURRENT_HEAD_READY_FOR_REVIEW");
  assert.equal(d.terminal, false);
});

test("2. duplicate READY same head -> NOOP", () => {
  const key = `${REPO}:${PR}:${HEAD_A}:READY`;
  const state = makeState({ processed_event_keys: [key] });
  const snap = snapshot(HEAD_A, [readyComment(1, HEAD_A), readyComment(2, HEAD_A)]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "NOOP");
});

test("3. new READY new head -> new REQUEST_REVIEW", () => {
  const key = `${REPO}:${PR}:${HEAD_A}:READY`;
  const state = makeState({ processed_event_keys: [key] });
  const snap = snapshot(HEAD_B, [readyComment(1, HEAD_B)]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "REQUEST_REVIEW");
  assert.equal(d.event_key, `${REPO}:${PR}:${HEAD_B}:READY`);
});

test("4. fresh FIX_REQUIRED round 0 -> DISPATCH_FIX", () => {
  const state = makeState();
  const snap = snapshot(HEAD_A, [reviewComment(1, { decision: "FIX_REQUIRED", head: HEAD_A })]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "DISPATCH_FIX");
  assert.equal(d.action_id, `${REPO}:${PR}:${HEAD_A}:DISPATCH_FIX`);
  assert.equal(d.reason, "FRESH_FIX_REQUIRED");
});

test("5. stale FIX_REQUIRED -> NOOP", () => {
  const state = makeState();
  const snap = snapshot(HEAD_A, [reviewComment(1, { decision: "FIX_REQUIRED", head: HEAD_B })]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "NOOP");
  assert.equal(d.reviewed_head_sha, HEAD_B);
});

test("6. fresh PASS -> AWAITING_HUMAN_MERGE", () => {
  const state = makeState();
  const snap = snapshot(HEAD_A, [reviewComment(1, { decision: "PASS", head: HEAD_A })]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "AWAITING_HUMAN_MERGE");
  assert.equal(d.terminal, true);
  assert.equal(d.terminal_state, "PASS_AWAITING_MANUAL_MERGE");
  assert.equal(d.reason, "FRESH_REVIEW_PASS");
});

test("7. stale PASS -> NOOP", () => {
  const state = makeState();
  const snap = snapshot(HEAD_A, [reviewComment(1, { decision: "PASS", head: HEAD_B })]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "NOOP");
});

test("8. fresh BLOCKED -> HUMAN_INTERVENTION", () => {
  const state = makeState();
  const snap = snapshot(HEAD_A, [reviewComment(1, { decision: "BLOCKED", head: HEAD_A })]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "HUMAN_INTERVENTION");
  assert.equal(d.reason, "REVIEW_BLOCKED");
  assert.equal(d.terminal, true);
  assert.equal(d.terminal_state, "BLOCKED_FOR_HUMAN");
});

test("9. repair round 2 + FIX_REQUIRED -> HUMAN_INTERVENTION", () => {
  const state = makeState({ repair: { rounds: 2, max_rounds: 2, cooldown_minutes: 5, last_repair_at: NOW } });
  const snap = snapshot(HEAD_A, [reviewComment(1, { decision: "FIX_REQUIRED", head: HEAD_A })]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "HUMAN_INTERVENTION");
  assert.equal(d.reason, "MAX_REPAIR_ROUNDS_EXCEEDED");
  assert.equal(d.terminal, true);
});

test("10. cooldown active -> NOOP", () => {
  const state = makeState({
    repair: { rounds: 1, max_rounds: 2, cooldown_minutes: 5, last_repair_at: "2026-08-07T15:57:00+08:00" },
  });
  const snap = snapshot(HEAD_A, [reviewComment(1, { decision: "FIX_REQUIRED", head: HEAD_A })]);
  const d = evaluate(snap, state, "2026-08-07T16:00:00+08:00");
  assert.equal(actionOf(d), "NOOP");
  assert.equal(d.reason, "REPAIR_COOLDOWN");
});

test("11. malformed review -> HUMAN_INTERVENTION", () => {
  const state = makeState();
  const snap = snapshot(HEAD_A, [
    comment(1, `Review:\n\`\`\`json\n{"protocol":"${REVIEW_PROTOCOL}","card_id":"MRMP-P1-001","pr_number":4,"reviewed_head_sha":"${HEAD_A}","decision":"MAYBE"}\n\`\`\``),
  ]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "HUMAN_INTERVENTION");
  assert.equal(d.reason, "REVIEW_RESULT_MALFORMED");
  assert.equal(d.terminal, true);
});

test("12. pending action -> NOOP", () => {
  const state = makeState({
    pending_action: {
      action_id: `${REPO}:${PR}:${HEAD_A}:REQUEST_REVIEW`,
      event_key: `${REPO}:${PR}:${HEAD_A}:READY`,
      action: "REQUEST_REVIEW",
      head_sha: HEAD_A,
      created_at: NOW,
    },
  });
  const snap = snapshot(HEAD_A, [readyComment(1, HEAD_A)]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "NOOP");
  assert.equal(d.reason, "PENDING_ACTION_AWAITING_ACK");
});

test("13. failed action ACK does not mark processed", () => {
  const key = `${REPO}:${PR}:${HEAD_A}:READY`;
  const state = makeState({
    pending_action: {
      action_id: `${REPO}:${PR}:${HEAD_A}:REQUEST_REVIEW`,
      event_key: key,
      action: "REQUEST_REVIEW",
      head_sha: HEAD_A,
      created_at: NOW,
    },
  });
  const out = applyAck(state, { actionId: state.pending_action.action_id, result: "failed", reason: "WEBGPT_ADAPTER_HEALTH_FAILED", now: NOW });
  assert.equal(out.changed, true);
  assert.equal(out.status, "TERMINAL_FAILURE");
  assert.ok(!out.state.processed_event_keys.includes(key));
  assert.equal(out.state.pending_action, null);
  assert.equal(out.state.terminal.active, true);
  assert.equal(out.state.terminal.notification_required, true);
});

test("14. successful ACK marks event processed", () => {
  const key = `${REPO}:${PR}:${HEAD_A}:READY`;
  const state = makeState({
    pending_action: {
      action_id: `${REPO}:${PR}:${HEAD_A}:REQUEST_REVIEW`,
      event_key: key,
      action: "REQUEST_REVIEW",
      head_sha: HEAD_A,
      created_at: NOW,
    },
  });
  const out = applyAck(state, { actionId: state.pending_action.action_id, result: "succeeded", now: NOW });
  assert.equal(out.status, "PROCESSED");
  assert.ok(out.state.processed_event_keys.includes(key));
  assert.equal(out.state.pending_action, null);
  assert.equal(out.state.terminal.active, false);
});

test("15. successful DISPATCH_FIX ACK increments repair round exactly once", () => {
  const key = `${REPO}:${PR}:${HEAD_A}:FIX_REQUIRED`;
  const state = makeState({
    repair: { rounds: 0, max_rounds: 2, cooldown_minutes: 5, last_repair_at: null },
    pending_action: {
      action_id: `${REPO}:${PR}:${HEAD_A}:DISPATCH_FIX`,
      event_key: key,
      action: "DISPATCH_FIX",
      head_sha: HEAD_A,
      created_at: NOW,
    },
  });
  const out = applyAck(state, { actionId: state.pending_action.action_id, result: "succeeded", now: NOW });
  assert.equal(out.state.repair.rounds, 1);
  assert.equal(out.state.repair.last_repair_at, NOW);
  assert.ok(out.state.processed_event_keys.includes(key));
});

test("16. duplicate ACK does not increment twice", () => {
  const key = `${REPO}:${PR}:${HEAD_A}:FIX_REQUIRED`;
  const state = makeState({
    repair: { rounds: 0, max_rounds: 2, cooldown_minutes: 5, last_repair_at: null },
    pending_action: {
      action_id: `${REPO}:${PR}:${HEAD_A}:DISPATCH_FIX`,
      event_key: key,
      action: "DISPATCH_FIX",
      head_sha: HEAD_A,
      created_at: NOW,
    },
  });
  const actionId = state.pending_action.action_id;
  const first = applyAck(state, { actionId, result: "succeeded", now: NOW });
  assert.equal(first.state.repair.rounds, 1);
  const second = applyAck(first.state, { actionId, result: "succeeded", now: NOW });
  assert.equal(second.changed, false);
  assert.equal(second.status, "NO_PENDING");
  assert.equal(second.state.repair.rounds, 1);
});

test("17. pending-notification terminal -> repeatable NOTIFY_HUMAN (F004-R2)", () => {
  const state = makeState({
    terminal: {
      active: true,
      state: "PASS_AWAITING_MANUAL_MERGE",
      reason: "FRESH_REVIEW_PASS",
      entered_at: NOW,
      notification_required: true,
      notification_event_key: null,
      notification_comment_id: null,
    },
  });
  const snap = snapshot(HEAD_A, [reviewComment(1, { decision: "PASS", head: HEAD_A }), readyComment(2, HEAD_A)]);
  const d = evaluate(snap, state, NOW);
  // Crash-window durability: a terminal that still owes a human notification
  // is NOT settled. evaluate() re-emits NOTIFY_HUMAN so a crash between
  // terminal-entry and notification-delivery is re-driven, not silently dropped.
  assert.equal(actionOf(d), "NOTIFY_HUMAN");
  assert.equal(d.reason, "TERMINAL_NOTIFICATION_PENDING");
  assert.equal(d.terminal, true);
  assert.equal(d.terminal_state, "PASS_AWAITING_MANUAL_MERGE");
});

test("17b. settled terminal (notification comment ACKed) -> permanent NOOP (F004-R2)", () => {
  const state = makeState({
    terminal: {
      active: true,
      state: "PASS_AWAITING_MANUAL_MERGE",
      reason: "FRESH_REVIEW_PASS",
      entered_at: NOW,
      notification_required: false,
      notification_event_key: null,
      notification_comment_id: 9001,
    },
  });
  const snap = snapshot(HEAD_A, [reviewComment(1, { decision: "PASS", head: HEAD_A }), readyComment(2, HEAD_A)]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "NOOP");
  assert.equal(d.reason, "TERMINAL_STATE");
});

test("17c. applyAck records notification comment id and settles terminal (F004-R2)", () => {
  const state = makeState({
    terminal: {
      active: true,
      state: "PASS_AWAITING_MANUAL_MERGE",
      reason: "FRESH_REVIEW_PASS",
      entered_at: NOW,
      notification_required: true,
      notification_event_key: null,
      notification_comment_id: null,
    },
  });
  const out = applyAck(state, { result: "succeeded", notificationCommentId: 9001, now: NOW });
  assert.equal(out.changed, true);
  assert.equal(out.status, "NOTIFICATION_RECORDED");
  assert.equal(out.state.terminal.notification_required, false);
  assert.equal(out.state.terminal.notification_comment_id, 9001);
  // A subsequent evaluate sees a settled terminal -> permanent NOOP.
  const snap = snapshot(HEAD_A, [reviewComment(1, { decision: "PASS", head: HEAD_A })]);
  const d = evaluate(snap, out.state, NOW);
  assert.equal(actionOf(d), "NOOP");
  assert.equal(d.reason, "TERMINAL_STATE");
});

test("17d. notification ACK without a pending notification -> no-op (F004-R2)", () => {
  const state = makeState();
  const out = applyAck(state, { result: "succeeded", notificationCommentId: 9001, now: NOW });
  assert.equal(out.changed, false);
  assert.equal(out.status, "NO_PENDING");
});

test("18. state atomic-write recovery does not accept partial JSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-gh-relay-atomic-"));
  const statePath = path.join(dir, "github_relay.json");
  const state = makeState();
  await writeStateFile(statePath, state);
  const reloaded = await readStateFile(statePath);
  assert.equal(reloaded.schema_version, SCHEMA_VERSION);
  assert.deepEqual(reloaded.repair, state.repair);

const corrupt = path.join(dir, "corrupt.json");
  await writeFile(corrupt, '{"schema_version":1,"protocol":"GBB_GH_RELAY_STATE_V1","observed":');
  await assert.rejects(() => readStateFile(corrupt), /not valid JSON/);
  assert.throws(() => validateState(null), /not an object/);
  assert.throws(() => validateState({ ...state, protocol: "NOPE" }), /protocol mismatch/);
});

test("19. same head with two READY comments dispatches once", () => {
  const state = makeState();
  const snap = snapshot(HEAD_A, [readyComment(1, HEAD_A), readyComment(2, HEAD_A, "2026-08-07T16:05:00+08:00")]);
  const d1 = evaluate(snap, state, NOW);
  assert.equal(actionOf(d1), "REQUEST_REVIEW");
  const next = applyDecision(state, d1, NOW);
  const d2 = evaluate(snap, next, NOW);
  assert.equal(actionOf(d2), "NOOP");
  assert.equal(d2.reason, "PENDING_ACTION_AWAITING_ACK");
});

test("20. newer head invalidates old review", () => {
  const state = makeState({ observed: { current_head_sha: HEAD_B } });
  const snap = snapshot(HEAD_B, [reviewComment(1, { decision: "PASS", head: HEAD_A })]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "NOOP");
  assert.equal(d.reviewed_head_sha, HEAD_A);
});

test("21. evaluate never mutates state", () => {
  const state = makeState();
  const frozen = JSON.stringify(state);
  const snap = snapshot(HEAD_A, [readyComment(1, HEAD_A)]);
  evaluate(snap, state, NOW);
  evaluate(snap, state, NOW);
  assert.equal(JSON.stringify(state), frozen);
});

test("22. poll --dry-run never mutates state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-gh-relay-dry-"));
  const statePath = path.join(dir, "github_relay.json");
  const state = makeState();
  await writeStateFile(statePath, state);
  const before = await readFile(statePath, "utf8");

  const snap = snapshot(HEAD_A, [readyComment(1, HEAD_A)]);
  const result = await runPoll({
    repo: REPO,
    issue: ISSUE,
    pr: PR,
    statePath,
    now: NOW,
    dryRun: true,
    fetchSnapshot: async () => snap,
  });
  assert.equal(result.code, 0);
  assert.equal(actionOf(result.action), "REQUEST_REVIEW");
  const after = await readFile(statePath, "utf8");
  assert.equal(after, before);
});

test("cooldown satisfied after window -> DISPATCH_FIX again", () => {
  const state = makeState({
    repair: { rounds: 1, max_rounds: 2, cooldown_minutes: 5, last_repair_at: "2026-08-07T15:50:00+08:00" },
  });
  const snap = snapshot(HEAD_A, [reviewComment(1, { decision: "FIX_REQUIRED", head: HEAD_A })]);
  const d = evaluate(snap, state, "2026-08-07T16:00:00+08:00");
  assert.equal(actionOf(d), "DISPATCH_FIX");
});

test("non-terminal failed ACK keeps pending and never processed", () => {
  const key = `${REPO}:${PR}:${HEAD_A}:READY`;
  const state = makeState({
    pending_action: {
      action_id: `${REPO}:${PR}:${HEAD_A}:REQUEST_REVIEW`,
      event_key: key,
      action: "REQUEST_REVIEW",
      head_sha: HEAD_A,
      created_at: NOW,
    },
  });
  const out = applyAck(state, { actionId: state.pending_action.action_id, result: "failed", reason: "SOMETHING_TRANSIENT", now: NOW });
  assert.equal(out.status, "FAILURE_NOT_PROCESSED");
  assert.equal(out.changed, false);
  assert.ok(!out.state.processed_event_keys.includes(key));
  assert.ok(out.state.pending_action);
});

test("poll writes pending action and persists state on actionable event", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-gh-relay-poll-"));
  const statePath = path.join(dir, "github_relay.json");
  const state = makeState();
  await writeStateFile(statePath, state);

  const snap = snapshot(HEAD_A, [readyComment(1, HEAD_A)]);
  const result = await runPoll({
    repo: REPO,
    issue: ISSUE,
    pr: PR,
    statePath,
    now: NOW,
    dryRun: false,
    fetchSnapshot: async () => snap,
  });
  assert.equal(result.code, 0);
  assert.equal(actionOf(result.action), "REQUEST_REVIEW");
  const persisted = await readStateFile(statePath);
  assert.ok(persisted.pending_action);
  assert.equal(persisted.pending_action.action_id, `${REPO}:${PR}:${HEAD_A}:REQUEST_REVIEW`);
  assert.equal(persisted.observed.current_head_sha, HEAD_A);
});

test("poll transport failure -> HUMAN_INTERVENTION TRANSPORT_BLOCKED, exit 3", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-gh-relay-tls-"));
  const statePath = path.join(dir, "github_relay.json");
  await writeStateFile(statePath, makeState());
  const result = await runPoll({
    repo: REPO,
    issue: ISSUE,
    pr: PR,
    statePath,
    now: NOW,
    dryRun: false,
    fetchSnapshot: async () => {
      throw new Error("gh: x509 certificate error");
    },
  });
  assert.equal(result.code, 3);
  assert.equal(actionOf(result.action), "HUMAN_INTERVENTION");
  assert.equal(result.action.reason, "TRANSPORT_BLOCKED");
  assert.equal(result.action.terminal, true);
  const persisted = await readStateFile(statePath);
  assert.equal(persisted.terminal.active, true);
  assert.equal(persisted.terminal.notification_required, true);
});

test("F004-R2 poll crash-window: pending notification re-emits NOTIFY_HUMAN until comment ACK", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-gh-relay-notify-"));
  const statePath = path.join(dir, "github_relay.json");
  const state = makeState();
  await writeStateFile(statePath, state);

  // 1. Poll sees a fresh PASS -> terminal entered with notification_required.
  const passSnap = snapshot(HEAD_A, [reviewComment(1, { decision: "PASS", head: HEAD_A })]);
  const first = await runPoll({
    repo: REPO, issue: ISSUE, pr: PR, statePath, now: NOW, dryRun: false,
    fetchSnapshot: async () => passSnap,
  });
  assert.equal(first.code, 0);
  assert.equal(actionOf(first.action), "AWAITING_HUMAN_MERGE");
  const persisted = await readStateFile(statePath);
  assert.equal(persisted.terminal.notification_required, true);
  assert.equal(persisted.terminal.notification_comment_id, null);

  // 2. Simulate a crash window: re-poll the SAME durable state before any
  //    notification comment was ACKed. The kernel must re-emit NOTIFY_HUMAN
  //    (repeatable), never silently settle to a permanent NOOP.
  const second = await runPoll({
    repo: REPO, issue: ISSUE, pr: PR, statePath, now: NOW, dryRun: true,
    fetchSnapshot: async () => passSnap,
  });
  assert.equal(actionOf(second.action), "NOTIFY_HUMAN");
  assert.equal(second.action.reason, "TERMINAL_NOTIFICATION_PENDING");

  // 3. Downstream posts the human-intervention comment and ACKs its comment id.
  const ackOut = applyAck(persisted, { result: "succeeded", notificationCommentId: 9002, now: NOW });
  assert.equal(ackOut.status, "NOTIFICATION_RECORDED");
  await writeStateFile(statePath, ackOut.state);

  // 4. Now the terminal is settled -> permanent NOOP on subsequent polls.
  const third = await runPoll({
    repo: REPO, issue: ISSUE, pr: PR, statePath, now: NOW, dryRun: true,
    fetchSnapshot: async () => passSnap,
  });
  assert.equal(actionOf(third.action), "NOOP");
  assert.equal(third.action.reason, "TERMINAL_STATE");
});

test("poll with corrupt relay state -> exit 4", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-gh-relay-corrupt-"));
  const statePath = path.join(dir, "github_relay.json");
  await writeFile(statePath, "not json at all");
  const result = await runPoll({
    repo: REPO,
    issue: ISSUE,
    pr: PR,
    statePath,
    now: NOW,
    dryRun: true,
    fetchSnapshot: async () => snapshot(HEAD_A),
  });
  assert.equal(result.code, 4);
});

test("F002 poll propagates issue-read failure to exit 3 (no silent empty issue)", async () => {
  // Exercise the REAL default snapshot fetcher with a fake exec that lets the
  // PR read succeed but forces the issue read to fail. fetchSnapshotViaGh must
  // NOT swallow that into an empty comment list; it must reject so runPoll()
  // enters TRANSPORT_BLOCKED / exit 3.
  const fakeExec = async (cmd, args) => {
    const argStr = args.join(" ");
    if (argStr.includes("pr view")) {
      return {
        stdout: JSON.stringify({
          number: PR,
          state: "OPEN",
          isDraft: true,
          headRefOid: HEAD_A,
          comments: [],
        }),
      };
    }
    if (argStr.includes("issue view")) {
      throw new Error("gh issue view: x509 certificate error");
    }
    throw new Error(`unexpected cmd: ${cmd} ${argStr}`);
  };
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-gh-relay-issuefail-"));
  const statePath = path.join(dir, "github_relay.json");
  await writeStateFile(statePath, makeState());
  const result = await runPoll({
    repo: REPO,
    issue: ISSUE,
    pr: PR,
    statePath,
    now: NOW,
    dryRun: false,
    fetchSnapshot: (p) => fetchSnapshotViaGh(p, fakeExec),
  });
  assert.equal(result.code, 3);
  assert.equal(result.action.reason, "TRANSPORT_BLOCKED");
  const persisted = await readStateFile(statePath);
  assert.equal(persisted.terminal.notification_required, true);
  // Must not have persisted a REQUEST_REVIEW based on a partial (PR-only) read.
  assert.equal(persisted.pending_action, null);
});

test("parseReviewResults ignores non-review comments and other-card reviews", () => {
  const comments = [
    comment(1, "just a note"),
    reviewComment(2, { decision: "PASS", head: HEAD_A, pr_number: 999 }),
    reviewComment(3, { decision: "FIX_REQUIRED", head: HEAD_A }),
  ];
  const { newest, hasValid, malformed } = parseReviewResults(comments, PR);
  assert.equal(hasValid, true);
  assert.equal(malformed, true); // wrong pr_number attempt is malformed
  assert.equal(newest.result.decision, "FIX_REQUIRED");
});

test("review selection picks newest valid result", () => {
  const comments = [
    reviewComment(1, { decision: "FIX_REQUIRED", head: HEAD_A, created_at: "2026-08-07T15:00:00+08:00" }),
    reviewComment(2, { decision: "PASS", head: HEAD_A, created_at: "2026-08-07T17:00:00+08:00" }),
  ];
  const { newest } = parseReviewResults(comments, PR);
  assert.equal(newest.result.decision, "PASS");
});

test("extractJsonObjects handles fenced and inline JSON", () => {
  const fenced = extractJsonObjects('```json\n{"a":1}\n```');
  assert.deepEqual(fenced, [{ a: 1 }]);
  const inline = extractJsonObjects('prefix {"b":2} suffix');
  assert.deepEqual(inline, [{ b: 2 }]);
  assert.deepEqual(extractJsonObjects("no json here"), []);
});

test("findReadyComment and readyCommentSha extract the head", () => {
  const c = readyComment(1, HEAD_C);
  const comments = [comment(0, "plain"), c];
  assert.equal(findReadyComment(comments).id, 1);
  assert.equal(readyCommentSha(c), HEAD_C);
  assert.equal(readyCommentSha(comment(2, "no sha")), null);
});

test("F001 readyCommentSha binds the head_sha field, never a prior SHA (e.g. base_sha)", () => {
  const headFirst = comment(9, `## READY_FOR_REVIEW\nhead_sha: ${HEAD_C}\nbase_sha: ${HEAD_B}\n`);
  const baseFirst = comment(10, `## READY_FOR_REVIEW\nbase_sha: ${HEAD_B}\nhead_sha: ${HEAD_C}\n`);
  const reviewed = comment(11, `## READY_FOR_REVIEW\nreviewed_head_sha: ${HEAD_B}\nhead_sha: ${HEAD_C}\n`);
  assert.equal(readyCommentSha(headFirst), HEAD_C);
  assert.equal(readyCommentSha(baseFirst), HEAD_C);
  // a non-head_sha field carrying a 40-char SHA must NOT be mistaken for the head
  assert.equal(readyCommentSha(reviewed), HEAD_C);
  // bare marker with no head_sha field -> fail closed
  assert.equal(readyCommentSha(comment(12, `## READY_FOR_REVIEW\nbase_sha: ${HEAD_B}\n`)), null);
});

test("F001-R2 evaluate fails closed when READY marker has no exact head SHA", () => {
  const state = makeState();
  // HEAD is live and a READY marker exists, but it carries no head_sha field.
  const snap = snapshot(HEAD_A, [comment(13, `## READY_FOR_REVIEW\nprotocol: GBB_GH_READY_FOR_REVIEW_V1\nbase_sha: ${HEAD_B}\n`)]);
  const d = evaluate(snap, state, NOW);
  // Must NOT assume the marker refers to the current head. A malformed READY
  // must fail closed into human intervention, not silently fall through.
  assert.equal(actionOf(d), "HUMAN_INTERVENTION");
  assert.equal(d.reason, "READY_EVENT_MALFORMED");
  assert.equal(d.terminal, true);
  assert.equal(d.terminal_state, "BLOCKED_FOR_HUMAN");
});

test("F001-R2 invalid head_sha field also fails closed as READY_EVENT_MALFORMED", () => {
  const state = makeState();
  const snap = snapshot(HEAD_A, [comment(14, `## READY_FOR_REVIEW\nprotocol: GBB_GH_READY_FOR_REVIEW_V1\nhead_sha: not-a-sha\n`)]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "HUMAN_INTERVENTION");
  assert.equal(d.reason, "READY_EVENT_MALFORMED");
  assert.equal(d.terminal, true);
});

test("F001 READY bound to a different head than current does not dispatch REQUEST_REVIEW", () => {
  const state = makeState();
  // READY explicitly bound to HEAD_B while live head is HEAD_A.
  const snap = snapshot(HEAD_A, [readyComment(1, HEAD_B, NOW)]);
  const d = evaluate(snap, state, NOW);
  assert.equal(actionOf(d), "NOOP");
});

test("applyDecision sets pending action for REQUEST_REVIEW and DISPATCH_FIX", () => {
  const state = makeState();
  const dReq = evaluate(snapshot(HEAD_A, [readyComment(1, HEAD_A)]), state, NOW);
  const nextReq = applyDecision(state, dReq, NOW);
  assert.equal(nextReq.pending_action.action, "REQUEST_REVIEW");
  assert.equal(nextReq.observed.last_ready_head_sha, HEAD_A);

  const fresh = makeState();
  const dFix = evaluate(snapshot(HEAD_A, [reviewComment(1, { decision: "FIX_REQUIRED", head: HEAD_A })]), fresh, NOW);
  const nextFix = applyDecision(fresh, dFix, NOW);
  assert.equal(nextFix.pending_action.action, "DISPATCH_FIX");
});

test("applyDecision enters terminal with notification requirement", () => {
  const state = makeState();
  const d = evaluate(snapshot(HEAD_A, [reviewComment(1, { decision: "PASS", head: HEAD_A })]), state, NOW);
  const next = applyDecision(state, d, NOW);
  assert.equal(next.terminal.active, true);
  assert.equal(next.terminal.state, "PASS_AWAITING_MANUAL_MERGE");
  assert.equal(next.terminal.notification_required, true);
  assert.equal(next.pending_action, null);
});

test("terminal failure reasons set covers the documented codes", () => {
  assert.deepEqual(TERMINAL_FAILURE_REASONS, [
    "WEBGPT_ADAPTER_HEALTH_FAILED",
    "OPENCODE_ADAPTER_START_FAILED",
    "TRANSPORT_BLOCKED",
  ]);
});

test("F003 CLI missing required args -> exit 2 with no stack trace", async () => {
  const r = spawnSync(NODE, [ENTRY, "evaluate", "--snapshot", "x.json"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing --state/);
  // process-level requirement: no JS stack trace leaks to the CLI surface.
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("F003 CLI invalid --now -> exit 2 with no stack trace", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-gh-relay-now-"));
  const snapPath = path.join(dir, "snap.json");
  await writeFile(snapPath, JSON.stringify({
    repo: REPO,
    issue_number: ISSUE,
    pr_number: PR,
    head: { sha: HEAD_A, state: "OPEN", draft: true },
    comments: [],
  }));
  const statePath = path.join(dir, "state.json");
  const r = spawnSync(NODE, [ENTRY, "evaluate", "--snapshot", snapPath, "--state", statePath, "--now", "not-a-date"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid --now/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("F003 CLI unknown subcommand -> exit 2", async () => {
  const r = spawnSync(NODE, [ENTRY, "nope"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown subcommand/);
});
