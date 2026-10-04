import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHeartbeat, createLease, createWakeRequest } from "../src/github_authority_resident.mjs";
import { createGitHubAuthorityAdapter } from "../src/github_authority_adapter.mjs";

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
  nowFn = () => "2026-10-01T01:00:00.000Z",
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
    now: nowFn,
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
    github_authority_adapter_source: "src/github_authority_adapter.mjs",
    github_authority_adapter_runtime: "D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/github_authority_adapter.mjs",
    semantic_core_source: "src/github_authority_resident.mjs",
    semantic_core_runtime: "D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/github_authority_resident.mjs",
    semantic_core_blob: "1a0c818321e64ec3dd4619e563d6845124af7c2b",
  });
});

test("T30 direct watcher sibling production imports have explicit artifact mappings", async () => {
  const source = await readFile(new URL("../src/control_doorbell_runtime.mjs", import.meta.url), "utf8");
  const config = await loadConfig();
  const importSpecifiers = [...source.matchAll(/from\s+"(\.\/[^\"]+)"/g)].map(([, specifier]) => specifier);
  const expected = new Map([
    ["./github_authority_resident.mjs", [
      "semantic_core_source",
      "src/github_authority_resident.mjs",
      "semantic_core_runtime",
      "D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/github_authority_resident.mjs",
    ]],
    ["./github_authority_adapter.mjs", [
      "github_authority_adapter_source",
      "src/github_authority_adapter.mjs",
      "github_authority_adapter_runtime",
      "D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/github_authority_adapter.mjs",
    ]],
  ]);
  const assertMappings = (mapping) => {
    assert.deepEqual(importSpecifiers, [...expected.keys()]);
    for (const [specifier, [sourceKey, sourcePath, runtimeKey, runtimePath]] of expected) {
      assert.equal(mapping[sourceKey], sourcePath, `${specifier} must have an explicit source mapping`);
      assert.equal(mapping[runtimeKey], runtimePath, `${specifier} must have an explicit runtime mapping`);
    }
  };

  assertMappings(config.artifact_mapping);
  const withoutAdapterPair = { ...config.artifact_mapping };
  delete withoutAdapterPair.github_authority_adapter_source;
  delete withoutAdapterPair.github_authority_adapter_runtime;
  assert.throws(() => assertMappings(withoutAdapterPair), /github_authority_adapter\.mjs/);
});

