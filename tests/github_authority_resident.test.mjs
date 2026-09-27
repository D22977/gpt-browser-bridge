import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createLease,
  validateLease,
  createHeartbeat,
  watcherRunning,
  createWakeRequest,
  verifyAck,
  runOnce,
} from "../src/github_authority_resident.mjs";

const now = "2026-09-27T12:00:00.000Z";
const authority = {
  control_generation: "031",
  active_control_conversation_id: "control-031",
  current_start_receipt: "43:170",
  current_registry_receipt: "81:67",
  active_switch_receipt: "88:031",
  switch_conflict: false,
};
const leaseInput = {
  resident_instance_id: "resident-a",
  control_generation: "031",
  active_control_conversation_id: "control-031",
  acquired_at: "2026-09-27T11:59:00.000Z",
  expires_at: "2026-09-27T12:10:00.000Z",
  watched_issue_set: ["D22977/gpt-browser-bridge#162"],
  trigger_contract_hash: "contract-a",
};
const source = {
  source_repo: "D22977/gpt-browser-bridge",
  source_issue: 162,
  source_comment_id: "5850000001",
  source_event_type: "TERMINAL",
  control_generation: "031",
  active_control_conversation_id: "control-031",
  named_executor: "worker-a",
};

function lease(overrides = {}) {
  return createLease({ ...leaseInput, ...overrides });
}

function heartbeat(overrides = {}) {
  return createHeartbeat({
    lease_id: lease().lease_id,
    resident_instance_id: "resident-a",
    control_generation: "031",
    observed_at: now,
    lease_expires_at: lease().expires_at,
    last_processed_comment_id: "5850000000",
    trigger_contract_hash: "contract-a",
    ...overrides,
  });
}

function github(initial = [lease()]) {
  const receipts = initial.map((item, i) => ({ ...item, github_comment_id: String(i + 1) }));
  let next = receipts.length + 1;
  let failReadback = false;
  return {
    receipts,
    sourceEvents: [source],
    set failReadback(value) { failReadback = value; },
    async readAuthority() { return { ...authority }; },
    async listReceipts() { return receipts.map((r) => ({ ...r })); },
    async getReceipt(id) { return failReadback ? null : receipts.find((r) => r.github_comment_id === String(id)); },
    async listSourceEvents() { return this.sourceEvents.map((event) => ({ ...event })); },
    async publishReceipt(receipt) {
      const item = { ...receipt, github_comment_id: String(next++) };
      receipts.push(item);
      return item.github_comment_id;
    },
  };
}

function opts(client, transport = async () => "DELIVERED") {
  return { github: client, transport, residentInstanceId: "resident-a", triggerContractHash: "contract-a", now };
}

function ack(request, overrides = {}) {
  return {
    type: "ACTIVE_CONTROL_WAKE_ACK_V1",
    wake_request_id: request.wake_request_id,
    source_comment_id: request.source_comment_id,
    control_generation: "031",
    active_control_conversation_id: "control-031",
    rehydrated_current_start_receipt: authority.current_start_receipt,
    rehydrated_current_registry_receipt: authority.current_registry_receipt,
    rehydrated_active_switch_receipt: authority.active_switch_receipt,
    ack_idempotency_key: `ack:${request.wake_request_id}`,
    ...overrides,
  };
}

test("valid current lease and conflicting, expired, or stale leases fail closed", () => {
  const current = lease();
  assert.equal(validateLease(current, authority, [current], now).lease_id, current.lease_id);
  assert.throws(() => validateLease(current, authority, [current, lease({ resident_instance_id: "resident-b" })], now), /CONFLICTING_LEASE/);
  assert.throws(() => validateLease(lease({ expires_at: "2026-09-27T11:59:59.000Z" }), authority, [], now), /EXPIRED_LEASE/);
  assert.throws(() => validateLease(lease({ control_generation: "030" }), authority, [], now), /STALE_GENERATION/);
  assert.throws(() => validateLease(current, { ...authority, switch_conflict: true }, [current], now), /AUTHORITY/);
  assert.throws(() => validateLease(current, authority, [current, { ...current, lease_id: "other", expires_at: "not-a-time" }], now), /MALFORMED/);
  assert.throws(() => validateLease(current, authority, [current, { ...current, expires_at: "2026-09-27T12:11:00.000Z" }], now), /CONFLICTING_LEASE/);
});

