import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHeartbeat, createLease, createWakeRequest } from "../src/github_authority_resident.mjs";

let runtime;
try { runtime = await import("../src/control_doorbell_runtime.mjs"); } catch {}

function authorityReceipt(commentId, controlGeneration, conversationId) {
  return {
    github_comment_id: commentId,
    control_generation: controlGeneration,
    active_control_conversation_id: conversationId,
    switch_conflict: false,
    producer_admission_comment_ids: ["4309"],
  };
}

function authoritySnapshot(generation = "generation033", conversation = "control-current") {
  return {
    control: authorityReceipt("8801", generation, conversation),
    registry: authorityReceipt("4301", generation, conversation),
    switch: authorityReceipt("8101", generation, conversation),
  };
}

function sourceEvent(generation = "generation033", conversation = "control-current") {
  return {
    source_repo: "D22977/gpt-browser-bridge",
    source_issue: 162,
    source_comment_id: "16201",
    source_event_type: "WAKE",
    control_generation: generation,
    active_control_conversation_id: conversation,
    producer_admission_comment_id: "4309",
  };
}

async function loadConfig() {
  return JSON.parse(await readFile(new URL("../config/control_doorbell_runtime.json", import.meta.url), "utf8"));
}

async function makeHarness({
  snapshot = authoritySnapshot(),
  source = sourceEvent(),
  leaseGeneration = snapshot.control.control_generation,
  leaseExpiresAt = "2026-10-01T02:00:00.000Z",
  heartbeatGeneration = leaseGeneration,
  localCache,
  send = async () => "transport-success",
} = {}) {
  assert.equal(typeof runtime?.createControlDoorbellRuntime, "function", "adapter must export createControlDoorbellRuntime");
  const config = await loadConfig();
  const residentInstanceId = "resident-test";
  const triggerContractHash = runtime.getTriggerContractHash(config);
  const now = "2026-10-01T01:00:00.000Z";
  const lease = {
    ...createLease({
      resident_instance_id: residentInstanceId,
      control_generation: leaseGeneration,
      active_control_conversation_id: snapshot.control.active_control_conversation_id,
      trigger_contract_hash: triggerContractHash,
      acquired_at: "2026-10-01T00:59:00.000Z",
      expires_at: leaseExpiresAt,
      watched_issue_set: [`${config.repository_full_name}#${source.source_issue}`],
    }),
    github_comment_id: "9001",
  };
  const heartbeat = createHeartbeat({
    lease_id: lease.lease_id,
    resident_instance_id: residentInstanceId,
    control_generation: heartbeatGeneration,
    trigger_contract_hash: triggerContractHash,
    observed_at: "2026-10-01T00:59:59.000Z",
    lease_expires_at: lease.expires_at,
    last_processed_comment_id: "16200",
  });
  const sourceReceipt = { ...source, github_comment_id: source.source_comment_id };
  const admissionReceipt = {
    github_comment_id: source.producer_admission_comment_id,
    control_generation: snapshot.control.control_generation,
    active_control_conversation_id: snapshot.control.active_control_conversation_id,
    source_repo: source.source_repo,
    source_issue: source.source_issue,
    source_comment_id: source.source_comment_id,
  };
  const receipts = [lease];
  const byId = new Map([
    [String(lease.github_comment_id), lease],
    [String(sourceReceipt.github_comment_id), sourceReceipt],
    [String(admissionReceipt.github_comment_id), admissionReceipt],
  ]);
  const sent = [];
  let currentSnapshot = snapshot;
  let nextId = 10000;
  const github = {
    async readAuthoritySnapshot() { return structuredClone(currentSnapshot); },
    async listReceipts() { return receipts.map((receipt) => structuredClone(receipt)); },
    async listSourceEvents() { return [structuredClone(source)]; },
    async readHeartbeat() { return structuredClone(heartbeat); },
    async getReceipt(id) { return structuredClone(byId.get(String(id)) ?? null); },
    async publishReceipt(receipt) {
      const item = { ...structuredClone(receipt), github_comment_id: String(nextId++) };
      receipts.push(item);
      byId.set(item.github_comment_id, item);
      return item.github_comment_id;
    },
  };
  const controller = runtime.createControlDoorbellRuntime({
    config,
    github,
    residentInstanceId,
    now: () => now,
    sendPointer: async (pointer) => {
      sent.push(structuredClone(pointer));
      return send(pointer);
    },
    localCache,
  });
  return {
    config, lease, source, receipts, byId, sent, github, controller,
    addReceipt(item) { receipts.push(item); byId.set(String(item.github_comment_id), item); },
    setSnapshot(value) { currentSnapshot = value; },
  };
}

