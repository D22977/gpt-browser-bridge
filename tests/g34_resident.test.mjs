import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { authorizeControlSuccessor, consumeDeliveredControlSuccessor, readCurrentControlAuthority, runG34ResidentCycle } = await import("../src/g34_resident.mjs").catch(() => ({}));
const { markSourceEventConsumed } = await import("../src/g34_source_event_publisher.mjs").catch(() => ({}));

const activeId = "6ac3b22a-a830-83e8-852c-f01a16cebf24";
const authority = {
  control_generation: "034", active_control_id: activeId, control_conversation_id: activeId,
  active_control_github_login: "D22977",
  source_comment_ids: { switch: "1001", index43: "1002", index81: "1003", rehydration_ack: "1004" },
};
const event = {
  event_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  state: "DELIVERED", source_comment_id: "6083328488", source_body_sha256: createHash("sha256").update("source body", "utf8").digest("hex"),
  source_issue_number: 202, expected_source_author: "D22977",
  head_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55", review_card_id: "#214",
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
    current_switch_comment_id: "10",
    current_start_index_comment_id: "11",
    current_registry_index_comment_id: "12",
    current_rehydration_ack_comment_id: "13",
    review_requirement: "REQUIRED",
    review_decision: "PASS",
    review_comment_id: "7010",
    review_issue_number: "209",
    review_card_id: "#214",
    review_author: "ReviewerBot",
    independent_review_exact_read: "MATCHED",
    review_binding_id: "7110",
    review_start_id: "7111",
    review_head_sha: event.head_sha,
    successor_count: "1",
    successor_comment_id: "7002",
    successor_issue_number: "7002",
    successor_agent_session: "session-next",
    successor_pane: "w3:p11",
    successor_terminal: "term-next",
    successor_worker_author: "worker-login",
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
    switchReceipt: exactRecord(10, 88, ["CONTROL_GENERATION_ATOMIC_SWITCH_V1", "state: ACTIVE_SWITCH_COMMITTED_READBACK_REQUIRED", "repository: D22977/gpt-browser-bridge", "OLD_CONTROL", "generation: 033", "status_after: RETIRED", "conversation_id: 6abd98f5-5808-83e8-852c-f01a16cebf24", "NEW_CONTROL", "generation: 034", "status_after: ACTIVE", `conversation_id: ${activeId}`, "single_active_control: true"].join("\n")),
    index43: exactRecord(11, 43, [`CURRENT_REHYDRATION_INDEX_V246`, `control_generation: 034 ACTIVE`, `active_control_id: ${activeId}`, "single_active_control: true", "repository: D22977/gpt-browser-bridge", "atomic_switch: #88/10 exact GET matched"].join("\n")),
    index81: exactRecord(12, 81, [`CURRENT_REGISTRY_INDEX_V142`, `control_generation: 034 ACTIVE`, `active_control_id: ${activeId}`, "single_active_control: true", "repository: D22977/gpt-browser-bridge", "current_start: #43/11 V246 exact GET matched", "atomic_switch: #88/10 exact GET matched"].join("\n")),
    rehydrationAck: exactRecord(13, 88, ["ACTIVE_CONTROL_REHYDRATION_ACK_V1", "state: ACTIVE_REHYDRATED_ACKNOWLEDGED", "repository: D22977/gpt-browser-bridge", "generation: 034", `conversation_id: ${activeId}`, "atomic_switch: #88/10", "current_start: #43/11", "current_registry: #81/12", "ACTIVE_STATE", "sole_active_control_generation: 034", "sole_active_control_identity_match: true", "old033_status: RETIRED", "generation032_status: EXHAUSTED_NEVER_ACTIVE", "single_active_control: true", "state_pointer_consistency: matched"].join("\n")),
  };
}

