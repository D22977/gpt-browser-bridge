import test from "node:test";
import assert from "node:assert/strict";
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
    semantic_core_source: "src/github_authority_resident.mjs",
    semantic_core_runtime: "D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/github_authority_resident.mjs",
    semantic_core_blob: "1a0c818321e64ec3dd4619e563d6845124af7c2b",
  });
});

test("T20 tests exercise only in-memory adapters and never invoke runtime side effects", async () => {
  const source = await readFile(new URL("../src/control_doorbell_runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|playwright|ScheduledTask|run\.ps1|execFile|https:\/\/api\.github\.com/);
});

function issueComment(id, issue, body, repository = "D22977/gpt-browser-bridge") {
  return { id, issue_url: `https://api.github.com/repos/${repository}/issues/${issue}`, body };
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
