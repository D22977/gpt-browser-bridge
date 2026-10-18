import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { beginSuccessorDelivery, createSourceEvent, publishSourceEvent, recordSuccessorDelivery, markSourceEventConsumed } = await import("../src/g34_source_event_publisher.mjs").catch(() => ({}));

const binding = {
  repository: "D22977/gpt-browser-bridge",
  card_comment_id: "5777732770",
  binding_comment_id: "6083287293",
  dispatch_comment_id: "6083292578",
  start_comment_id: "6083328488",
  claim_comment_id: "6083307695",
  claim_acceptance_comment_id: "6083317057",
  attempt_id: "attempt-20261009-01",
  lease_id: "lease-20261009-01",
  lease_generation: "1",
  worker_author: "worker-login",
  control_conversation_id: "6ac3b22a-a830-83e8-852c-f01a16cebf24",
  agent_name: "gbb_g34_source_1009a",
  agent_session: "01a12121-7e02-7d30-90f3-1484c9a105fa",
  pane: "w3:p11",
  terminal: "term_65d6966ba1cedb",
  cwd: "D:\\AIWORK_WT\\GBB-G34-SOURCE-EVENT-20261009-01",
  model: "gpt-6-luna",
  reasoning_effort: "low",
  branch: "work/gbb-g34-source-event-20261009-01",
  base_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
  head_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
};
const authority = {
  control_generation: "034",
  active_control_id: "6ac3b22a-a830-83e8-852c-f01a16cebf24",
  control_conversation_id: "6ac3b22a-a830-83e8-852c-f01a16cebf24",
};

function assertImplemented() {
  assert.equal(typeof createSourceEvent, "function", "source event builder is not implemented");
  assert.equal(typeof publishSourceEvent, "function", "source event publisher is not implemented");
  assert.equal(typeof markSourceEventConsumed, "function", "durable event consumption is not implemented");
}

function workerStartReceipt(overrides = {}) {
  const fields = {
    state: "CONSUMED_STARTED",
    control_generation: "034",
    control_conversation_id: authority.active_control_id,
    repository: binding.repository,
    card_comment_id: binding.card_comment_id,
    binding_comment_id: binding.binding_comment_id,
    dispatch_comment_id: binding.dispatch_comment_id,
    claim_comment_id: binding.claim_comment_id,
    claim_acceptance_comment_id: binding.claim_acceptance_comment_id,
    attempt_id: binding.attempt_id,
    lease_id: binding.lease_id,
    lease_generation: binding.lease_generation,
    agent_name: binding.agent_name,
    agent_session: binding.agent_session,
    pane: binding.pane,
    terminal: binding.terminal,
    cwd: binding.cwd,
    model: binding.model,
    reasoning_effort: binding.reasoning_effort,
    branch: binding.branch,
    base_sha: binding.base_sha,
    head_sha: binding.head_sha,
    user_relay_count: "0",
    ...overrides,
  };
  return {
    id: binding.start_comment_id,
    url: "https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-" + binding.start_comment_id,
    issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/202",
    user: { login: binding.worker_author },
    body: ["GBB_G34_EXECUTOR_CONSUMED_STARTED_V1", "EXECUTOR", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`)].join("\n"),
  };
}

function eventArgs(overrides = {}) {
  return {
    sourceComment: workerStartReceipt(),
    sourceIssueNumber: 202,
    sourceRepositoryFullName: "D22977/gpt-browser-bridge",
    eventKind: "WORKER_STARTED",
    authority,
    binding,
    branch: binding.branch,
    baseSha: binding.base_sha,
    headSha: binding.head_sha,
    state: "CONSUMED_STARTED",
    expectedAuthor: "D22977",
    ...overrides,
  };
}

function sampleEvent() {
  return createSourceEvent(eventArgs());
}

function clientFor(body, options = {}) {
  const calls = { create: 0, exactGet: 0, find: 0 };
  return {
    calls,
    async findEventComments() { calls.find++; return options.matches || []; },
    async createIssueComment(issueNumber, postedBody) {
      calls.create++;
      assert.equal(issueNumber, 202);
      assert.equal(postedBody, body);
      if (options.createError) throw options.createError;
      return { id: "9001", url: "https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-9001", issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/202" };
    },
    async getIssueComment(id) {
      calls.exactGet++;
      assert.equal(id, "9001");
      if (options.getError) throw options.getError;
      return { id, url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${id}`, issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/202", user: { login: "D22977" }, body };
    },
  };
}

test("source-event exports exist", () => {
  assert.equal(typeof createSourceEvent, "function");
  assert.equal(typeof publishSourceEvent, "function");
});