function fakeDecisionGithub() {
  const review = exactRecord(7010, 209, "GBB_G34_INDEPENDENT_REVIEW_RESULT_V1\ndecision: PASS\nreviewer_binding: 7110\nreviewer_consumed_started: 7111\nhead_sha: " + event.head_sha);
  review.user.login = "ReviewerBot";
  const comments = new Map([
    ["10", currentAuthority().switchReceipt], ["11", currentAuthority().index43],
    ["12", currentAuthority().index81], ["13", currentAuthority().rehydrationAck],
    ["7001", decision()],
    ["7010", review],
    ["6083328488", { ...exactRecord(6083328488, 202, "source body"), user: { login: "D22977" } }],
  ]);
  return {
    async getIssueComment(id) { return comments.get(String(id)); },
    async listIssueComments(issueNumber) { return [...comments.values()].filter((comment) => comment.issue_url.endsWith(`/${issueNumber}`)); },
  };
}

test("resident successor gate export exists", () => {
  assert.equal(typeof authorizeControlSuccessor, "function");
});

test("only an accepted current Control decision can return one explicit successor", () => {
  assertImplemented();
  assert.throws(() => authorizeControlSuccessor({ event, authority, controlReceipt: decision() }), /exact|verified|Control/i);
});

function actualComment(id, issue, body) {
  return {
    id: String(id),
    url: `https://github.com/D22977/gpt-browser-bridge/issues/${issue}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/D22977/gpt-browser-bridge/issues/${issue}`,
    user: { login: "D22977" },
    body,
  };
}

function current035Records() {
  const currentId = "6ad34c37-975c-83e8-9fb7-6881e04d0c84";
  return [
    actualComment(6233155285, 43, [
      "CURRENT_REHYDRATION_INDEX_V287", "state: CONTROL_REQUIRED_ACTIVE_REHYDRATION_ACK_GITHUB_WRITE_BLOCKED",
      "atomic_switch: #88/6233003577 exact GET matched", "active_control_generation: 035",
      `active_control_conversation_id: ${currentId}`,
    ].join("\n")),
    actualComment(6233157935, 81, [
      "CURRENT_REGISTRY_INDEX_V163", "state: G34_CONTROL_035_ACTIVE_REHYDRATION_ACK_GITHUB_WRITE_BLOCKED",
      "current_control_index: #43/6233155285 V287", "switch: #88/6233003577 exact GET matched",
      "ACTIVE_CONTROL", "generation: 035 ACTIVE", `conversation_id: ${currentId}`,
    ].join("\n")),
    actualComment(6233003577, 88, [
      "CONTROL_GENERATION_SWITCH_034_TO_035_V1", "state: ATOMIC_SWITCHED", "GENERATION_STATE",
      "old_generation: 034", "old_generation_status: RETIRED", "new_generation: 035",
      "new_generation_status: ACTIVE", `new_conversation_id: ${currentId}`,
    ].join("\n")),
    actualComment(6243902173, 88, [
      "ACTIVE_CONTROL_REHYDRATION_ACK_V1", "state: ACTIVE_REHYDRATED_ACKNOWLEDGED", "generation: 035",
      `conversation_id: ${currentId}`, "active_switch: #88/6233003577", "current_control_index: #43/6233155285 V287",
      "current_registry_index: #81/6233157935 V163",
    ].join("\n")),
  ];
}

test("current authority reread rejects caller-supplied stale 034 pointers when fresh GitHub tips are 035", async () => {
  const records = current035Records();
  const stale = currentAuthority();
  const byId = new Map([
    ...records.map((record) => [record.id, record]),
    ["5997153160", { ...stale.switchReceipt, id: "5997153160", url: "https://github.com/D22977/gpt-browser-bridge/issues/88#issuecomment-5997153160" }],
    ["5997180468", { ...stale.index43, id: "5997180468", url: "https://github.com/D22977/gpt-browser-bridge/issues/43#issuecomment-5997180468" }],
    ["5997189759", { ...stale.index81, id: "5997189759", url: "https://github.com/D22977/gpt-browser-bridge/issues/81#issuecomment-5997189759" }],
    ["5997220300", { ...stale.rehydrationAck, id: "5997220300", url: "https://github.com/D22977/gpt-browser-bridge/issues/88#issuecomment-5997220300" }],
  ]);
  const github = {
    async listIssueComments(issueNumber) { return records.filter((record) => record.issue_url.endsWith(`/${issueNumber}`)); },
    async getIssueComment(id) { return byId.get(String(id)); },
  };
  await assert.rejects(() => readCurrentControlAuthority({
    github,
    pointers: { index43: "5997180468", index81: "5997189759", switch: "5997153160", rehydrationAck: "5997220300" },
  }), /current|035|G34|034/i);
});