test("T01 accepts generation033 only when all three current receipts agree", () => {
  assert.equal(typeof runtime?.selectCurrentAuthority, "function", "adapter must export selectCurrentAuthority");
  const authority = runtime.selectCurrentAuthority(authoritySnapshot());
  assert.equal(authority.control_generation, "generation033");
  assert.equal(authority.active_control_conversation_id, "control-current");
  assert.deepEqual(authority.producer_admission_comment_ids, ["4309"]);
});

test("T05 rejects forked generation or Control identity across current receipts", () => {
  const select = runtime?.selectCurrentAuthority;
  assert.equal(typeof select, "function", "adapter must export selectCurrentAuthority");
  const generationFork = authoritySnapshot();
  generationFork.registry.control_generation = "generation032";
  assert.throws(() => select(generationFork), /CONTROL_REQUIRED\/NO_SEND/);
  const identityFork = authoritySnapshot();
  identityFork.switch.active_control_conversation_id = "other-control";
  assert.throws(() => select(identityFork), /CONTROL_REQUIRED\/NO_SEND/);
});

test("T06 rejects malformed or missing current authority", () => {
  const select = runtime?.selectCurrentAuthority;
  assert.equal(typeof select, "function", "adapter must export selectCurrentAuthority");
  const missing = authoritySnapshot();
  delete missing.switch;
  assert.throws(() => select(missing), /CONTROL_REQUIRED\/NO_SEND/);
  const malformed = authoritySnapshot();
  malformed.registry.github_comment_id = "not-a-comment-id";
  assert.throws(() => select(malformed), /CONTROL_REQUIRED\/NO_SEND/);
});

test("T07 rejects a historical producer admission absent from current receipts", () => {
  const select = runtime?.selectCurrentAuthority;
  const admitted = runtime?.hasCurrentProducerAdmission;
  assert.equal(typeof select, "function", "adapter must export selectCurrentAuthority");
  assert.equal(typeof admitted, "function", "adapter must export hasCurrentProducerAdmission");
  const authority = select(authoritySnapshot());
  const source = { producer_admission_comment_id: "1400", control_generation: "generation014", active_control_conversation_id: "old-control" };
  const oldReceipt = { github_comment_id: "1400", control_generation: "generation014", active_control_conversation_id: "old-control" };
  assert.equal(admitted(source, authority, oldReceipt), false);
});

test("T08 accepts only a current durable producer admission with matching generation and Control identity", () => {
  const select = runtime?.selectCurrentAuthority;
  const admitted = runtime?.hasCurrentProducerAdmission;
  assert.equal(typeof select, "function", "adapter must export selectCurrentAuthority");
  assert.equal(typeof admitted, "function", "adapter must export hasCurrentProducerAdmission");
  const authority = select(authoritySnapshot());
  const source = { producer_admission_comment_id: "4309", control_generation: "generation033", active_control_conversation_id: "control-current" };
  const receipt = { github_comment_id: "4309", control_generation: "generation033", active_control_conversation_id: "control-current" };
  assert.equal(admitted(source, authority, receipt), true);
  assert.equal(admitted(source, authority, { ...receipt, control_generation: "generation032" }), false);
  assert.equal(admitted(source, authority, { ...receipt, active_control_conversation_id: "other-control" }), false);
});

test("T02 rejects a stale generation014 event", async () => {
  const h = await makeHarness({ source: sourceEvent("generation014", "old-control") });
  const result = await h.controller.poll();
  assert.equal(result.state, "CONTROL_REQUIRED/NO_SEND");
  assert.equal(h.sent.length, 0);
});

test("T03 rejects a wrong event generation", async () => {
  const h = await makeHarness({ source: sourceEvent("generation032", "control-current") });
  const result = await h.controller.poll();
  assert.equal(result.state, "CONTROL_REQUIRED/NO_SEND");
  assert.equal(h.sent.length, 0);
});

test("T04 rejects a wrong Control conversation identity", async () => {
  const h = await makeHarness({ source: sourceEvent("generation033", "other-control") });
  const result = await h.controller.poll();
  assert.equal(result.state, "CONTROL_REQUIRED/NO_SEND");
  assert.equal(h.sent.length, 0);
});

test("T09 duplicate event is a no-op and sends nothing", async () => {
  const h = await makeHarness();
  const wakeRequest = createWakeRequest(h.source, h.lease);
  h.addReceipt({ ...wakeRequest, github_comment_id: "9002" });
  const result = await h.controller.poll();
  assert.equal(result.state, "NO_OP_DUPLICATE");
  assert.equal(h.sent.length, 0);
});

test("T10 ambiguous prior send is never retried", async () => {
  let attempts = 0;
  const h = await makeHarness({ send: async () => { attempts += 1; throw new Error("uncertain send"); } });
  await h.controller.poll();
  const second = await h.controller.poll();
  assert.equal(second.state, "NO_OP_DUPLICATE");
  assert.equal(attempts, 1);
});