test("source event id is deterministic and body binds the upstream receipt identity", () => {
  assertImplemented();
  const first = sampleEvent();
  const second = sampleEvent();
  const expectedId = createHash("sha256")
    .update(JSON.stringify([first.control_generation, first.event_kind, first.source_comment_id]), "utf8")
    .digest("hex");
  assert.equal(first.event_id, expectedId);
  assert.equal(second.body, first.body);
  assert.equal(first.source_comment_id, "6083328488");
  assert.equal(first.claim_comment_id, binding.claim_comment_id);
  assert.equal(first.claim_acceptance_comment_id, binding.claim_acceptance_comment_id);
  assert.equal("event_comment_id" in first, false);
  assert.doesNotMatch(first.body, /event_comment_id/);
  assert.equal(first.source_body_sha256, createHash("sha256").update(workerStartReceipt().body, "utf8").digest("hex"));
  assert.match(first.body, /marker=GITHUB_SOURCE_EVENT_V1/);
  assert.match(first.body, /source_comment_id=6083328488/);
});

test("source event rejects unrelated authors and receipt fields that differ from the bound Worker chain", () => {
  assertImplemented();
  const unrelated = workerStartReceipt();
  unrelated.user.login = "unrelated-user";
  assert.throws(() => createSourceEvent(eventArgs({ sourceComment: unrelated })), /author|Worker/i);

  assert.throws(() => createSourceEvent(eventArgs({
    sourceComment: workerStartReceipt({ branch: "work/unbound-branch" }),
  })), /branch|binding|receipt/i);
  assert.throws(() => createSourceEvent(eventArgs({
    sourceComment: { ...workerStartReceipt(), id: "6083328499", url: "https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-6083328499" },
  })), /start|binding|receipt/i);
});

test("publisher persists before sending and exact-reads the created GitHub comment", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  const github = clientFor(event.body);
  const result = await publishSourceEvent({ event, issueNumber: 202, runtimeRoot, github });
  assert.equal(result.state, "DELIVERED");
  assert.deepEqual(github.calls, { create: 1, exactGet: 1, find: 1 });
  const ledger = JSON.parse(await readFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "DELIVERED");
  assert.equal(ledger[event.event_id].comment_id, "9001");
});

test("uncertain send is reconciled without blindly reposting", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  const github = clientFor(event.body, { createError: new Error("response lost") });
  await assert.rejects(() => publishSourceEvent({ event, issueNumber: 202, runtimeRoot, github }), /UNCERTAIN_SEND/);
  const retry = await publishSourceEvent({ event, issueNumber: 202, runtimeRoot, github });
  assert.equal(retry.state, "UNCERTAIN_SEND");
  assert.equal(github.calls.create, 1);
});

test("duplicate source-event matches fail closed", async () => {
  assertImplemented();
  const event = sampleEvent();
  const github = clientFor(event.body, { matches: [{ id: "1" }, { id: "2" }] });
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  await assert.rejects(() => publishSourceEvent({ event, issueNumber: 202, runtimeRoot, github }), /DUPLICATE_EVENT/);
  assert.equal(github.calls.create, 0);
});

test("delivered event is consumed only after a verified Control-authorized Worker receipt", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  await publishSourceEvent({ event, issueNumber: 202, runtimeRoot, github: clientFor(event.body) });
  const args = { eventId: event.event_id, sourceCommentId: event.source_comment_id, controlCommentId: "8001", runtimeRoot };
  await beginSuccessorDelivery({
    ...args,
    successor: { comment_id: "7002", issue_number: 7002, agent_session: "session-2", pane: "w3:p11", terminal: "term-2", worker_author: "worker-login" },
  });
  await recordSuccessorDelivery({ ...args, delivery: { state: "DELIVERED", receipt_id: "transport-1", comment_id: "7002", issue_number: 7002, agent_session: "session-2", pane: "w3:p11", terminal: "term-2", worker_author: "worker-login" } });
  const consumedArgs = {
    ...args,
    expectedWorkerAuthor: "worker-login",
    successor: { comment_id: "7002", issue_number: 7002, agent_session: "session-2", pane: "w3:p11", terminal: "term-2", worker_author: "worker-login" },
    workerReceipt: {
      id: "9002",
      url: "https://github.com/D22977/gpt-browser-bridge/issues/7002#issuecomment-9002",
      issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/7002",
      user: { login: "worker-login" },
      body: ["GBB_G34_SUCCESSOR_CONSUMED_V1", "state: CONSUMED", `source_event_id: ${event.event_id}`, `source_comment_id: ${event.source_comment_id}`, "control_acceptance_comment_id: 8001", "successor_comment_id: 7002", "agent_session: session-2", "pane: w3:p11", "terminal: term-2"].join("\n"),
    },
    github: { async getIssueComment(id) { assert.equal(id, "9002"); return consumedArgs.workerReceipt; } },
  };
  assert.equal((await markSourceEventConsumed(consumedArgs)).state, "CONSUMED");
  assert.equal((await markSourceEventConsumed(consumedArgs)).state, "NO_OP");
  const ledger = JSON.parse(await readFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "CONSUMED");
  assert.equal(ledger[event.event_id].control_comment_id, "8001");
});

test("corrupt ledger fails closed before a GitHub create call", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  await mkdir(path.join(runtimeRoot, "events"));
  await writeFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "not-json");
  const github = clientFor(event.body);
  await assert.rejects(() => publishSourceEvent({ event, issueNumber: 202, runtimeRoot, github }), /cannot read G34 event ledger/);
  assert.equal(github.calls.create, 0);
});
