import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { authorizeControlSuccessor, consumeDeliveredControlSuccessor, runG34ResidentCycle } = await import("../src/g34_resident.mjs").catch(() => ({}));
const { markSourceEventConsumed } = await import("../src/g34_source_event_publisher.mjs").catch(() => ({}));

const activeId = "6ac3b22a-a830-83e8-852c-f01a16cebf24";
const authority = {
  control_generation: "034", active_control_id: activeId, control_conversation_id: activeId,
  active_control_github_login: "D22977",
  source_comment_ids: { switch: "1001", index43: "1002", index81: "1003", rehydration_ack: "1004" },
};
const event = {
  event_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  state: "DELIVERED", source_comment_id: "6083328488", source_body_sha256: "b".repeat(64),
};

function decision(overrides = {}) {
  const fields = {
    marker: "GBB_G34_CONTROL_SUCCESSOR_ACCEPTANCE_V1",
    state: "SUCCESSOR_ACCEPTED",
    recorded_by_role: "ACTIVE_CONTROL",
    control_generation: "034",
    active_control_id: activeId,
    control_conversation_id: activeId,
    source_event_id: event.event_id,
    source_comment_id: event.source_comment_id,
    source_body_sha256: event.source_body_sha256,
    semantic_adjudication: "ACCEPTED",
    current_authority_reread: "MATCHED",
    current_switch_comment_id: "1001",
    current_start_index_comment_id: "1002",
    current_registry_index_comment_id: "1003",
    current_rehydration_ack_comment_id: "1004",
    review_requirement: "REQUIRED",
    review_decision: "PASS",
    review_comment_id: "7010",
    successor_count: "1",
    successor_comment_id: "7002",
    successor_issue_number: "7002",
    successor_agent_session: "session-next",
    successor_pane: "w3:p11",
    successor_terminal: "term-next",
    ...overrides,
  };
  return {
    id: "7001",
    url: "https://github.com/D22977/gpt-browser-bridge/issues/88#issuecomment-7001",
    issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/88",
    user: { login: "D22977" },
    body: [fields.marker, ...Object.entries(fields).filter(([key]) => key !== "marker").map(([key, value]) => `${key}: ${value}`)].join("\n"),
  };
}

function assertImplemented() {
  assert.equal(typeof authorizeControlSuccessor, "function", "Control successor gate is not implemented");
  assert.equal(typeof consumeDeliveredControlSuccessor, "function", "durable successor consumption is not implemented");
  assert.equal(typeof runG34ResidentCycle, "function", "resident source-event cycle is not implemented");
}

function exactRecord(id, issue_number, body) {
  return {
    id: String(id),
    url: `https://github.com/D22977/gpt-browser-bridge/issues/${issue_number}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/D22977/gpt-browser-bridge/issues/${issue_number}`,
    user: { login: "D22977" }, body,
  };
}

function currentAuthority() {
  return {
    switchReceipt: exactRecord(10, 88, ["CONTROL_GENERATION_ATOMIC_SWITCH_V1", "state: ACTIVE_SWITCH_COMMITTED_READBACK_REQUIRED", "OLD_CONTROL", "generation: 033", "status_after: RETIRED", "conversation_id: 6abd98f5-5808-83e8-852c-f01a16cebf24", "NEW_CONTROL", "generation: 034", "status_after: ACTIVE", `conversation_id: ${activeId}`, "single_active_control: true"].join("\n")),
    index43: exactRecord(11, 43, [`CURRENT_REHYDRATION_INDEX_V246`, `control_generation: 034 ACTIVE`, `active_control_id: ${activeId}`, "single_active_control: true", "repository: D22977/gpt-browser-bridge"].join("\n")),
    index81: exactRecord(12, 81, [`CURRENT_REGISTRY_INDEX_V142`, `control_generation: 034 ACTIVE`, `active_control_id: ${activeId}`, "single_active_control: true", "repository: D22977/gpt-browser-bridge"].join("\n")),
    rehydrationAck: exactRecord(13, 88, ["ACTIVE_CONTROL_REHYDRATION_ACK_V1", "state: ACTIVE_REHYDRATED_ACKNOWLEDGED", "generation: 034", `conversation_id: ${activeId}`, "ACTIVE_STATE", "sole_active_control_generation: 034", "sole_active_control_identity_match: true", "old033_status: RETIRED", "generation032_status: EXHAUSTED_NEVER_ACTIVE", "single_active_control: true", "state_pointer_consistency: matched"].join("\n")),
  };
}

test("resident successor gate export exists", () => {
  assert.equal(typeof authorizeControlSuccessor, "function");
});

test("only an accepted current Control decision can return one explicit successor", () => {
  assertImplemented();
  assert.deepEqual(authorizeControlSuccessor({ event, authority, controlReceipt: decision() }), {
    comment_id: "7002", issue_number: 7002, agent_session: "session-next", pane: "w3:p11", terminal: "term-next",
  });
});