test("resident rejects caller-supplied matching Worker fields without exact accepted claim-chain records", async () => {
  assertImplemented();
  const workerBinding = {
    repository: "D22977/gpt-browser-bridge", card_comment_id: "5777732770", binding_comment_id: "6083287293",
    dispatch_comment_id: "6083292578", start_comment_id: "5108", worker_author: "D22977",
    attempt_id: "attempt-source-01", lease_id: "lease-source-01", lease_generation: "1",
    control_conversation_id: activeId, agent_name: "gbb_g34_source_1009a", agent_session: "01a12121-7e02-7d30-90f3-1484c9a105fa",
    pane: "w3:p11", terminal: "term_65d6966ba1cedb", cwd: "D:\\AIWORK_WT\\GBB-G34-SOURCE-EVENT-20261009-01",
    model: "gpt-6-luna", reasoning_effort: "low", branch: "work/gbb-g34-source-event-20261009-01",
    base_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55", head_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
  };
  const sourceComment = actualComment(5108, 202, [
    "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1", "state: CONSUMED_STARTED", "control_generation: 034",
    `control_conversation_id: ${activeId}`, "repository: D22977/gpt-browser-bridge",
    "card_comment_id: 5777732770", "binding_comment_id: 6083287293", "dispatch_comment_id: 6083292578",
    "attempt_id: attempt-source-01", "lease_id: lease-source-01", "lease_generation: 1",
    "agent_name: gbb_g34_source_1009a", "agent_session: 01a12121-7e02-7d30-90f3-1484c9a105fa",
    "pane: w3:p11", "terminal: term_65d6966ba1cedb", "cwd: D:\\AIWORK_WT\\GBB-G34-SOURCE-EVENT-20261009-01",
    "model: gpt-6-luna", "reasoning_effort: low", "branch: work/gbb-g34-source-event-20261009-01",
    "base_sha: c7d17550fdfe3ae3e06ecec352004ca3b7284c55", "head_sha: c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
    "user_relay_count: 0",
  ].join("\n"));
  const authorityRecords = currentAuthority();
  const gitHubMap = new Map([
    ["10", authorityRecords.switchReceipt], ["11", authorityRecords.index43], ["12", authorityRecords.index81],
    ["13", authorityRecords.rehydrationAck], [sourceComment.id, sourceComment],
  ]);
  let postedBody;
  const github = {
    async listIssueComments(issueNumber) { return [...gitHubMap.values()].filter((record) => record.issue_url.endsWith(`/${issueNumber}`)); },
    async getIssueComment(id) {
      if (String(id) === "9001") return actualComment("9001", 202, postedBody);
      return gitHubMap.get(String(id));
    },
    async findEventComments() { return []; },
    async createIssueComment(_issueNumber, body) { postedBody = body; return { id: "9001" }; },
  };
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-unbound-chain-"));
  await assert.rejects(() => runG34ResidentCycle({
    sourceComments: [sourceComment], currentAuthorityPointers: { index43: "11", index81: "12", switch: "10", rehydrationAck: "13" },
    binding: workerBinding, issueNumber: 202, runtimeRoot, github,
    branch: workerBinding.branch, baseSha: workerBinding.base_sha, headSha: workerBinding.head_sha, publisherAuthor: "D22977",
  }), /claim|accepted|binding|current/i);
});