test("T20 tests exercise only in-memory adapters and never invoke runtime side effects", async () => {
  const source = await readFile(new URL("../src/control_doorbell_runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|playwright|ScheduledTask|run\.ps1|execFile|https:\/\/api\.github\.com/);
});

function issueComment(id, issue, body, repository = "D22977/gpt-browser-bridge", user = { id: 55701413, login: "D22977" }) {
  return { id, issue_url: `https://api.github.com/repos/${repository}/issues/${issue}`, body, user: structuredClone(user) };
}

function authorityComments(repository = "D22977/gpt-browser-bridge") {
  const activeBody = [
    "CONTROL_GENERATION_ATOMIC_SWITCH_V1",
    `repository: ${repository}`,
    "current_active_generation: 033",
    "active_control_conversation_id: control-current",
    "single_active_control: true",
    'producer_admission_comment_ids: ["4309"]',
  ].join("\n");
  return [
    issueComment("4301", 43, [
      "CURRENT_REHYDRATION_INDEX_V102",
      `repository: ${repository}`,
      "control_generation: 033 ACTIVE_REHYDRATED",
      'producer_admission_comment_ids: ["4309"]',
      "webgpt_route: Issue #88 comment 8801 / generation033",
    ].join("\n"), repository),
    issueComment("8101", 81, [
      "CURRENT_REGISTRY_INDEX_V102",
      `repository: ${repository}`,
      "control_generation: 033 ACTIVE_REHYDRATED",
      "source_current_start: Issue #43 comment 4301",
      'producer_admission_comment_ids: ["4309"]',
    ].join("\n"), repository),
    issueComment("8801", 88, activeBody, repository),
  ];
}

function generation033AuthorityComments() {
  const repository = "D22977/gpt-browser-bridge";
  return [
    issueComment("5921589118", 43, [
      "CURRENT_REHYDRATION_INDEX_V243",
      "state: CURRENT_START_HERE_ACTIVE_CONTROL033_EVIDENCE_ACCESS_REPAIR_CARD_ACTIVE",
      "recorded_by_role: ACTIVE_CONTROL",
      `repository: ${repository}`,
      "control_generation: 033 ACTIVE",
      "supersedes: #43/5921517363 V242",
      "active_control_ack: #88/5921541952",
      "inventory_return: #162/5921557196",
      "active_repair_card: #162/5921584474",
      "owner_continuation: #43/5921003901",
      "operational_goal_complete: false",
      "SCOPE_ADJUDICATION",
      "startup_skill_memory_reads: accepted only as nonauthoritative bootstrap read exception",
      "old_inventory_terminal: #162/5921329668 BLOCKED preserved",
      "old_scope_evidence: #162/5921201586 adjudicated by #162/5921584474",
      "old_event: consumed once never replay",
      "CURRENT_GAP",
      "source_checkout_identity: UNKNOWN_PENDING_REPAIR",
      "matching_process_state: UNKNOWN_PENDING_REPAIR",
      "matching_scheduled_task_state: UNKNOWN_PENDING_REPAIR",
      "activation_target: NOT_DETERMINABLE",
      "CURRENT_NEXT",
      "Bind exactly one current-user native read-only evidence/access Worker under #162/5921584474, then durable binding/readback + dispatch/readback + one minimal pointer.",
      "No activation, lease, heartbeat, monitor, review, product dispatch, merge, release, deploy, or workflow dispatch is authorized.",
      "user_relay_count: 0",
      "readback_required: true",
      "idempotency_key: CURRENT-REHYDRATION-INDEX-033-V243-EVIDENCE-ACCESS-REPAIR-20261001-01",
    ].join("\n"), repository),
    issueComment("5921593188", 81, [
      "CURRENT_REGISTRY_INDEX_V139",
      "state: CURRENT_ACTIVE_CONTROL033_EVIDENCE_ACCESS_REPAIR_CARD_ACTIVE",
      "recorded_by_role: ACTIVE_CONTROL",
      `repository: ${repository}`,
      "control_generation: 033 ACTIVE",
      "supersedes: #81/5921522813 V138",
      "current_start: #43/5921589118 V243 exact GET matched",
      "active_control_id: 6abd98f5-5808-83e8-852c-f01a16cebf24",
      "active_control_ack: #88/5921541952",
      "GitHub_sole_durable_semantic_authority: true",
      "owner_continuation: #43/5921003901",
      "restoration_goal_complete: false",
      "current_repair_card: #162/5921584474",
      "prior_inventory_terminal: #162/5921329668 BLOCKED",
      "scope_evidence: #162/5921201586 adjudicated by current repair card",
      "old_inventory_event: consumed once never replay",
      "executor_required: separately bound CURRENT_USER_NATIVE_READ_ONLY evidence/access Worker",
      "source_checkout_identity: UNKNOWN",
      "matching_process_state: UNKNOWN",
      "matching_scheduled_task_state: UNKNOWN",
      "activation_target: NOT_DETERMINABLE",
      "runtime_activation: NOT_AUTHORIZED",
      "generation033_lease: NONE",
      "matching_fresh_heartbeat: NONE",
      "watcher_running: false",
      "monitoring_claimed: false",
      "merge_release_deploy_workflow_dispatch: false",
      "next_action: bind/readback one exact evidence/access Worker under #162/5921584474; then dispatch/readback and one minimal pointer",
      "user_relay_count: 0",
      "readback_required: true",
      "idempotency_key: CURRENT-REGISTRY-033-V139-EVIDENCE-ACCESS-REPAIR-20261001-01",
    ].join("\n"), repository),
    issueComment("5921541952", 88, [
      "ACTIVE_CONTROL_REHYDRATION_ACK_V1",
      "state: ACTIVE_REHYDRATED_ACKNOWLEDGED",
      "recorded_by_role: ACTIVE_CONTROL",
      `repository: ${repository}`,
      "generation: 033",
      "display_name: 控制塔-033",
      "conversation_id: 6abd98f5-5808-83e8-852c-f01a16cebf24",
      "conversation_url: https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhuan-an/c/6abd98f5-5808-83e8-852c-f01a16cebf24",
      "request: #88/5921532548 exact GET matched",
      "atomic_switch: #88/5921509976 exact GET matched",
      "current_start: #43/5921517363 V242 exact GET matched",
      "current_registry: #81/5921522813 V138 exact GET matched",
      "current_handoff: #81/5921528371 V91 exact GET matched",
      "binding: #88/5921437836 exact GET matched",
      "sole_active_control_generation: 033",
      "sole_active_control_identity_match: true",
      "generation031: RETIRED",
      "generation032: EXHAUSTED_NEVER_ACTIVE",
      "state_pointer_consistency: matched",
      "preserved_inventory_card: #162/5921088577",
      "preserved_worker_start: #162/5921222417",
      "preserved_worker_terminal: #162/5921329668 BLOCKED",
      "preserved_scope_evidence: #162/5921201586 unadjudicated",
      "preserved_return_request: #162/5921365073",
      "prior_inventory_event_replay: FORBIDDEN",
      "fresh_review: NOT_STARTED",
      "semantic_adjudication_performed: false",
      "successor_authorized_or_dispatched: false",
      "review_performed: false",
      "runtime_activation_performed: false",
      "generation033_lease: NONE",
      "matching_fresh_heartbeat: NONE",
      "watcher_running: false",
      "monitoring_claimed: false",
      "idempotency_key: GBB-CONTROL-G33-ACTIVE-REHYDRATION-ACK-20261001-01",
      "user_relay_count: 0",
      "readback_required: true",
    ].join("\n"), repository),
    issueComment("5921509976", 88, [
      "CONTROL_GENERATION_ATOMIC_SWITCH_V1",
      "state: ACTIVE_SWITCH_COMMITTED_READBACK_REQUIRED",
      "recorded_by_role: LOCAL_CONTROL_TRANSPORT",
      `repository: ${repository}`,
      "rotation_id: GBB-CONTROL-ROTATION-031-033-20261001-01",
      "idempotency_key: GBB-CONTROL-ROTATION-031-033-ATOMIC-SWITCH-20261001-01",
      "source_previous_active_switch: #88/5851638517",
      "source_route_correction: #88/5880567553",
      "source_rotation: #88/5921408923",
      "candidate_binding: #88/5921437836",
      "candidate_generation_ACK: #88/5921461828",
      "candidate_continuity_ACK: #88/5921466370",
      "candidate_route_PASS: #88/5921489518",
      "independent_Local_Transport_R3: #88/5921502165 PASS / exact GET readback matched",
      "current_start_before_switch: #43/5921097721 V241",
      "current_registry_before_switch: #81/5921102843 V137",
      "current_handoff_before_switch: #81/5921106003 V90",
      "OLD_CONTROL",
      "generation: 031",
      "status_before: ACTIVE_UNTIL_ATOMIC_SWITCH_LIMIT_REACHED",
      "status_after: RETIRED",
      "conversation_id: 6ab86a5c-b190-83e8-9c60-c50b4ae8507e",
      "conversation_url: https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhuan-an/c/6ab86a5c-b190-83e8-9c60-c50b4ae8507e",
      "NEW_CONTROL",
      "generation: 033",
      "display_name: 控制塔-033",
      "status_before: CANDIDATE_ACKED_CONTINUITY_ROUTE_PROVEN_NOT_ACTIVE",
      "status_after: ACTIVE",
      "conversation_id: 6abd98f5-5808-83e8-852c-f01a16cebf24",
      "conversation_url: https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhuan-an/c/6abd98f5-5808-83e8-852c-f01a16cebf24",
      "single_active_control: true",
      "generation032: EXHAUSTED_NEVER_ACTIVE / #88/5921401034 / do not send",
      "PRESERVED_WORK",
      "owner_restoration_goal: #43/5921003901 / NOT_COMPLETE",
      "inventory_card: #162/5921088577",
      "Worker_start: #162/5921222417",
      "Worker_terminal: #162/5921329668 BLOCKED",
      "return_request: #162/5921365073",
      "scope_evidence: #162/5921201586 unadjudicated",
      "event_consumed_once_never_replay: true",
      "fresh_review: not started, BLOCKED not READY",
      "historical_unresolved_lanes_errors: preserved by #81/5921106003 and prior lineage; no resets",
      "new_rotation_failures: old031 reactive hard limit; candidate032 reached limit before activation, rejection preserved",
      "MONITOR",
      "generation033_lease: NONE",
      "matching_fresh_heartbeat: NONE",
      "watcher_running: false",
      "monitoring_claimed: false",
      "POST_SWITCH",
      "next_action: exact GET this switch, publish/readback post-switch #43/#81 current indexes bound to this switch, then exactly one minimal active-rehydration pointer to new033",
      "require_new_Control_own_ACTIVE_CONTROL_REHYDRATION_ACK_V1_readback_before_semantic_work: true",
      "old031_or032_send: FORBIDDEN; stale routing is NO_OP_RETIRED/NO_OP_NEVER_ACTIVE without physical send",
      "runtime_product_mutation_activation_review_merge_release_deploy: false",
      "user_relay_count: 0",
      "readback_required: true",
    ].join("\n"), repository),
  ];
}

function mutateAuthorityRecord(records, id, mutate) {
  const row = records.find((comment) => comment.id === id);
  assert.ok(row, `missing fixture comment ${id}`);
  row.body = mutate(row.body);
}

function replaceRecordText(records, id, before, after) {
  mutateAuthorityRecord(records, id, (body) => {
    assert.equal(body.split(before).length - 1, 1, `expected one ${before} in ${id}`);
    return body.replace(before, after);
  });
}

function replaceFirstRecordText(records, id, before, after) {
  mutateAuthorityRecord(records, id, (body) => {
    assert.ok(body.includes(before), `expected ${before} in ${id}`);
    return body.replace(before, after);
  });
}

function setRecordField(records, id, field, value) {
  mutateAuthorityRecord(records, id, (body) => {
    const pattern = new RegExp(`^${field}: .*?$`, "gm");
    const matches = [...body.matchAll(pattern)];
    assert.equal(matches.length, 1, `expected one ${field} in ${id}`);
    return body.replace(pattern, `${field}: ${value}`);
  });
}

function replaceSectionField(records, id, section, nextSection, field, value) {
  mutateAuthorityRecord(records, id, (body) => {
    const start = body.indexOf(`${section}\n`);
    const end = body.indexOf(`\n${nextSection}\n`, start);
    assert.ok(start >= 0 && end > start, `missing ${section} section in ${id}`);
    const sectionBody = body.slice(start, end);
    const fieldPattern = new RegExp(`^${field}: .*?$`, "m");
    assert.equal((sectionBody.match(new RegExp(`^${field}: .*?$`, "gm")) ?? []).length, 1, `expected one ${field} in ${section}`);
    const updated = sectionBody.replace(fieldPattern, `${field}: ${value}`);
    return `${body.slice(0, start)}${updated}${body.slice(end)}`;
  });
}

async function pollInvalidAuthorityWithoutEffects(records, fetchOverride) {
  const config = await loadConfig();
  const backend = fakeGitHub({ comments: records });
  let publisherCalls = 0;
  let transportCalls = 0;
  const adapter = makeAdapter(config, {
    fetchImpl: fetchOverride ? fetchOverride(backend) : backend.fetchImpl,
    publisher: async () => { publisherCalls += 1; return "99999"; },
  });
  const controller = runtime.createControlDoorbellRuntime({
    config,
    github: adapter,
    residentInstanceId: config.resident_instance_id,
    now: () => "2026-10-04T13:00:42.000Z",
    sendPointer: async () => { transportCalls += 1; return "transport-called"; },
  });
  await assert.rejects(adapter.readAuthoritySnapshot());
  assert.deepEqual(await controller.poll(), { state: "CONTROL_REQUIRED/NO_SEND" });
  assert.equal(publisherCalls, 0);
  assert.equal(transportCalls, 0);
  assert.equal(backend.calls.some((call) => call.method !== "GET"), false);
}

function fakeGitHub({ repository = "D22977/gpt-browser-bridge", comments = authorityComments(repository) } = {}) {
  const rows = new Map(comments.map((comment) => [String(comment.id), structuredClone(comment)]));
  const calls = [];
  let nextId = 20000;
  async function fetchImpl(url, options = {}) {
    const method = options.method ?? "GET";
    const parsed = new URL(url);
    calls.push({ url, method, headers: options.headers ?? {} });
    const issueComments = new RegExp(`^/repos/${repository}/issues/(\\d+)/comments$`).exec(parsed.pathname);
    if (method === "GET" && issueComments) {
      const issue = Number(issueComments[1]);
      return jsonResponse([...rows.values()].filter((comment) => comment.issue_url.endsWith(`/issues/${issue}`)));
    }
    if (method === "POST" && issueComments) {
      const issue = Number(issueComments[1]);
      const body = JSON.parse(options.body)?.body;
      if (typeof body !== "string") return jsonResponse({ message: "invalid body" }, 422);
      const row = issueComment(String(nextId++), issue, body, repository);
      rows.set(String(row.id), row);
      return jsonResponse(row, 201);
    }
    const exact = new RegExp(`^/repos/${repository}/issues/comments/(\\d+)$`).exec(parsed.pathname);
    if (method === "GET" && exact) {
      const row = rows.get(exact[1]);
      return row ? jsonResponse(row) : jsonResponse({ message: "not found" }, 404);
    }
    return jsonResponse({ message: "unexpected fake route" }, 404);
  }
  function add(issue, body) {
    const row = issueComment(String(nextId++), issue, body, repository);
    rows.set(String(row.id), row);
    return row.id;
  }
  return { rows, calls, fetchImpl, add };
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; },
    headers: { get() { return null; } },
  };
}