test("resident publishes only recognized executor receipts under exact current authority", async () => {
  assertImplemented();
  const workerBinding = {
    repository: "D22977/gpt-browser-bridge", card_comment_id: "5777732770", binding_comment_id: "6083287293",
    dispatch_comment_id: "6083292578", start_comment_id: "6083328488", worker_author: "D22977",
    control_conversation_id: activeId, agent_name: "gbb_g34_source_1009a", agent_session: "01a12121-7e02-7d30-90f3-1484c9a105fa",
    pane: "w3:p11", terminal: "term_65d6966ba1cedb", cwd: "D:\\AIWORK_WT\\GBB-G34-SOURCE-EVENT-20261009-01",
    model: "gpt-6-luna", reasoning_effort: "low", branch: "work/gbb-g34-source-event-20261009-01",
    base_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55", head_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
  };
  const sourceFields = { ...workerBinding, control_generation: "034", state: "CONSUMED_STARTED", user_relay_count: "0" };
  const sourceComment = {
    id: "6083328488", url: "https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-6083328488",
    issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/202", user: { login: "D22977" },
    body: ["GBB_G34_EXECUTOR_CONSUMED_STARTED_V1", ...Object.entries(sourceFields).map(([k,v]) => `${k}: ${v}`)].join("\n"),
  };
  let postedBody;
  const github = {
    async findEventComments() { return []; },
    async createIssueComment(issueNumber, body) { assert.equal(issueNumber, 202); postedBody = body; return { id: "9001" }; },
    async getIssueComment(id) {
      if (id === sourceComment.id) return sourceComment;
      return { id, url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${id}`, issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/202", user: { login: "D22977" }, body: postedBody };
    },
  };
  const results = await runG34ResidentCycle({
    sourceComments: [sourceComment], currentAuthority: currentAuthority(), issueNumber: 202,
    runtimeRoot: await mkdtemp(path.join(tmpdir(), "g34-cycle-")), github, repositoryFullName: "D22977/gpt-browser-bridge",
    binding: workerBinding,
    branch: "work/gbb-g34-source-event-20261009-01", baseSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55", headSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55", publisherAuthor: "D22977",
  });
  assert.equal(results[0].event.source_comment_id, sourceComment.id);
  assert.equal(results[0].publication.state, "DELIVERED");
});

test("resident never infers a successor from a stale, duplicate, rejected, or G14 decision", () => {
  assertImplemented();
  for (const bad of [
    decision({ successor_count: 2 }),
    decision({ control_generation: "014" }),
    decision({ active_control_id: "null" }),
    decision({ source_event_id: "another-event" }),
  ]) {
    assert.throws(() => authorizeControlSuccessor({ event, authority, controlReceipt: bad }));
  }
});

test("successor gate rejects markerless matching fields, a non-Control author, stale reread, and incomplete review", () => {
  assertImplemented();
  const markerless = decision();
  markerless.body = markerless.body.split("\n").slice(1).join("\n");
  assert.throws(() => authorizeControlSuccessor({ event, authority, controlReceipt: markerless }));

  const wrongAuthor = decision();
  wrongAuthor.user.login = "unrelated-user";
  assert.throws(() => authorizeControlSuccessor({ event, authority, controlReceipt: wrongAuthor }));

  assert.throws(() => authorizeControlSuccessor({
    event, authority, controlReceipt: decision({ current_start_index_comment_id: "9999" }),
  }));
  assert.throws(() => authorizeControlSuccessor({
    event, authority, controlReceipt: decision({ review_decision: "PENDING" }),
  }));
});

test("resident records delivery separately and only a verified Worker receipt marks consumption", async () => {
  assertImplemented();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-resident-"));
  const eventDir = path.join(runtimeRoot, "events");
  await mkdir(eventDir);
  await writeFile(path.join(eventDir, "g34-source-events.json"), JSON.stringify({
    [event.event_id]: { state: "DELIVERED", source_comment_id: event.source_comment_id, comment_id: "9001" },
  }));
  const delivered = [];
  const args = { event, authority, controlReceipt: decision(), runtimeRoot, deliver: async (next) => { delivered.push(next); return { state: "DELIVERED", receipt_id: "delivery-1" }; } };
  assert.equal((await consumeDeliveredControlSuccessor(args)).state, "SUCCESSOR_DELIVERED_AWAITING_RECEIPT");
  assert.equal((await consumeDeliveredControlSuccessor(args)).state, "NO_OP");
  assert.deepEqual(delivered, [{ comment_id: "7002", issue_number: 7002, agent_session: "session-next", pane: "w3:p11", terminal: "term-next" }]);
  const ledger = JSON.parse(await readFile(path.join(eventDir, "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "SUCCESSOR_DELIVERED");
  assert.equal((await markSourceEventConsumed({
    eventId: event.event_id,
    sourceCommentId: event.source_comment_id,
    controlCommentId: "7001",
    runtimeRoot,
    expectedWorkerAuthor: "worker-login",
    workerReceipt: {
      id: "7011",
      url: "https://github.com/D22977/gpt-browser-bridge/issues/7002#issuecomment-7011",
      issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/7002",
      user: { login: "worker-login" },
      body: "GBB_G34_SUCCESSOR_CONSUMED_V1\nstate: CONSUMED\nsource_event_id: " + event.event_id + "\ncontrol_acceptance_comment_id: 7001\nsuccessor_comment_id: 7002",
    },
  })).state, "CONSUMED");
  assert.throws(() => authorizeControlSuccessor({ event: { ...event, state: "CONSUMED" }, authority, controlReceipt: decision() }));
});

test("failed or ambiguous successor delivery is typed uncertain and never blindly sent twice", async () => {
  assertImplemented();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-uncertain-delivery-"));
  const eventDir = path.join(runtimeRoot, "events");
  await mkdir(eventDir);
  await writeFile(path.join(eventDir, "g34-source-events.json"), JSON.stringify({
    [event.event_id]: { state: "DELIVERED", source_comment_id: event.source_comment_id, comment_id: "9001" },
  }));
  let sends = 0;
  const args = { event, authority, controlReceipt: decision(), runtimeRoot, deliver: async () => { sends++; throw new Error("transport outcome unknown"); } };
  assert.equal((await consumeDeliveredControlSuccessor(args)).state, "UNCERTAIN_DELIVERY");
  assert.equal((await consumeDeliveredControlSuccessor(args)).state, "UNCERTAIN_DELIVERY");
  assert.equal(sends, 1);
  const ledger = JSON.parse(await readFile(path.join(eventDir, "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "SUCCESSOR_UNCERTAIN");
});