test("resident publishes only recognized executor receipts under exact current authority", async () => {
  assertImplemented();
  const workerBinding = {
    repository: "D22977/gpt-browser-bridge", card_comment_id: "7001", binding_comment_id: "7002",
    dispatch_comment_id: "7003", claim_comment_id: "7004", claim_acceptance_comment_id: "7005",
    start_comment_id: "7006", worker_author: "D22977",
    attempt_id: "attempt-source-01", lease_id: "lease-source-01", lease_generation: "1",
    control_conversation_id: activeId, agent_name: "gbb_g34_source_1009a", agent_session: "01a12121-7e02-7d30-90f3-1484c9a105fa",
    pane: "w3:p11", terminal: "term_65d6966ba1cedb", cwd: "D:\\AIWORK_WT\\GBB-G34-SOURCE-EVENT-20261009-01",
    model: "gpt-6-luna", reasoning_effort: "low", branch: "work/gbb-g34-source-event-20261009-01",
    base_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55", head_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
  };
  const exactRecord = (id, marker, fields = {}) => actualComment(id, 202, [marker, ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`)].join("\n"));
  const card = exactRecord("7001", "GBB_G34_SOURCE_EVENT_REISSUE_CARD_V1", { repository: workerBinding.repository, issue: 202 });
  const bindingRecord = exactRecord("7002", "GBB_G34_WORKER_IDENTITY_BINDING_V1", {
    card_comment_id: "7001", ...workerBinding,
  });
  const dispatch = exactRecord("7003", "GBB_G34_DISPATCH_REQUEST_V1", { binding_comment_id: "7002", attempt_id: workerBinding.attempt_id });
  const claim = exactRecord("7004", "GBB_G34_CLAIM_REQUEST_V1", {
    state: "CLAIM_REQUESTED", card_comment_id: "7001", binding_comment_id: "7002", dispatch_comment_id: "7003",
    ...workerBinding,
  });
  const acceptance = exactRecord("7005", "GBB_G34_CLAIM_ACCEPTED_V1", {
    state: "CLAIM_ACCEPTED", card_comment_id: "7001", claim_comment_id: "7004", binding_comment_id: "7002",
    dispatch_comment_id: "7003", ...workerBinding,
  });
  const sourceComment = exactRecord("7006", "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1", {
    state: "CONSUMED_STARTED", role: "Worker", control_generation: "034", control_conversation_id: activeId,
    card_comment_id: "7001", binding_comment_id: "7002", dispatch_comment_id: "7003",
    claim_comment_id: "7004", claim_acceptance_comment_id: "7005", ...workerBinding, user_relay_count: "0",
  });
  const authorityRecords = currentAuthority();
  const comments = [card, bindingRecord, dispatch, claim, acceptance, sourceComment,
    authorityRecords.switchReceipt, authorityRecords.index43, authorityRecords.index81, authorityRecords.rehydrationAck];
  let postedBody;
  const github = {
    async findEventComments() { return []; },
    async createIssueComment(issueNumber, body) { assert.equal(issueNumber, 202); postedBody = body; return { id: "9001" }; },
    async listIssueComments(issueNumber) { return comments.filter((record) => record.issue_url.endsWith(`/${issueNumber}`)); },
    async getIssueComment(id) {
      if (id === sourceComment.id) return sourceComment;
      if (String(id) === "9001") return actualComment("9001", 202, postedBody);
      return comments.find((record) => record.id === String(id));
    },
  };
  const results = await runG34ResidentCycle({
    sourceComments: [sourceComment], currentAuthorityPointers: { index43: "11", index81: "12", switch: "10", rehydrationAck: "13" }, issueNumber: 202,
    runtimeRoot: await mkdtemp(path.join(tmpdir(), "g34-cycle-")), github, repositoryFullName: "D22977/gpt-browser-bridge",
    binding: workerBinding,
    branch: "work/gbb-g34-source-event-20261009-01", baseSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55", headSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55", publisherAuthor: "D22977",
  });
  assert.equal(results[0].event.source_comment_id, sourceComment.id);
  assert.equal(results[0].event.claim_comment_id, "7004");
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
  const args = { event, authority, controlReceipt: decision(), runtimeRoot, github: fakeDecisionGithub(), currentAuthorityPointers: { index43: "11", index81: "12", switch: "10", rehydrationAck: "13" }, deliver: async (next) => { delivered.push(next); return { ...next, state: "DELIVERED", receipt_id: "delivery-1" }; } };
  assert.equal((await consumeDeliveredControlSuccessor(args)).state, "SUCCESSOR_DELIVERED_AWAITING_RECEIPT");
  assert.equal((await consumeDeliveredControlSuccessor(args)).state, "NO_OP");
  assert.deepEqual(delivered, [{ comment_id: "7002", issue_number: 7002, agent_session: "session-next", pane: "w3:p11", terminal: "term-next", worker_author: "worker-login" }]);
  const ledger = JSON.parse(await readFile(path.join(eventDir, "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "SUCCESSOR_DELIVERED");
  const workerReceipt = {
    id: "7011",
    url: "https://github.com/D22977/gpt-browser-bridge/issues/7002#issuecomment-7011",
    issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/7002",
    user: { login: "worker-login" },
    body: "GBB_G34_SUCCESSOR_CONSUMED_V1\nstate: CONSUMED\nsource_event_id: " + event.event_id + "\nsource_comment_id: " + event.source_comment_id + "\ncontrol_acceptance_comment_id: 7001\nsuccessor_comment_id: 7002\nagent_session: session-next\npane: w3:p11\nterminal: term-next",
  };
  const github = fakeDecisionGithub();
  const getIssueComment = github.getIssueComment.bind(github);
  github.getIssueComment = async (id) => String(id) === "7011" ? workerReceipt : getIssueComment(id);
  assert.equal((await markSourceEventConsumed({
    eventId: event.event_id,
    sourceCommentId: event.source_comment_id,
    controlCommentId: "7001",
    runtimeRoot,
    expectedWorkerAuthor: "worker-login",
    workerReceipt,
    github,
    successor: { comment_id: "7002", issue_number: 7002, agent_session: "session-next", pane: "w3:p11", terminal: "term-next", worker_author: "worker-login" },
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
  const args = { event, authority, controlReceipt: decision(), runtimeRoot, github: fakeDecisionGithub(), currentAuthorityPointers: { index43: "11", index81: "12", switch: "10", rehydrationAck: "13" }, deliver: async () => { sends++; throw new Error("transport outcome unknown"); } };
  assert.equal((await consumeDeliveredControlSuccessor(args)).state, "UNCERTAIN_DELIVERY");
  assert.equal((await consumeDeliveredControlSuccessor(args)).state, "UNCERTAIN_DELIVERY");
  assert.equal(sends, 1);
  const ledger = JSON.parse(await readFile(path.join(eventDir, "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "SUCCESSOR_UNCERTAIN");
});

test("reconciliation cannot overwrite mismatched Control delivery evidence", async () => {
  assertImplemented();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-mismatched-reconcile-"));
  const eventDir = path.join(runtimeRoot, "events");
  await mkdir(eventDir);
  await writeFile(path.join(eventDir, "g34-source-events.json"), JSON.stringify({
    [event.event_id]: {
      state: "SUCCESSOR_UNCERTAIN", source_comment_id: event.source_comment_id, comment_id: "9001",
      control_comment_id: "7001", successor_comment_id: "7002", successor_issue_number: "7002",
      successor_agent_session: "session-next", successor_pane: "w3:p11", successor_terminal: "term-next",
      successor_worker_author: "worker-login",
    },
  }));
  const result = await consumeDeliveredControlSuccessor({
    event, authority, controlReceipt: decision(), runtimeRoot, github: fakeDecisionGithub(),
    currentAuthorityPointers: { index43: "11", index81: "12", switch: "10", rehydrationAck: "13" },
    deliver: async () => { throw new Error("must reconcile the existing uncertain send"); },
    reconcile: async () => ({
      state: "DELIVERED", comment_id: "7002", issue_number: 7002, control_comment_id: "9999",
      agent_session: "session-next", pane: "w3:p11", terminal: "term-next", receipt_id: "reconcile-1",
    }),
  });
  assert.equal(result.state, "UNCERTAIN_DELIVERY");
  const ledger = JSON.parse(await readFile(path.join(eventDir, "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "SUCCESSOR_UNCERTAIN");
});