async function withSiblingConfig(config, action) {
  const directory = await mkdtemp(join(tmpdir(), "gbb-g33-config-"));
  const moduleUrl = pathToFileURL(join(directory, "watcher.mjs")).href;
  const configPath = join(directory, "config.json");
  try {
    await writeFile(configPath, JSON.stringify(config), "utf8");
    return await action({ directory, moduleUrl, configPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function makeAdapter(config, options = {}) {
  return createGitHubAuthorityAdapter({
    token: "test-token",
    repository: config.repository_full_name,
    authorityIssueNumbers: config.authority_issue_numbers,
    sourceIssueNumber: config.source_issue_number,
    fetchImpl: options.fetchImpl,
    publisher: options.publisher,
    now: options.now ?? (() => "2026-10-01T01:00:00.000Z"),
  });
}

test("T21 module import stays idle and only the explicit --loop argument is accepted", () => {
  const moduleUrl = new URL("../src/control_doorbell_runtime.mjs", import.meta.url).href;
  assert.equal(runtime.isDirectExecution(process.argv[1], moduleUrl), false);
  assert.equal(runtime.parseLoopArguments(["--loop"]), true);
  assert.throws(() => runtime.parseLoopArguments([]), /UNSUPPORTED_CLI/);
  assert.throws(() => runtime.parseLoopArguments(["--once"]), /UNSUPPORTED_CLI/);
  assert.throws(() => runtime.parseLoopArguments(["--loop", "--force"]), /UNSUPPORTED_CLI/);
});

test("T22 sibling config.json loads by module URL and missing or invalid config fails closed", async () => {
  const config = await loadConfig();
  await withSiblingConfig(config, async ({ moduleUrl, configPath }) => {
    assert.deepEqual(await runtime.loadSiblingConfig(moduleUrl), config);
    await rm(configPath);
    await assert.rejects(runtime.loadSiblingConfig(moduleUrl), /CONTROL_REQUIRED\/NO_SEND/);
    await writeFile(configPath, "{bad json", "utf8");
    await assert.rejects(runtime.loadSiblingConfig(moduleUrl), /CONTROL_REQUIRED\/NO_SEND/);
  });
});

test("T23 --loop starts an injected resident poll loop", async () => {
  const config = await loadConfig();
  const stop = new Error("stop test loop");
  let polls = 0;
  let starts = 0;
  await withSiblingConfig(config, async ({ moduleUrl }) => {
    await assert.rejects(runtime.startWatcher(["--loop"], {
      moduleUrl,
      env: { GITHUB_TOKEN: "test-token" },
      createRuntime: async (loadedConfig) => {
        starts += 1;
        assert.deepEqual(loadedConfig, config);
        return { pollIntervalMs: config.poll_interval_ms, async poll() { polls += 1; } };
      },
      sleep: async (delay) => {
        assert.equal(delay, config.poll_interval_ms);
        throw stop;
      },
    }), (error) => error === stop);
  });
  assert.equal(starts, 1);
  assert.equal(polls, 1);
});

test("T24 config requires a generation-neutral resident_instance_id", async () => {
  const config = await loadConfig();
  assert.equal(typeof config.resident_instance_id, "string");
  assert.equal(runtime.validateConfig(config), config);
  for (const resident_instance_id of [undefined, "generation033", "control-current", "w3:p9", "reviewer-session-7", "g14-producer"]) {
    assert.throws(() => runtime.validateConfig({ ...config, resident_instance_id }), /CONTROL_REQUIRED\/NO_SEND/);
  }
});

test("T25 missing GITHUB_TOKEN fails before GitHub fetch or transport", async () => {
  const config = await loadConfig();
  const backend = fakeGitHub();
  await withSiblingConfig(config, async ({ moduleUrl }) => {
    await assert.rejects(runtime.startWatcher(["--loop"], {
      moduleUrl,
      env: {},
      fetchImpl: backend.fetchImpl,
      sleep: async () => assert.fail("poll loop must not start without authentication"),
    }), /GITHUB_AUTH_REQUIRED/);
  });
  assert.equal(backend.calls.length, 0);
});

test("T26 production clock is called freshly once for each resident poll", async () => {
  let nowCalls = 0;
  const h = await makeHarness({ nowFn: () => { nowCalls += 1; return "2026-10-01T01:00:00.000Z"; } });
  await h.controller.poll();
  await h.controller.poll();
  assert.equal(nowCalls, 2);
});

test("T27 GitHub adapter exact-reads authority and publishes then exact-reads a receipt", async () => {
  const config = await loadConfig();
  const backend = fakeGitHub();
  const writes = [];
  const adapter = makeAdapter(config, {
    fetchImpl: backend.fetchImpl,
    publisher: async ({ issue, body }) => {
      writes.push({ issue, body });
      return backend.add(issue, body);
    },
  });
  const snapshot = await adapter.readAuthoritySnapshot();
  assert.equal(snapshot.control.control_generation, "033");
  assert.equal(snapshot.control.active_control_conversation_id, "control-current");
  assert.deepEqual(snapshot.switch.producer_admission_comment_ids, ["4309"]);

  const receipt = {
    type: "LOCAL_CONTROL_WAKE_REQUEST_V1",
    wake_request_id: "wake-id-1",
    lease_id: "lease-1",
    resident_instance_id: config.resident_instance_id,
    source_repo: config.repository_full_name,
    source_issue: config.source_issue_number,
    source_comment_id: "16299",
    source_event_type: "WAKE",
    control_generation: "033",
    active_control_conversation_id: "control-current",
    trigger_contract_hash: "a".repeat(64),
    idempotency_key: "wake-id-1",
  };
  const id = await adapter.publishReceipt(receipt);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].issue, config.source_issue_number);
  assert.ok(backend.rows.get(String(id)));
  assert.ok(backend.calls.some((call) => call.url.endsWith(`/issues/comments/${id}`)));
  assert.ok(backend.calls.every((call) => call.headers.Authorization === "Bearer test-token"));
});

test("T30 exact generation 033 records normalize V243/V139, ACK, and NEW_CONTROL switch", async () => {
  const config = await loadConfig();
  const backend = fakeGitHub({ comments: generation033AuthorityComments() });
  const adapter = makeAdapter(config, { fetchImpl: backend.fetchImpl });
  const snapshot = await adapter.readAuthoritySnapshot();

  assert.deepEqual([
    snapshot.control.control_generation,
    snapshot.control.active_control_conversation_id,
    snapshot.control.github_comment_id,
    snapshot.registry.github_comment_id,
    snapshot.switch.github_comment_id,
  ], [
    "033",
    "6abd98f5-5808-83e8-852c-f01a16cebf24",
    "5921589118",
    "5921593188",
    "5921509976",
  ]);
  assert.deepEqual(snapshot.control.producer_admission_comment_ids, []);
  assert.deepEqual(snapshot.registry.producer_admission_comment_ids, []);
  assert.deepEqual(snapshot.switch.producer_admission_comment_ids, []);
  assert.equal(backend.calls.every((call) => call.method === "GET"), true);
  for (const id of ["5921589118", "5921593188", "5921541952", "5921509976"]) {
    assert.ok(backend.calls.some((call) => call.method === "GET" && call.url.endsWith(`/issues/comments/${id}`)), `missing exact GET for ${id}`);
  }
});

test("T31 malformed exact generation 033 pointers and identities fail closed without side effects", async (t) => {
  const mutations = [
    ["missing start ACK pointer", (rows) => replaceRecordText(rows, "5921589118", "active_control_ack: #88/5921541952", "")],
    ["duplicate start ACK pointer", (rows) => replaceRecordText(rows, "5921589118", "active_control_ack: #88/5921541952", "active_control_ack: #88/5921541952\nactive_control_ack: #88/5921541952")],
    ["unrecognized pointer alias", (rows) => replaceRecordText(rows, "5921589118", "active_control_ack: #88/5921541952", "active_control_ack_id: #88/5921541952")],
    ["missing registry current start", (rows) => replaceRecordText(rows, "5921593188", "current_start: #43/5921589118 V243 exact GET matched", "")],
    ["missing registry identity", (rows) => replaceRecordText(rows, "5921593188", "active_control_id: 6abd98f5-5808-83e8-852c-f01a16cebf24", "")],
    ["wrong current start issue", (rows) => replaceRecordText(rows, "5921593188", "current_start: #43/5921589118 V243 exact GET matched", "current_start: #81/5921589118 V243 exact GET matched")],
    ["malformed trailing text in switch pointer", (rows) => replaceRecordText(rows, "5921541952", "atomic_switch: #88/5921509976 exact GET matched", "atomic_switch: #88/5921509976 trailing text")],
    ["malformed historical ACK snapshot pointer", (rows) => replaceRecordText(rows, "5921541952", "current_start: #43/5921517363 V242 exact GET matched", "current_start: #81/5921517363 V242 exact GET matched")],
    ["ACK points to itself as switch", (rows) => replaceRecordText(rows, "5921541952", "atomic_switch: #88/5921509976 exact GET matched", "atomic_switch: #88/5921541952 exact GET matched")],
    ["wrong repository", (rows) => replaceRecordText(rows, "5921593188", "repository: D22977/gpt-browser-bridge", "repository: D22977/other")],
    ["index generation mismatch", (rows) => replaceRecordText(rows, "5921593188", "control_generation: 033 ACTIVE", "control_generation: 034 ACTIVE")],
    ["stale ACK identity", (rows) => replaceRecordText(rows, "5921541952", "conversation_id: 6abd98f5-5808-83e8-852c-f01a16cebf24", "conversation_id: 6ab86a5c-b190-83e8-9c60-c50b4ae8507e")],
    ["switch URL mismatch", (rows) => replaceSectionField(rows, "5921509976", "NEW_CONTROL", "PRESERVED_WORK", "conversation_url", "https://chatgpt.com/other/c/6abd98f5-5808-83e8-852c-f01a16cebf24")],
    ["ambiguous NEW_CONTROL section", (rows) => replaceRecordText(rows, "5921509976", "NEW_CONTROL\ngeneration: 033", "NEW_CONTROL\nNEW_CONTROL\ngeneration: 033")],
    ["OLD_CONTROL remains active", (rows) => replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "status_after", "ACTIVE")],
    ["missing OLD_CONTROL status_after", (rows) => replaceRecordText(rows, "5921509976", "status_after: RETIRED\nconversation_id:", "conversation_id:")],
    ["duplicate OLD_CONTROL status_after", (rows) => replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "status_after", "RETIRED\nstatus_after: RETIRED")],
    ["malformed OLD_CONTROL status_after", (rows) => replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "status_after", "retired")],
    ["unknown OLD_CONTROL field", (rows) => replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "status_after", "RETIRED\nunexpected: field")],
    ["malformed OLD_CONTROL generation", (rows) => replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "generation", "031x")],
    ["OLD_CONTROL generation matches NEW_CONTROL", (rows) => replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "generation", "033")],
    ["malformed OLD_CONTROL conversation ID", (rows) => {
      replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "conversation_id", "not-a-uuid");
      replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "conversation_url", "https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhu-an/c/not-a-uuid");
    }],
    ["OLD_CONTROL conversation URL identity mismatch", (rows) => replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "conversation_url", "https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhu-an/c/33333333-3333-3333-3333-333333333333")],
    ["OLD_CONTROL identity duplicates NEW_CONTROL", (rows) => {
      replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "conversation_id", "6abd98f5-5808-83e8-852c-f01a16cebf24");
      replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "conversation_url", "https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhu-an/c/6abd98f5-5808-83e8-852c-f01a16cebf24");
    }],
    ["OLD_CONTROL UUID case alias duplicates NEW_CONTROL", (rows) => {
      replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "conversation_id", "6ABD98F5-5808-83E8-852C-F01A16CEBF24");
      replaceSectionField(rows, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "conversation_url", "https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhu-an/c/6ABD98F5-5808-83E8-852C-F01A16CEBF24");
    }],
    ["ambiguous OLD_CONTROL section", (rows) => replaceRecordText(rows, "5921509976", "OLD_CONTROL\ngeneration: 031", "OLD_CONTROL\nOLD_CONTROL\ngeneration: 031")],
    ["pointer comment is absent", (rows) => replaceRecordText(rows, "5921589118", "active_control_ack: #88/5921541952", "active_control_ack: #88/5999999999")],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const records = generation033AuthorityComments();
      mutate(records);
      await pollInvalidAuthorityWithoutEffects(records);
    });
  }
});