test("T11 local cache cannot override newer GitHub authority", async () => {
  const h = await makeHarness({ localCache: { control_generation: "generation014", active_control_conversation_id: "old-control" } });
  const result = await h.controller.poll();
  assert.equal(result.state, "WAIT_CONTROL_ACK");
  assert.equal(h.sent.length, 1);
});

test("T12 stale, expired, or wrong-generation lease cannot authorize a send", async () => {
  for (const options of [
    { leaseGeneration: "generation032" },
    { leaseExpiresAt: "2026-10-01T00:59:30.000Z" },
    { heartbeatGeneration: "generation032" },
  ]) {
    const h = await makeHarness(options);
    const result = await h.controller.poll();
    assert.equal(result.state, "CONTROL_REQUIRED/NO_SEND");
    assert.equal(h.sent.length, 0);
  }
});

test("T13 a fresh matching lease and heartbeat are non-semantic without a durable ACK", async () => {
  const h = await makeHarness();
  const result = await h.controller.poll();
  assert.equal(result.state, "WAIT_CONTROL_ACK");
  assert.equal(result.wake_consumed, false);
  assert.equal(h.sent.length, 1);
});

test("T14 transport success without exact durable ACK does not advance semantic state", async () => {
  const h = await makeHarness({ send: async () => ({ delivered: true }) });
  const result = await h.controller.poll();
  assert.equal(result.state, "WAIT_CONTROL_ACK");
  assert.equal(result.wake_consumed, false);
  assert.equal("release_id" in result, false);
});

test("T15 exact current ACK readback permits only the ACKED transition", async () => {
  const h = await makeHarness();
  const authority = runtime.selectCurrentAuthority(authoritySnapshot());
  const wakeRequest = createWakeRequest(h.source, h.lease);
  h.addReceipt({ ...wakeRequest, github_comment_id: "9002" });
  h.addReceipt({
    type: "ACTIVE_CONTROL_WAKE_ACK_V1",
    wake_request_id: wakeRequest.wake_request_id,
    source_comment_id: h.source.source_comment_id,
    control_generation: authority.control_generation,
    active_control_conversation_id: authority.active_control_conversation_id,
    rehydrated_current_start_receipt: authority.current_start_receipt,
    rehydrated_current_registry_receipt: authority.current_registry_receipt,
    rehydrated_active_switch_receipt: authority.active_switch_receipt,
    ack_idempotency_key: "ack-current-event",
    github_comment_id: "9003",
  });
  const result = await h.controller.poll();
  assert.equal(result.state, "ACKED");
  assert.equal(result.wake_consumed, true);
  assert.equal("release_id" in result, false);
  assert.equal(h.sent.length, 0);
});

test("T16 restart reconstructs current GitHub authority instead of stale local cache", async () => {
  const current = authoritySnapshot("generation034", "new-control");
  const h = await makeHarness({
    snapshot: current,
    source: sourceEvent("generation034", "new-control"),
    localCache: { control_generation: "generation033", active_control_conversation_id: "control-current" },
  });
  const result = await h.controller.poll();
  assert.equal(result.state, "WAIT_CONTROL_ACK");
  assert.equal(h.sent.length, 1);
});

test("T17 config has no fixed generation, Control identity, producer pin, pane, or workspace", async () => {
  const config = await loadConfig();
  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /generation(?:014|033)|control-current|old-control|conversation_id|pane|workspace/i);
  assert.doesNotMatch(serialized, /historical[-_ ]?producer|g14[-_ ]?producer/i);
});

test("T18 adapter has no fixed generation or generation014 authority gate", async () => {
  const source = await readFile(new URL("../src/control_doorbell_runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /generation014|generation033|\b014\b/);
});

test("T19 artifact mapping is deterministic and preserves the adopted core blob", async () => {
  const config = await loadConfig();
  assert.deepEqual(runtime.RUNTIME_ARTIFACT_MAPPING, config.artifact_mapping);
  assert.deepEqual(config.artifact_mapping, {
    adapter_source: "src/control_doorbell_runtime.mjs",
    adapter_runtime: "D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/watcher.mjs",
    config_source: "config/control_doorbell_runtime.json",
    config_runtime: "D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/config.json",
    semantic_core_source: "src/github_authority_resident.mjs",
    semantic_core_runtime: "D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/github_authority_resident.mjs",
    semantic_core_blob: "1a0c818321e64ec3dd4619e563d6845124af7c2b",
  });
});

test("T20 tests exercise only in-memory adapters and never invoke runtime side effects", async () => {
  const source = await readFile(new URL("../src/control_doorbell_runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|playwright|ScheduledTask|run\.ps1|execFile|https:\/\/api\.github\.com/);
});