test("heartbeat proves a live watcher only under exact current lease and freshness", () => {
  const current = lease();
  assert.equal(watcherRunning(heartbeat(), current, authority, now, 60_000), true);
  assert.equal(watcherRunning(heartbeat({ lease_id: "wrong" }), current, authority, now, 60_000), false);
  assert.equal(watcherRunning(heartbeat({ observed_at: "2026-09-27T11:58:00.000Z" }), current, authority, now, 60_000), false);
  assert.equal(watcherRunning(heartbeat(), current, authority, "2026-09-27T12:11:00.000Z", 60_000), false);
  assert.equal(watcherRunning(heartbeat({ observed_at: "2026-09-27T11:58:59.000Z" }), current, authority, "2026-09-27T11:59:10.000Z", 60_000), false);
  assert.equal(createHeartbeat({ ...heartbeat(), type: "FORGED" }).type, "LOCAL_CONTROL_RESIDENT_HEARTBEAT_V1");
});

test("GitHub numeric comment IDs survive exact receipt readback", async () => {
  const client = github();
  const originalGet = client.getReceipt;
  client.getReceipt = async (id) => {
    const item = await originalGet(id);
    return item && { ...item, github_comment_id: Number(item.github_comment_id) };
  };
  assert.equal((await runOnce(opts(client))).state, "WAIT_CONTROL_DECISION");
});

test("one source creates one read-back wake before minimal transport; duplicate and restart do not resend", async () => {
  const client = github();
  const pointers = [];
  const transport = async (pointer) => { pointers.push(pointer); return "DELIVERED"; };
  const first = await runOnce(opts(client, transport));
  assert.equal(first.state, "WAIT_CONTROL_DECISION");
  assert.equal(first.transport_diagnostic, "DELIVERED");
  assert.equal(client.receipts.filter((r) => r.type === "LOCAL_CONTROL_WAKE_REQUEST_V1").length, 1);
  assert.deepEqual(pointers, [{ source_repo: source.source_repo, source_issue: source.source_issue, source_comment_id: source.source_comment_id, wake_request_comment_id: first.wake_request_comment_id }]);
  const restarted = await runOnce(opts(client, transport));
  assert.equal(restarted.state, "NO_OP_DUPLICATE");
  assert.equal(restarted.semantic_state, "WAIT_CONTROL_DECISION");
  assert.equal(pointers.length, 1);
  assert.equal(client.receipts.filter((r) => r.type === "LOCAL_CONTROL_WAKE_REQUEST_V1").length, 1);
});

test("wrong-generation source and failed readback cannot notify transport", async () => {
  const client = github();
  let sends = 0;
  const transport = async () => { sends++; return "DELIVERED"; };
  client.sourceEvents = [{ ...source, control_generation: "030" }];
  await assert.rejects(runOnce(opts(client, transport)), /STALE_GENERATION/);
  assert.equal(sends, 0);
  client.sourceEvents = [source];
  client.failReadback = true;
  await assert.rejects(runOnce(opts(client, transport)), /READBACK/);
  assert.equal(sends, 0);
});

test("transport success, error, and webhook trigger never count as ACK", async () => {
  for (const outcome of ["DELIVERED", "ERROR", "WORKFLOW_SUCCESS"]) {
    const client = github();
    const result = await runOnce(opts(client, async () => outcome));
    assert.equal(result.state, "WAIT_CONTROL_DECISION");
    assert.equal(result.transport_diagnostic, outcome);
    assert.equal(result.ack_comment_id, undefined);
  }
});