test("T32 exact GET envelope, ID, and body mismatches fail closed", async (t) => {
  const cases = [
    ["wrong exact comment ID", (backend) => async (url, options) => {
      const response = await backend.fetchImpl(url, options);
      if (url.endsWith("/issues/comments/5921589118")) return jsonResponse({ ...(await response.json()), id: 5921589119 });
      return response;
    }],
    ["wrong exact repository envelope", (backend) => async (url, options) => {
      const response = await backend.fetchImpl(url, options);
      if (url.endsWith("/issues/comments/5921589118")) return jsonResponse({ ...(await response.json()), issue_url: "https://api.github.com/repos/D22977/other/issues/43" });
      return response;
    }],
    ["wrong exact issue envelope", (backend) => async (url, options) => {
      const response = await backend.fetchImpl(url, options);
      if (url.endsWith("/issues/comments/5921589118")) return jsonResponse({ ...(await response.json()), issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/81" });
      return response;
    }],
    ["exact body differs from listed body", (backend) => async (url, options) => {
      const response = await backend.fetchImpl(url, options);
      if (url.endsWith("/issues/comments/5921589118")) return jsonResponse({ ...(await response.json()), body: `${(await response.json()).body}\ntrailing` });
      return response;
    }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => pollInvalidAuthorityWithoutEffects(generation033AuthorityComments(), override));
  }
});

test("T33 parser selects NEW_CONTROL and accepts a different current generation", async () => {
  const config = await loadConfig();
  const records = generation033AuthorityComments();
  const nextIdentity = "9e33e932-3952-49b6-a37b-443242bea2ee";
  const nextUrl = `https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhu-an/c/${nextIdentity}`;
  replaceRecordText(records, "5921589118", "control_generation: 033 ACTIVE", "control_generation: 034 ACTIVE");
  replaceRecordText(records, "5921593188", "control_generation: 033 ACTIVE", "control_generation: 034 ACTIVE");
  replaceRecordText(records, "5921593188", "active_control_id: 6abd98f5-5808-83e8-852c-f01a16cebf24", `active_control_id: ${nextIdentity}`);
  replaceFirstRecordText(records, "5921541952", "generation: 033", "generation: 034");
  setRecordField(records, "5921541952", "conversation_id", nextIdentity);
  setRecordField(records, "5921541952", "conversation_url", nextUrl);
  replaceRecordText(records, "5921541952", "sole_active_control_generation: 033", "sole_active_control_generation: 034");
  replaceSectionField(records, "5921509976", "NEW_CONTROL", "PRESERVED_WORK", "generation", "034");
  replaceSectionField(records, "5921509976", "NEW_CONTROL", "PRESERVED_WORK", "conversation_id", nextIdentity);
  replaceSectionField(records, "5921509976", "NEW_CONTROL", "PRESERVED_WORK", "conversation_url", nextUrl);
  replaceSectionField(records, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "generation", "099");
  replaceSectionField(records, "5921509976", "OLD_CONTROL", "NEW_CONTROL", "status_after", "RETIRED");

  const backend = fakeGitHub({ comments: records });
  const adapter = makeAdapter(config, { fetchImpl: backend.fetchImpl });
  const snapshot = await adapter.readAuthoritySnapshot();
  assert.equal(snapshot.control.control_generation, "034");
  assert.equal(snapshot.control.active_control_conversation_id, nextIdentity);
  assert.equal(snapshot.switch.github_comment_id, "5921509976");
});

test("T28 pointer delivery request is deterministic and duplicate publishing is idempotent", async () => {
  const config = await loadConfig();
  const backend = fakeGitHub();
  const adapter = makeAdapter(config, { fetchImpl: backend.fetchImpl });
  const pointer = {
    source_repo: config.repository_full_name,
    source_issue: config.source_issue_number,
    source_comment_id: "16277",
    wake_request_comment_id: "16288",
  };
  const first = await adapter.sendPointer(pointer);
  const second = await adapter.sendPointer(pointer);
  assert.equal(first.idempotency_key, second.idempotency_key);
  assert.match(first.idempotency_key, /^[0-9a-f]{64}$/);
  assert.equal(first.github_comment_id, second.github_comment_id);
  const posted = [...backend.rows.values()].filter((row) => row.body.startsWith("GBB_LOCAL_CONTROL_POINTER_DELIVERY_REQUEST_V1\n"));
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, new RegExp(`^GBB_LOCAL_CONTROL_POINTER_DELIVERY_REQUEST_V1\\nsource_repo: ${config.repository_full_name}\\nsource_issue: ${config.source_issue_number}\\nsource_comment_id: ${pointer.source_comment_id}\\nwake_request_comment_id: ${pointer.wake_request_comment_id}\\nidempotency_key: ${first.idempotency_key}$`));
});

test("T29 transport stays separate and delegates to the pinned semantic core", async () => {
  const [runtimeSource, adapterSource, coreSource, config] = await Promise.all([
    readFile(new URL("../src/control_doorbell_runtime.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/github_authority_adapter.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/github_authority_resident.mjs", import.meta.url), "utf8"),
    loadConfig(),
  ]);
  assert.match(runtimeSource, /import \{ runOnce, validateLease, watcherRunning \} from "\.\/github_authority_resident\.mjs"/);
  assert.match(runtimeSource, /await runOnce\(\{/);
  assert.match(coreSource, /export async function runOnce/);
  assert.equal(config.artifact_mapping.semantic_core_blob, "1a0c818321e64ec3dd4619e563d6845124af7c2b");
  assert.doesNotMatch(`${runtimeSource}\n${adapterSource}`, /node:child_process|@herdr|herdr\.(?:agent|pane|send|run)|browser\.(?:send|click|evaluate)|playwright|puppeteer|chrome-remote-interface|ScheduledTask|taskschd|execFile|execSync|spawn\(/i);
});

const G33_CONTROL_ID = "6abd98f5-5808-83e8-852c-f01a16cebf24";
const G33_START_ID = "5981752154";
const G33_REGISTRY_ID = "5981755651";
const PRODUCER_USER = { id: 55701413, login: "D22977" };

function generation033V244V140Comments(policyRaw = "[]") {
  const previous = generation033AuthorityComments();
  return [
    issueComment(G33_START_ID, 43, [
      "CURRENT_REHYDRATION_INDEX_V244",
      "state: CURRENT_START_HERE_ACTIVE_CONTROL033_PRODUCER_ADMISSION_CARD_ACTIVE",
      "recorded_by_role: ACTIVE_CONTROL",
      "repository: D22977/gpt-browser-bridge",
      "control_generation: 033 ACTIVE",
      "supersedes: #43/5921589118 V243",
      "active_control_ack: #88/5921541952",
      "atomic_switch: #88/5921509976",
      "owner_continuation: #43/5921003901",
      "old_evidence_card: #162/5921584474 TERMINAL_DO_NOT_REDISPATCH",
      "old_evidence_start: #162/5921662604 CONSUMED_STARTED",
      "old_evidence_terminal: #162/5921688277 BLOCKED",
      "task_metadata_terminal: #162/5921746707 READY_FOR_CONTROL",
      "parser_candidate: #162/5981411959 / head 5ff358278fd24c6502e172c37cbeffadf1657d95 / tree afa2ed3d8e965f338c3d49f0dee9d631237ad67c",
      "producer_admission_adjudication: #162/5981736759",
      "current_worker_card: #162/5981746195",
      "operational_goal_complete: false",
      "runtime_activation: NOT_AUTHORIZED",
      "generation033_lease: NONE",
      "matching_fresh_heartbeat: NONE",
      "watcher_running: false",
      "monitoring_claimed: false",
      "merge_release_deploy_workflow_dispatch: false",
      "next_action: bind one fresh Worker for the producer admission contract",
      "user_relay_count: 0",
      "readback_required: true",
      "idempotency_key: CURRENT-REHYDRATION-INDEX-033-V244-PRODUCER-ADMISSION-20261004-01",
    ].join("\n")),
    issueComment(G33_REGISTRY_ID, 81, [
      "CURRENT_REGISTRY_INDEX_V140",
      "state: CURRENT_ACTIVE_CONTROL033_PRODUCER_ADMISSION_CARD_ACTIVE",
      "recorded_by_role: ACTIVE_CONTROL",
      "repository: D22977/gpt-browser-bridge",
      "control_generation: 033 ACTIVE",
      "supersedes: #81/5921593188 V139",
      `current_start: #43/${G33_START_ID} V244 exact GET matched`,
      `active_control_id: ${G33_CONTROL_ID}`,
      "active_control_ack: #88/5921541952",
      "atomic_switch: #88/5921509976",
      "GitHub_sole_durable_semantic_authority: true",
      "owner_continuation: #43/5921003901",
      "restoration_goal_complete: false",
      "old_evidence_card: #162/5921584474 TERMINAL_DO_NOT_REDISPATCH",
      "old_evidence_terminal: #162/5921688277 BLOCKED",
      "task_metadata_terminal: #162/5921746707 READY_FOR_CONTROL",
      "parser_candidate_head: 5ff358278fd24c6502e172c37cbeffadf1657d95",
      "parser_candidate_tree: afa2ed3d8e965f338c3d49f0dee9d631237ad67c",
      "producer_admission_adjudication: #162/5981736759",
      "current_worker_card: #162/5981746195",
      `producer_admission_policy: ${policyRaw}`,
      "runtime_activation: NOT_AUTHORIZED",
      "generation033_lease: NONE",
      "matching_fresh_heartbeat: NONE",
      "watcher_running: false",
      "monitoring_claimed: false",
      "merge_release_deploy_workflow_dispatch: false",
      "next_action: use only the exact current producer admission policy",
      "user_relay_count: 0",
      "readback_required: true",
      "idempotency_key: CURRENT-REGISTRY-033-V140-PRODUCER-ADMISSION-20261004-01",
    ].join("\n")),
    previous.find((row) => row.id === "5921541952"),
    previous.find((row) => row.id === "5921509976"),
  ];
}

function v2EventBody({
  sourceRepo = "D22977/gpt-browser-bridge",
  sourceIssue = 162,
  originCommentId = "16290",
  registryId = G33_REGISTRY_ID,
  sourceEventType = "PROGRESS",
  controlGeneration = "033",
  activeControlConversationId = G33_CONTROL_ID,
  namedExecutor,
  extraFields = [],
} = {}) {
  const lines = [
    "GITHUB_SOURCE_EVENT_V2",
    `source_repo: ${sourceRepo}`,
    `source_issue: ${sourceIssue}`,
    `origin_comment_id: ${originCommentId}`,
    `producer_admission_registry_id: ${registryId}`,
    `source_event_type: ${sourceEventType}`,
    `control_generation: ${controlGeneration}`,
    `active_control_conversation_id: ${activeControlConversationId}`,
  ];
  if (namedExecutor !== undefined) lines.push(`named_executor: ${namedExecutor}`);
  return [...lines, ...extraFields].join("\n");
}

function producerAdmissionCase(options = {}) {
  const originId = options.originId ?? "16290";
  const sourceEventType = options.sourceEventType ?? "PROGRESS";
  const eventType = options.eventType ?? sourceEventType;
  const eventExecutor = Object.hasOwn(options, "eventExecutor")
    ? options.eventExecutor
    : eventType === "PROGRESS" ? undefined : "executor-1";
  const originBody = options.originBody ?? "synthetic producer origin\nbody";
  const grantUser = options.grantUser ?? PRODUCER_USER;
  const eventUser = options.eventUser ?? PRODUCER_USER;
  const originUser = options.originUser ?? PRODUCER_USER;
  const grant = {
    origin_comment_id: originId,
    origin_body_sha256: options.grantHash ?? createHash("sha256").update(originBody, "utf8").digest("hex"),
    source_event_type: options.grantEventType ?? sourceEventType,
    producer_github_user_id: String(options.grantUserId ?? grantUser.id),
    producer_github_login: options.grantLogin ?? grantUser.login,
  };
  const grantExecutor = options.grantExecutor;
  if (grantExecutor !== undefined) grant.named_executor = grantExecutor;
  else if (["TERMINAL", "CONTROL_NEEDED"].includes(grant.source_event_type) && options.includeGrantExecutor !== false) grant.named_executor = "executor-1";
  const origin = issueComment(
    originId,
    options.originIssue ?? 162,
    originBody,
    options.originRepo ?? "D22977/gpt-browser-bridge",
    originUser,
  );
  const event = issueComment(
    options.eventId ?? "16291",
    options.eventEnvelopeIssue ?? 162,
    v2EventBody({
      sourceRepo: options.sourceRepo,
      sourceIssue: options.sourceIssue,
      originCommentId: originId,
      registryId: options.registryId,
      sourceEventType: eventType,
      controlGeneration: options.controlGeneration,
      activeControlConversationId: options.activeControlConversationId,
      namedExecutor: eventExecutor,
      extraFields: options.extraFields,
    }),
    options.eventRepo ?? "D22977/gpt-browser-bridge",
    eventUser,
  );
  return { grant, origin, event, originBody };
}

async function makeV244Adapter({ policyRaw, sourceComments = [], fetchOverride } = {}) {
  const config = await loadConfig();
  const policy = policyRaw ?? "[]";
  const backend = fakeGitHub({ comments: [...generation033V244V140Comments(policy), ...sourceComments] });
  const fetchImpl = fetchOverride ? fetchOverride(backend.fetchImpl) : backend.fetchImpl;
  const writes = { count: 0 };
  const adapter = makeAdapter(config, {
    fetchImpl,
    publisher: async ({ issue, body }) => {
      writes.count += 1;
      return backend.add(issue, body);
    },
  });
  return { config, backend, writes, adapter };
}

test("T34 exact V244/V140 chain normalizes generation, identity, and current envelope IDs", async () => {
  const { adapter } = await makeV244Adapter();
  const snapshot = await adapter.readAuthoritySnapshot();
  assert.deepEqual([
    snapshot.control.control_generation,
    snapshot.control.active_control_conversation_id,
    snapshot.control.github_comment_id,
    snapshot.registry.github_comment_id,
    snapshot.switch.github_comment_id,
  ], ["033", G33_CONTROL_ID, G33_START_ID, G33_REGISTRY_ID, "5921509976"]);
  assert.deepEqual(snapshot.registry.producer_admission_policy, []);
  assert.equal(snapshot.registry.producer_admission_registry_id, G33_REGISTRY_ID);
});

test("T35 V140 producer policy is a strict closed array with unique, well-formed grants", async (t) => {
  const validCase = producerAdmissionCase();
  const grant = JSON.stringify(validCase.grant);
  const invalidPolicies = [
    ["malformed JSON", "not-json"],
    ["not an array", JSON.stringify(validCase.grant)],
    ["unknown grant key", `[${grant.slice(0, -1)},"wildcard":"*"}]`],
    ["duplicate grant key", `[{"origin_comment_id":"16290","origin_comment_id":"16290","origin_body_sha256":"${validCase.grant.origin_body_sha256}","source_event_type":"PROGRESS","producer_github_user_id":"55701413","producer_github_login":"D22977"}]`],
    ["malformed origin id", `[${JSON.stringify({ ...validCase.grant, origin_comment_id: "0" })}]`],
    ["malformed body hash", `[${JSON.stringify({ ...validCase.grant, origin_body_sha256: "A".repeat(64) })}]`],
    ["duplicate origin and event type", `[${grant},${grant}]`],
    ["progress grant forbids named executor", `[${JSON.stringify({ ...validCase.grant, named_executor: "executor-1" })}]`],
    ["terminal grant requires named executor", `[${JSON.stringify({ ...validCase.grant, source_event_type: "TERMINAL" })}]`],
  ];
  for (const [name, policyRaw] of invalidPolicies) {
    await t.test(name, async () => {
      const { adapter } = await makeV244Adapter({ policyRaw });
      await assert.rejects(adapter.readAuthoritySnapshot(), /AUTHORITY_CONFLICT_OR_MALFORMED/);
    });
  }
});

test("T36 V140 empty policy admits no V2 event and malformed admission has zero write or transport effects", async () => {
  const fixture = producerAdmissionCase();
  const { config, adapter, backend, writes } = await makeV244Adapter({ sourceComments: [fixture.origin, fixture.event] });
  let sends = 0;
  const snapshot = await adapter.readAuthoritySnapshot();
  const triggerHash = runtime.getTriggerContractHash(config);
  const now = "2026-10-04T16:30:00.000Z";
  const lease = {
    ...createLease({
      resident_instance_id: "resident-test",
      control_generation: snapshot.control.control_generation,
      active_control_conversation_id: snapshot.control.active_control_conversation_id,
      trigger_contract_hash: triggerHash,
      acquired_at: "2026-10-04T16:00:00.000Z",
      expires_at: "2026-10-04T17:00:00.000Z",
      watched_issue_set: ["D22977/gpt-browser-bridge#162"],
    }),
    github_comment_id: "9001",
  };
  const heartbeat = createHeartbeat({
    lease_id: lease.lease_id,
    resident_instance_id: "resident-test",
    control_generation: snapshot.control.control_generation,
    trigger_contract_hash: triggerHash,
    observed_at: "2026-10-04T16:29:59.000Z",
    lease_expires_at: lease.expires_at,
    last_processed_comment_id: "16289",
  });
  const github = {
    readAuthoritySnapshot: () => adapter.readAuthoritySnapshot(),
    async listReceipts() { return [lease]; },
    async listSourceEvents() { return adapter.listSourceEvents(); },
    async readHeartbeat() { return heartbeat; },
    getReceipt: (id) => adapter.getReceipt(id),
    publishReceipt: (receipt) => adapter.publishReceipt(receipt),
  };
  const controller = runtime.createControlDoorbellRuntime({
    config,
    github,
    residentInstanceId: "resident-test",
    now: () => now,
    sendPointer: async () => { sends += 1; return "unexpected"; },
  });
  assert.deepEqual(await controller.poll(), { state: "CONTROL_REQUIRED/NO_SEND" });
  assert.equal(writes.count, 0);
  assert.equal(sends, 0);
  assert.equal(backend.calls.every((call) => call.method === "GET"), true);
});

test("T37 V2 rejects source_comment_id and github_comment_id body fields", async (t) => {
  for (const field of ["source_comment_id: 16291", "github_comment_id: 16291"]) {
    await t.test(field, async () => {
      const fixture = producerAdmissionCase({ extraFields: [field] });
      const { adapter } = await makeV244Adapter({ policyRaw: JSON.stringify([fixture.grant]), sourceComments: [fixture.origin, fixture.event] });
      await assert.rejects(adapter.listSourceEvents(), /AUTHORITY_CONFLICT_OR_MALFORMED/);
    });
  }
});

test("T38 V2 normalized source ID comes only from its GitHub envelope", async () => {
  const fixture = producerAdmissionCase({ eventId: "17001" });
  const { adapter } = await makeV244Adapter({ policyRaw: JSON.stringify([fixture.grant]), sourceComments: [fixture.origin, fixture.event] });
  const events = await adapter.listSourceEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].source_comment_id, "17001");
  assert.equal(events[0].github_comment_id, "17001");
  assert.equal(events[0].origin_comment_id, fixture.origin.id);
});

test("T39 V2 must name the actual current V140 envelope ID, never V139", async (t) => {
  for (const registryId of ["5921593188", "5981755650"]) {
    await t.test(registryId, async () => {
      const fixture = producerAdmissionCase({ registryId });
      const { adapter } = await makeV244Adapter({ policyRaw: JSON.stringify([fixture.grant]), sourceComments: [fixture.origin, fixture.event] });
      await assert.rejects(adapter.listSourceEvents(), /AUTHORITY_CONFLICT_OR_MALFORMED/);
    });
  }
});

test("T40 origin body SHA-256 is computed over the exact UTF-8 comment body", async () => {
  const fixture = producerAdmissionCase({ grantHash: "0".repeat(64) });
  const { adapter } = await makeV244Adapter({ policyRaw: JSON.stringify([fixture.grant]), sourceComments: [fixture.origin, fixture.event] });
  await assert.rejects(adapter.listSourceEvents(), /AUTHORITY_CONFLICT_OR_MALFORMED/);
});

test("T41 event and origin GitHub user IDs and logins must match the selected grant", async (t) => {
  const cases = [
    ["event user ID mismatch", { eventUser: { id: 55701414, login: "D22977" } }],
    ["event login mismatch", { eventUser: { id: 55701413, login: "other" } }],
    ["origin user ID mismatch", { originUser: { id: 55701414, login: "D22977" } }],
    ["origin login mismatch", { originUser: { id: 55701413, login: "other" } }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const fixture = producerAdmissionCase(options);
      const { adapter } = await makeV244Adapter({ policyRaw: JSON.stringify([fixture.grant]), sourceComments: [fixture.origin, fixture.event] });
      await assert.rejects(adapter.listSourceEvents(), /AUTHORITY_CONFLICT_OR_MALFORMED/);
    });
  }
});

test("T42 event and origin repository and issue provenance must match configuration", async (t) => {
  const cases = [
    ["event body repo", { sourceRepo: "D22977/other" }],
    ["event body issue", { sourceIssue: 163 }],
    ["event envelope repo", { eventRepo: "D22977/other" }],
    ["event exact envelope issue", { exactEventIssue: 163 }],
    ["origin envelope issue", { originIssue: 163 }],
    ["origin envelope repo", { originRepo: "D22977/other" }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const fixture = producerAdmissionCase(options);
      const fetchOverride = options.exactEventIssue === undefined ? undefined : (fetchImpl) => async (url, request) => {
        const response = await fetchImpl(url, request);
        if (url.endsWith(`/issues/comments/${fixture.event.id}`)) {
          const body = await response.json();
          return jsonResponse({ ...body, issue_url: `https://api.github.com/repos/D22977/gpt-browser-bridge/issues/${options.exactEventIssue}` });
        }
        return response;
      };
      const { adapter } = await makeV244Adapter({
        policyRaw: JSON.stringify([fixture.grant]),
        sourceComments: [fixture.origin, fixture.event],
        fetchOverride,
      });
      await assert.rejects(adapter.listSourceEvents(), /AUTHORITY_CONFLICT_OR_MALFORMED/);
    });
  }
});

