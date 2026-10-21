import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { createSourceEvent, publishSourceEvent, markSourceEventConsumed } = await import("../src/g34_source_event_publisher.mjs").catch(() => ({}));

const binding = {
  card_comment_id: "5777732770",
  binding_comment_id: "6083287293",
  dispatch_comment_id: "6083292578",
  agent_name: "gbb_g34_source_1009a",
  agent_session: "01a12121-7e02-7d30-90f3-1484c9a105fa",
  pane: "w3:p11",
  terminal: "term_65d6966ba1cedb",
  cwd: "D:\\AIWORK_WT\\GBB-G34-SOURCE-EVENT-20261009-01",
  model: "gpt-6-luna",
  reasoning_effort: "low",
};
const authority = {
  control_generation: "034",
  active_control_id: "6ac3b22a-a830-83ee-bd71-85838e5f1392",
  control_conversation_id: "6ac3b22a-a830-83ee-bd71-85838e5f1392",
};

const sourceBody = (overrides = {}) => {
  const fields = {
  marker: "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1",
  state: "CONSUMED_STARTED",
  card_comment_id: binding.card_comment_id,
  binding_comment_id: binding.binding_comment_id,
  dispatch_comment_id: binding.dispatch_comment_id,
  control_generation: authority.control_generation,
  control_conversation_id: authority.control_conversation_id,
  repository: "D22977/gpt-browser-bridge",
  branch: "work/gbb-g34-source-event-20261009-01",
  base_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
  head_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
  agent_name: binding.agent_name,
  agent_session: binding.agent_session,
  pane: binding.pane,
  terminal: binding.terminal,
  cwd: binding.cwd,
  model: binding.model,
  reasoning_effort: binding.reasoning_effort,
  user_relay_count: "0",
  ...overrides,
  };
  const marker = fields.marker;
  delete fields.marker;
  return marker + "\n" + Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n");
};

function sourceComment(overrides = {}) {
  return {
    id: "6083328488",
    url: "https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-6083328488",
    user: { login: "D22977" },
    body: sourceBody(overrides),
  };
}

function assertImplemented() {
  assert.equal(typeof createSourceEvent, "function", "source event builder is not implemented");
  assert.equal(typeof publishSourceEvent, "function", "source event publisher is not implemented");
  assert.equal(typeof markSourceEventConsumed, "function", "durable event consumption is not implemented");
}

function sampleEvent() {
  return createSourceEvent({
    sourceComment: sourceComment(),
    sourceIssueNumber: 202,
    sourceRepositoryFullName: "D22977/gpt-browser-bridge",
    eventKind: "WORKER_STARTED",
    authority,
    binding,
    branch: "work/gbb-g34-source-event-20261009-01",
    baseSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
    headSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
    state: "CONSUMED_STARTED",
    expectedAuthor: "D22977",
  });
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
      return { id: "9001" };
    },
    async getIssueComment(id) {
      calls.exactGet++;
      assert.equal(id, "9001");
      if (options.getError) throw options.getError;
      return { id, url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${id}`, user: { login: "D22977" }, body };
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
    .update(JSON.stringify(["034", "WORKER_STARTED", "6083328488"]), "utf8")
    .digest("hex");
  assert.equal(first.event_id, expectedId);
  assert.equal(second.body, first.body);
  assert.equal(first.source_comment_id, "6083328488");
  assert.equal("event_comment_id" in first, false);
  assert.doesNotMatch(first.body, /event_comment_id/);
  assert.equal(first.source_body_sha256, createHash("sha256").update(sourceComment().body, "utf8").digest("hex"));
  assert.match(first.body, /marker=GITHUB_SOURCE_EVENT_V1/);
  assert.match(first.body, /source_comment_id=6083328488/);
});

test("source event rejects unrelated authors and mismatched claim, executor, state, or branch fields", () => {
  assertImplemented();
  const variants = [
    { comment: { ...sourceComment(), user: { login: "unrelated" } } },
    { comment: sourceComment({ card_comment_id: "1" }) },
    { comment: sourceComment({ binding_comment_id: "1" }) },
    { comment: sourceComment({ dispatch_comment_id: "1" }) },
    { comment: sourceComment({ agent_session: "other-session" }) },
    { comment: sourceComment({ state: "READY_FOR_FRESH_REVIEW" }) },
    { comment: sourceComment({ branch: "other-branch" }) },
    { comment: sourceComment({ base_sha: "d7d17550fdfe3ae3e06ecec352004ca3b7284c55" }) },
  ];
  for (const { comment } of variants) {
    assert.throws(() => createSourceEvent({
      sourceComment: comment,
      sourceIssueNumber: 202,
      sourceRepositoryFullName: "D22977/gpt-browser-bridge",
      eventKind: "WORKER_STARTED",
      authority,
      binding,
      branch: "work/gbb-g34-source-event-20261009-01",
      baseSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
      headSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
      state: "CONSUMED_STARTED",
      expectedAuthor: "D22977",
    }));
  }
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

test("a repeated resident publication preserves uncertain successor delivery and never resets it", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  await mkdir(path.join(runtimeRoot, "events"));
  await writeFile(path.join(runtimeRoot, "events", "g34-source-events.json"), JSON.stringify({
    [event.event_id]: {
      state: "SUCCESSOR_DELIVERY_UNCERTAIN", source_comment_id: event.source_comment_id,
      comment_id: "9001", control_comment_id: "8001", successor_comment_id: "8002",
    },
  }));
  let creates = 0;
  const github = {
    async findEventComments() { return [{ id: "9001" }]; },
    async createIssueComment() { creates++; throw new Error("must not resend"); },
    async getIssueComment(id) {
      assert.equal(id, "9001");
      return { id, url: "https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-9001", user: { login: "D22977" }, body: event.body };
    },
  };
  assert.equal((await publishSourceEvent({ event, issueNumber: 202, runtimeRoot, github })).state, "DELIVERY_UNCERTAIN");
  const ledger = JSON.parse(await readFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "SUCCESSOR_DELIVERY_UNCERTAIN");
  assert.equal(creates, 0);
});

test("duplicate source-event matches fail closed", async () => {
  assertImplemented();
  const event = sampleEvent();
  const github = clientFor(event.body, { matches: [{ id: "1" }, { id: "2" }] });
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  await assert.rejects(() => publishSourceEvent({ event, issueNumber: 202, runtimeRoot, github }), /DUPLICATE_EVENT/);
  assert.equal(github.calls.create, 0);
});

test("source event cannot be marked CONSUMED without a successor delivery attempt and confirmation", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  await publishSourceEvent({ event, issueNumber: 202, runtimeRoot, github: clientFor(event.body) });
  const args = { eventId: event.event_id, sourceCommentId: event.source_comment_id, controlCommentId: "8001", runtimeRoot };
  await assert.rejects(() => markSourceEventConsumed(args), /successor delivery attempt/);
  const ledger = JSON.parse(await readFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "DELIVERED");
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