test("exact GitHub ACK advances only wake consumption; bad ACK bindings fail closed", async () => {
  const request = createWakeRequest(source, lease());
  const current = lease();
  assert.equal(verifyAck(ack(request), request, authority), true);
  for (const change of [
    { wake_request_id: "wrong" },
    { source_comment_id: "wrong" },
    { control_generation: "030" },
    { active_control_conversation_id: "wrong" },
    { rehydrated_current_start_receipt: "stale" },
    { rehydrated_current_registry_receipt: "stale" },
    { rehydrated_active_switch_receipt: "stale" },
  ]) assert.throws(() => verifyAck(ack(request, change), request, authority), /ACK_BINDING/);
  const client = github([current, request, ack(request)]);
  const result = await runOnce(opts(client));
  assert.equal(result.state, "WAIT_CONTROL_DECISION");
  assert.equal(result.wake_consumed, true);
});

test("timeout cannot release WAIT; only later exact Control decision names executor", async () => {
  const request = createWakeRequest(source, lease());
  const client = github([lease(), request, ack(request)]);
  const waiting = await runOnce({ ...opts(client), now: "2026-09-27T12:09:00.000Z", actionTimeout: true });
  assert.equal(waiting.state, "WAIT_CONTROL_DECISION");
  client.receipts.push({
    type: "ACTIVE_CONTROL_SOURCE_DECISION_V1",
    wake_request_id: request.wake_request_id,
    source_comment_id: source.source_comment_id,
    control_generation: "031",
    active_control_conversation_id: "control-031",
    ack_comment_id: "3",
    named_executor: "wrong-worker",
    decision_idempotency_key: "decision-1",
    github_comment_id: "4",
  });
  await assert.rejects(runOnce(opts(client)), /DECISION_BINDING/);
  client.receipts[3].named_executor = "worker-a";
  const released = await runOnce(opts(client));
  assert.equal(released.state, "RELEASED_TO_NAMED_EXECUTOR");
  assert.equal(released.named_executor, "worker-a");
});

test("local cursor loss and duplicate ACK do not create another semantic wake", async () => {
  const request = createWakeRequest(source, lease());
  const client = github([lease(), request, ack(request), ack(request)]);
  const result = await runOnce({ ...opts(client), cursor: { corrupted: true } });
  assert.equal(result.state, "NO_OP_DUPLICATE");
  assert.equal(result.semantic_state, "WAIT_CONTROL_DECISION");
  assert.equal(client.receipts.filter((r) => r.type === "LOCAL_CONTROL_WAKE_REQUEST_V1").length, 1);
});

test("a newer switch before transport prevents notification", async () => {
  const client = github();
  let reads = 0;
  let sends = 0;
  client.readAuthority = async () => ++reads === 1 ? { ...authority } : { ...authority, control_generation: "032", active_control_conversation_id: "control-032" };
  await assert.rejects(runOnce(opts(client, async () => { sends++; })), /AUTHORITY_CHANGED/);
  assert.equal(sends, 0);
});

test("a released source does not starve the next GitHub source event", async () => {
  const request = createWakeRequest(source, lease());
  const second = { ...source, source_comment_id: "5850000002" };
  const client = github([lease(), request, ack(request), {
    type: "ACTIVE_CONTROL_SOURCE_DECISION_V1",
    wake_request_id: request.wake_request_id,
    source_comment_id: source.source_comment_id,
    control_generation: "031",
    active_control_conversation_id: "control-031",
    ack_comment_id: "3",
    named_executor: "worker-a",
    decision_idempotency_key: "decision-1",
  }]);
  client.sourceEvents = [source, second];
  const result = await runOnce(opts(client));
  assert.equal(result.state, "WAIT_CONTROL_DECISION");
  assert.equal(client.receipts.filter((r) => r.type === "LOCAL_CONTROL_WAKE_REQUEST_V1").length, 2);
});

test("different watched issue sets yield distinct lease identities, and terminal release needs a named executor", () => {
  assert.notEqual(lease().lease_id, lease({ watched_issue_set: ["D22977/gpt-browser-bridge#43"] }).lease_id);
  assert.throws(() => createWakeRequest({ ...source, named_executor: "" }, lease()), /NAMED_EXECUTOR/);
});

test("core contains no browser, Playwright, Herdr, or workflow import", async () => {
  const code = await readFile(new URL("../src/github_authority_resident.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(code, /(?:from|import\s*\()\s*["'][^"']*(?:playwright|browser|herdr|workflow)/i);
});