test("T43 V2 authority identity, event type, and named executor must match", async (t) => {
  const cases = [
    ["wrong generation", { controlGeneration: "032" }],
    ["wrong Control identity", { activeControlConversationId: "old-control" }],
    ["grant and event type mismatch", { grantEventType: "PROGRESS", eventType: "TERMINAL" }],
    ["terminal executor mismatch", { sourceEventType: "TERMINAL", eventExecutor: "other-executor" }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const fixture = producerAdmissionCase(options);
      const { adapter } = await makeV244Adapter({ policyRaw: JSON.stringify([fixture.grant]), sourceComments: [fixture.origin, fixture.event] });
      await assert.rejects(adapter.listSourceEvents(), /AUTHORITY_CONFLICT_OR_MALFORMED/);
    });
  }
});

test("T44 duplicate V2 origin/type/generation/identity tuples fail closed", async () => {
  const first = producerAdmissionCase({ eventId: "17011" });
  const second = producerAdmissionCase({ eventId: "17012" });
  const { adapter } = await makeV244Adapter({
    policyRaw: JSON.stringify([first.grant]),
    sourceComments: [first.origin, first.event, second.event],
  });
  await assert.rejects(adapter.listSourceEvents(), /AUTHORITY_CONFLICT_OR_MALFORMED/);
});

