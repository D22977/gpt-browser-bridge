import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { authorizeControlSuccessor, consumeDeliveredControlSuccessor, runG34ResidentCycle } = await import("../src/g34_resident.mjs").catch(() => ({}));

const activeId = "6ac3b22a-a830-83ee-bd71-85838e5f1392";
const authority = { control_generation: "034", active_control_id: activeId, control_conversation_id: activeId };
const event = { event_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", state: "DELIVERED", source_comment_id: "6083328488" };

function decision(overrides = {}) {
  const fields = {
    control_generation: "034",
    active_control_id: activeId,
    source_event_id: event.event_id,
    successor_count: "1",
    successor_comment_id: "7002",
    successor_agent_session: "session-next",
    successor_pane: "w3:p11",
    successor_terminal: "term-next",
    ...overrides,
  };
  return {
    id: "7001",
    issue_number: 88,
    issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/88",
    body: Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n"),
  };
}

function assertImplemented() {
  assert.equal(typeof authorizeControlSuccessor, "function", "Control successor gate is not implemented");
  assert.equal(typeof consumeDeliveredControlSuccessor, "function", "durable successor consumption is not implemented");
  assert.equal(typeof runG34ResidentCycle, "function", "resident source-event cycle is not implemented");
}

function exactRecord(id, issue_number, body) {
  return { id: String(id), pointer_id: String(id), issue_number, body };
}

function currentAuthority() {
  return {
    switchReceipt: exactRecord(10, 88, "CONTROL_GENERATION_ATOMIC_SWITCH_V1\ntransition: NEW_CONTROL\ngeneration: 034\nconversation_id: 6ac3b22a-a830-83ee-bd71-85838e5f1392\nstatus_after: ACTIVE"),
    index43: exactRecord(11, 43, "generation: 034\nstatus: ACTIVE\nactive_control_id: 6ac3b22a-a830-83ee-bd71-85838e5f1392\nsingle_active_control: true"),
    index81: exactRecord(12, 81, "generation: 034\nstatus: ACTIVE\nactive_control_id: 6ac3b22a-a830-83ee-bd71-85838e5f1392\nsingle_active_control: true"),
    rehydrationAck: exactRecord(13, 88, "ACTIVE_CONTROL_REHYDRATION_ACK_V1\ngeneration: 034\nactive_control_id: 6ac3b22a-a830-83ee-bd71-85838e5f1392\nconversation_id: 6ac3b22a-a830-83ee-bd71-85838e5f1392\nstatus: ACTIVE"),
  };
}

test("resident successor gate export exists", () => {
  assert.equal(typeof authorizeControlSuccessor, "function");
});

test("only an accepted current Control decision can return one explicit successor", () => {
  assertImplemented();
  assert.deepEqual(authorizeControlSuccessor({ event, authority, controlReceipt: decision() }), {
    comment_id: "7002", agent_session: "session-next", pane: "w3:p11", terminal: "term-next",
  });
});

test("resident publishes only recognized executor receipts under exact current authority", async () => {
  assertImplemented();
  const sourceComment = {
    id: "6083328488",
    issue_number: 202,
    issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/202",
    user: { login: "D22977" },
    body: "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1\nstate: CONSUMED_STARTED",
  };
  let postedBody;
  const github = {
    async findEventComments() { return []; },
    async createIssueComment(issueNumber, body) { assert.equal(issueNumber, 202); postedBody = body; return { id: "9001" }; },
    async getIssueComment(id) {
      if (id === sourceComment.id) return sourceComment;
      return { id, issue_number: 202, issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/202", user: { login: "D22977" }, body: postedBody };
    },
  };
  const results = await runG34ResidentCycle({
    sourceComments: [sourceComment], currentAuthority: currentAuthority(), issueNumber: 202,
    runtimeRoot: await mkdtemp(path.join(tmpdir(), "g34-cycle-")), github, repositoryFullName: "D22977/gpt-browser-bridge",
    binding: { card_comment_id: "5777732770", binding_comment_id: "6083287293", dispatch_comment_id: "6083292578", agent_name: "gbb_g34_source_1009a", agent_session: "01a12121-7e02-7d30-90f3-1484c9a105fa", pane: "w3:p11", terminal: "term_65d6966ba1cedb", cwd: "D:\\AIWORK_WT\\GBB-G34-SOURCE-EVENT-20261009-01", model: "gpt-6-luna", reasoning_effort: "low" },
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

test("resident durably consumes and delivers only one accepted successor", async () => {
  assertImplemented();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-resident-"));
  const eventDir = path.join(runtimeRoot, "events");
  await mkdir(eventDir);
  await writeFile(path.join(eventDir, "g34-source-events.json"), JSON.stringify({
    [event.event_id]: { state: "DELIVERED", source_comment_id: event.source_comment_id, comment_id: "9001" },
  }));
  const delivered = [];
  const args = { event, authority, controlReceipt: decision(), runtimeRoot, deliver: async (next) => delivered.push(next) };
  assert.equal((await consumeDeliveredControlSuccessor(args)).state, "CONSUMED");
  assert.equal((await consumeDeliveredControlSuccessor(args)).state, "NO_OP");
  assert.deepEqual(delivered, [{ comment_id: "7002", agent_session: "session-next", pane: "w3:p11", terminal: "term-next" }]);
  const ledger = JSON.parse(await readFile(path.join(eventDir, "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "CONSUMED");
  assert.throws(() => authorizeControlSuccessor({ event: { ...event, state: "CONSUMED" }, authority, controlReceipt: decision() }));
});