test("T45 valid synthetic PROGRESS grant admits the exact V2 envelope without named_executor", async () => {
  const fixture = producerAdmissionCase();
  const { adapter } = await makeV244Adapter({ policyRaw: JSON.stringify([fixture.grant]), sourceComments: [fixture.origin, fixture.event] });
  const events = await adapter.listSourceEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].source_event_type, "PROGRESS");
  assert.equal("named_executor" in events[0], false);
});

test("T46 TERMINAL and CONTROL_NEEDED grants require the exact named_executor", async (t) => {
  for (const sourceEventType of ["TERMINAL", "CONTROL_NEEDED"]) {
    await t.test(sourceEventType, async (t2) => {
      const valid = producerAdmissionCase({ sourceEventType, grantExecutor: "executor-1", eventExecutor: "executor-1" });
      const { adapter: validAdapter } = await makeV244Adapter({ policyRaw: JSON.stringify([valid.grant]), sourceComments: [valid.origin, valid.event] });
      assert.equal((await validAdapter.listSourceEvents())[0].named_executor, "executor-1");
      for (const [name, options] of [
        ["missing event executor", { sourceEventType, grantExecutor: "executor-1", eventExecutor: undefined }],
        ["wrong event executor", { sourceEventType, grantExecutor: "executor-1", eventExecutor: "other" }],
        ["missing grant executor", { sourceEventType, includeGrantExecutor: false, eventExecutor: "executor-1" }],
      ]) {
        await t2.test(name, async () => {
          const fixture = producerAdmissionCase(options);
          const { adapter } = await makeV244Adapter({ policyRaw: JSON.stringify([fixture.grant]), sourceComments: [fixture.origin, fixture.event] });
          await assert.rejects(adapter.listSourceEvents(), /AUTHORITY_CONFLICT_OR_MALFORMED/);
        });
      }
    });
  }
});

test("T47 V1 historical source events are never admitted by the V140 policy", async () => {
  const fixture = producerAdmissionCase();
  const v1 = issueComment("17021", 162, [
    "GITHUB_SOURCE_EVENT_V1",
    "source_repo: D22977/gpt-browser-bridge",
    "source_issue: 162",
    `source_comment_id: ${fixture.origin.id}`,
    "source_event_type: PROGRESS",
    "control_generation: 033",
    `active_control_conversation_id: ${G33_CONTROL_ID}`,
  ].join("\n"));
  const { adapter } = await makeV244Adapter({ policyRaw: JSON.stringify([fixture.grant]), sourceComments: [fixture.origin, v1] });
  const events = await adapter.listSourceEvents();
  assert.deepEqual(events, []);
});

test("T48 V244 and V140 must be recognized as a matched current-index pair", async () => {
  const comments = generation033V244V140Comments();
  const start = comments.find((row) => row.id === G33_START_ID);
  start.body = start.body.replace("CURRENT_REHYDRATION_INDEX_V244", "CURRENT_REHYDRATION_INDEX_V243");
  const backend = fakeGitHub({ comments });
  const mismatched = makeAdapter(await loadConfig(), { fetchImpl: backend.fetchImpl });
  await assert.rejects(mismatched.readAuthoritySnapshot(), /AUTHORITY_CONFLICT_OR_MALFORMED/);
});

async function assertSplitEnvelopeProducerMismatchFailsClosed(exactEventUser) {
  const fixture = producerAdmissionCase();
  const fetchOverride = (fetchImpl) => async (url, request) => {
    const response = await fetchImpl(url, request);
    if (url.endsWith(`/issues/comments/${fixture.event.id}`)) {
      return jsonResponse({ ...(await response.json()), user: exactEventUser });
    }
    return response;
  };
  const { config, adapter, backend, writes } = await makeV244Adapter({
    policyRaw: JSON.stringify([fixture.grant]),
    sourceComments: [fixture.origin, fixture.event],
    fetchOverride,
  });

  await assert.rejects(adapter.listSourceEvents(), /AUTHORITY_CONFLICT_OR_MALFORMED/);

  const snapshot = await adapter.readAuthoritySnapshot();
  const triggerHash = runtime.getTriggerContractHash(config);
  const now = "2026-10-04T16:30:00.000Z";
  const lease = {
    ...createLease({
      resident_instance_id: "resident-test",
      control_generation: snapshot.control.control_generation,
      active_control_conversation_id: snapshot.control.active_control_conversation_id,
      trigger_contract_hash: triggerHash,
      acquired_at: "2026-10-04T16:00:00.000Z",
      expires_at: "2026-10-04T17:00:00.000Z",
      watched_issue_set: ["D22977/gpt-browser-bridge#162"],
    }),
    github_comment_id: "9001",
  };
  const heartbeat = createHeartbeat({
    lease_id: lease.lease_id,
    resident_instance_id: "resident-test",
    control_generation: snapshot.control.control_generation,
    trigger_contract_hash: triggerHash,
    observed_at: "2026-10-04T16:29:59.000Z",
    lease_expires_at: lease.expires_at,
    last_processed_comment_id: "16289",
  });
  const github = {
    readAuthoritySnapshot: () => adapter.readAuthoritySnapshot(),
    async listReceipts() { return [lease]; },
    async listSourceEvents() { return adapter.listSourceEvents(); },
    async readHeartbeat() { return heartbeat; },
    getReceipt: (id) => adapter.getReceipt(id),
    publishReceipt: (receipt) => adapter.publishReceipt(receipt),
  };
  let sends = 0;
  const controller = runtime.createControlDoorbellRuntime({
    config,
    github,
    residentInstanceId: "resident-test",
    now: () => now,
    sendPointer: async () => { sends += 1; return "unexpected"; },
  });

  assert.deepEqual(await controller.poll(), { state: "CONTROL_REQUIRED/NO_SEND" });
  assert.equal(writes.count, 0);
  assert.equal(sends, 0);
  assert.equal(backend.calls.every((call) => call.method === "GET"), true);
}

test("T49 F001-A exact event GET user.id mismatch fails closed with zero runtime effects", async () => {
  await assertSplitEnvelopeProducerMismatchFailsClosed({ id: 55701414, login: "D22977" });
});

test("T50 F001-B exact event GET login mismatch fails closed with zero runtime effects", async () => {
  await assertSplitEnvelopeProducerMismatchFailsClosed({ id: 55701413, login: "other" });
});

test("T51 exact event GET producer identity survives a mismatching listed row", async () => {
  const fixture = producerAdmissionCase();
  const listedUser = { id: 55701414, login: "other" };
  const fetchOverride = (fetchImpl) => async (url, request) => {
    const response = await fetchImpl(url, request);
    if (new URL(url).pathname.endsWith("/issues/162/comments")) {
      const comments = await response.json();
      return jsonResponse(comments.map((comment) => String(comment.id) === String(fixture.event.id)
        ? { ...comment, user: listedUser }
        : comment));
    }
    return response;
  };
  const { adapter } = await makeV244Adapter({
    policyRaw: JSON.stringify([fixture.grant]),
    sourceComments: [fixture.origin, fixture.event],
    fetchOverride,
  });

  const events = await adapter.listSourceEvents();

  assert.equal(events.length, 1);
  assert.equal(events[0].producer_github_user_id, fixture.grant.producer_github_user_id);
  assert.equal(events[0].producer_github_login, fixture.grant.producer_github_login);
});
