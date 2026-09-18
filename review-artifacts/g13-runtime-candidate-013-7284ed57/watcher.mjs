import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "config.json");
const STATE_PATH = path.join(ROOT, "state.json");
const REPO = "D22977/gpt-browser-bridge";
const ISSUE = 162;
const GENERATION = "013";
const EVENT_MARKER = "GBB_G13_BIDIRECTIONAL_WAKE_EVENT_V1";
const RECEIPT_MARKER = "GBB_G13_BIDIRECTIONAL_WAKE_RECEIPT_V1";
const STATES = ["SEEN", "CLAIMED", "SEND_ATTEMPTED", "DELIVERED", "CONSUMED"];
const TERMINAL_NO_RETRY = "UNCERTAIN_SEND";
const NO_SEND = "CONTROL_REQUIRED_NO_SEND";
const AUTHORITY_MARKERS = {
  controlSwitch: "CONTROL_GENERATION_SWITCH_V1",
  start: "CURRENT_REHYDRATION_INDEX_V117",
  registry: "CURRENT_REGISTRY_INDEX_V19"
};

function slash(value) {
  return String(value).replaceAll("\\", "/");
}

function nowIso() {
  return new Date().toISOString();
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value);
}

function parseFields(body) {
  const lines = String(body || "").replaceAll("\r", "").split("\n");
  const marker = (lines.shift() || "").trim();
  const fields = Object.create(null);
  const duplicates = [];
  for (const line of lines) {
    const text = line.trim();
    const match = /^([A-Za-z][A-Za-z0-9_]*)(?:=|:\s*)(.*)$/.exec(text);
    if (!match) continue;
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(fields, key)) duplicates.push(key);
    fields[key] = match[2].trim();
  }
  return { marker, fields, duplicates };
}

function parseDurableComment(comment) {
  const parsed = parseFields(comment.body);
  if (parsed.marker !== EVENT_MARKER && parsed.marker !== RECEIPT_MARKER) return null;
  return {
    marker: parsed.marker,
    fields: parsed.fields,
    duplicates: parsed.duplicates,
    comment_id: String(comment.id),
    created_at: comment.created_at || null
  };
}

function requiredFields(fields, names) {
  return names.every((name) => nonEmpty(fields[name]));
}

function targetRoleFor(direction) {
  return direction === "A" ? "HERDR" : direction === "B" ? "CONTROL" : null;
}

function validateEvent(event, authority, targets) {
  const fields = event.fields || event;
  const required = [
    "logical_event_id",
    "issue",
    "card_or_authority_comment",
    "control_generation",
    "active_control_conversation_id",
    "direction",
    "requested_action",
    "wake_at_if_any",
    "exact_target_role",
    "idempotency_key"
  ];
  if (event.duplicates?.length || !requiredFields(fields, required)) return { ok: false, reason: NO_SEND };
  if (fields.issue !== String(ISSUE) || fields.control_generation !== authority.generation) {
    return { ok: false, reason: NO_SEND };
  }
  if (fields.active_control_conversation_id !== authority.conversationId) {
    return { ok: false, reason: NO_SEND };
  }
  const expectedRole = targetRoleFor(fields.direction);
  if (!expectedRole || fields.exact_target_role !== expectedRole) {
    return { ok: false, reason: NO_SEND };
  }
  if (!/^[0-9]+$/.test(fields.card_or_authority_comment)) return { ok: false, reason: NO_SEND };
  if (fields.target_count && fields.target_count !== "1") return { ok: false, reason: NO_SEND };
  const matchingTargets = (targets || []).filter((target) => target.role === expectedRole);
  if (matchingTargets.length !== 1) return { ok: false, reason: NO_SEND };
  const target = matchingTargets[0];
  if (fields.target_id && fields.target_id !== target.id) return { ok: false, reason: NO_SEND };
  return { ok: true, target };
}

function validateReceipt(receipt, authority, existing) {
  const fields = receipt.fields || receipt;
  const required = [
    "logical_event_id",
    "receipt_state",
    "control_generation",
    "active_control_conversation_id",
    "exact_target_role",
    "target_id"
  ];
  if (receipt.duplicates?.length || !requiredFields(fields, required)) return { ok: false, reason: NO_SEND };
  if (!["SEND_ATTEMPTED", "DELIVERED", "CONSUMED"].includes(fields.receipt_state)) {
    return { ok: false, reason: NO_SEND };
  }
  if (fields.control_generation !== authority.generation ||
      fields.active_control_conversation_id !== authority.conversationId) {
    return { ok: false, reason: NO_SEND };
  }
  if (!existing || existing.target_role !== fields.exact_target_role || existing.target_id !== fields.target_id) {
    return { ok: false, reason: NO_SEND };
  }
  return { ok: true };
}

function duplicateRecord(records, event) {
  return Object.values(records || {}).find((record) =>
    record.logical_event_id === event.logical_event_id ||
    record.idempotency_key === event.idempotency_key
  );
}

function reconcileEvent(event, records, authority, targets, timestamp = nowIso()) {
  const duplicate = duplicateRecord(records, event);
  if (duplicate) return { outcome: "NO_OP_DUPLICATE", record: duplicate };
  const checked = validateEvent(event, authority, targets);
  const fields = event.fields || event;
  const record = {
    logical_event_id: fields.logical_event_id,
    idempotency_key: fields.idempotency_key,
    direction: fields.direction,
    requested_action: fields.requested_action,
    exact_target_role: fields.exact_target_role,
    target_role: fields.exact_target_role,
    target_id: checked.target?.id || fields.target_id || null,
    source_comment_id: event.comment_id || null,
    state: "SEEN",
    decision: checked.ok ? "CLAIMED" : checked.reason,
    reason: checked.ok ? null : checked.reason,
    physical_send_authorized: false,
    seen_at: timestamp,
    updated_at: timestamp
  };
  if (checked.ok) record.state = "CLAIMED";
  return { outcome: checked.ok ? "CLAIMED" : checked.reason, record };
}

function reconcileReceipt(receipt, existing, timestamp = nowIso()) {
  const fields = receipt.fields || receipt;
  const receiptState = fields.receipt_state || fields.state;
  if (!existing) {
    return {
      state: TERMINAL_NO_RETRY,
      decision: "NO_BLIND_RETRY",
      reason: "RECEIPT_WITHOUT_CLAIM",
      updated_at: timestamp
    };
  }
  if (receiptState === "SEND_ATTEMPTED") {
    return {
      ...existing,
      state: TERMINAL_NO_RETRY,
      decision: "NO_BLIND_RETRY",
      reason: "SEND_ATTEMPTED_WITHOUT_INDEPENDENT_DELIVERY",
      updated_at: timestamp
    };
  }
  if (receiptState === "DELIVERED" &&
      ["SEND_ATTEMPTED", TERMINAL_NO_RETRY].includes(existing.state)) {
    return { ...existing, state: "DELIVERED", decision: "WAIT_CONSUMED_ACK", reason: null, updated_at: timestamp };
  }
  if (receiptState === "CONSUMED" && existing.state === "DELIVERED") {
    return { ...existing, state: "CONSUMED", decision: "CONSUMED", reason: null, updated_at: timestamp };
  }
  return { ...existing, state: existing.state, decision: NO_SEND, reason: "INVALID_RECEIPT_ORDER", updated_at: timestamp };
}

function mergeReceipt(records, receipt, authority, timestamp = nowIso()) {
  const fields = receipt.fields || receipt;
  const key = fields.logical_event_id;
  const existing = records[key];
  const checked = validateReceipt(receipt, authority, existing);
  if (!checked.ok) {
    return { outcome: checked.reason, record: existing || null };
  }
  const next = reconcileReceipt(receipt, existing, timestamp);
  return { outcome: next.decision, record: next };
}

function parseAuthorityComment(comment, marker) {
  const parsed = parseFields(comment.body);
  if (parsed.marker !== marker || parsed.duplicates.length) return null;
  return {
    id: String(comment.id),
    fields: parsed.fields,
    created_at: comment.created_at || null
  };
}

function latestAuthority(comments, marker, required) {
  const valid = comments
    .map((comment) => parseAuthorityComment(comment, marker))
    .filter((comment) => comment && requiredFields(comment.fields, required))
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (!valid.length) throw new Error(NO_SEND);
  return valid[valid.length - 1];
}

function deriveAuthority(switchComments, startComments, registryComments) {
  const controlSwitch = latestAuthority(
    switchComments,
    AUTHORITY_MARKERS.controlSwitch,
    ["new_generation", "new_conversation_id", "new_status"]
  );
  const start = latestAuthority(
    startComments,
    AUTHORITY_MARKERS.start,
    ["control_generation", "control_conversation_id", "control_status"]
  );
  const registry = latestAuthority(
    registryComments,
    AUTHORITY_MARKERS.registry,
    ["control_generation", "control_conversation_id"]
  );
  const generations = [
    controlSwitch.fields.new_generation,
    start.fields.control_generation,
    registry.fields.control_generation
  ];
  const conversations = [
    controlSwitch.fields.new_conversation_id,
    start.fields.control_conversation_id,
    registry.fields.control_conversation_id
  ];
  if (new Set(generations).size !== 1 ||
      new Set(conversations).size !== 1 ||
      generations[0] !== GENERATION ||
      controlSwitch.fields.new_status !== "ACTIVE" ||
      start.fields.control_status !== "ACTIVE") {
    throw new Error(NO_SEND);
  }
  return {
    generation: generations[0],
    conversationId: conversations[0],
    comment_ids: {
      control_switch: controlSwitch.id,
      start: start.id,
      registry: registry.id
    }
  };
}

function unwrapHerdr(value) {
  if (value && value.result) return value.result;
  return value;
}

function spawnJson(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || "READ_ONLY_COMMAND_FAILED"));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("READ_ONLY_COMMAND_NOT_JSON"));
      }
    });
  });
}

async function githubGet(endpoint) {
  return spawnJson("gh.exe", [
    "api",
    endpoint,
    "--method",
    "GET",
    "--header",
    "Accept: application/vnd.github+json"
  ]);
}

async function fetchIssueComments(issue) {
  const comments = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await githubGet(
      "repos/" + REPO + "/issues/" + issue + "/comments?per_page=100&page=" + page
    );
    if (!Array.isArray(result)) throw new Error("GITHUB_GET_INVALID_COMMENTS");
    comments.push(...result);
    if (result.length < 100) return comments;
  }
  throw new Error("GITHUB_GET_PAGE_BOUND");
}

async function readCurrentAuthority() {
  const [switchComments, startComments, registryComments] = await Promise.all([
    fetchIssueComments(88),
    fetchIssueComments(43),
    fetchIssueComments(81)
  ]);
  return deriveAuthority(switchComments, startComments, registryComments);
}

async function readHerdrTargets(config) {
  const executable = config.herdr.executable;
  const workspace = config.herdr.workspace;
  const [agentPayload, panePayload] = await Promise.all([
    spawnJson(executable, ["agent", "list"]),
    spawnJson(executable, ["pane", "list", "--workspace", workspace])
  ]);
  const agents = unwrapHerdr(agentPayload).agents || [];
  const panes = unwrapHerdr(panePayload).panes || [];
  const byPane = new Map(agents.map((agent) => [agent.pane_id, agent]));
  return panes
    .map((pane) => ({ ...byPane.get(pane.pane_id), ...pane }))
    .filter((pane) =>
      pane.agent === "codex" &&
      pane.agent_status === "working" &&
      slash(pane.cwd).toLowerCase() === "c:/windows/system32"
    )
    .map((pane) => ({
      role: "HERDR",
      id: pane.pane_id,
      session: pane.agent_session?.value || null,
      cwd: pane.cwd
    }));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJsonAtomically(file, value) {
  const temporary = file + "." + process.pid + ".tmp";
  const handle = await fs.open(temporary, "w");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
}

function assertConfig(config) {
  const expectedFiles = ["watcher.mjs", "config.json", "state.json", "run.ps1"];
  assert.equal(config.schema, "CONTROL_DOORBELL_G13_CONFIG_V1");
  assert.equal(slash(config.runtime_root), slash(ROOT));
  assert.deepEqual(config.allowed_existing_files, expectedFiles);
  assert.equal(config.repo, REPO);
  assert.equal(String(config.issue), String(ISSUE));
  assert.equal(config.github_read_only, true);
  assert.equal(config.transport.physical_send, false);
  assert.equal(config.transport.browser_send, false);
  assert.equal(config.transport.process_mutation, false);
  assert.equal(config.herdr.required_version, "0.8.2");
  assert.equal(config.task.name, "GBB_TEMP_CONTROL_DOORBELL");
  assert.equal(config.task.desired_static_definition.action_path, slash(ROOT + "/run.ps1"));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claimLease(state, timestamp) {
  // ponytail: state-file lease is the only allowed singleton guard; a second lock file is out of scope.
  const identity = {
    owner_id: os.hostname() + ":" + process.pid,
    host: os.hostname(),
    pid: process.pid
  };
  const previous = state.lease;
  if (previous && previous.owner_id !== identity.owner_id &&
      processIsAlive(previous.pid) && previous.expires_at > timestamp) {
    throw new Error("CONTROL_REQUIRED_SINGLE_INSTANCE");
  }
  state.lease = {
    ...identity,
    acquired_at: previous?.owner_id === identity.owner_id ? previous.acquired_at : timestamp,
    expires_at: new Date(Date.parse(timestamp) + 120000).toISOString()
  };
  return identity;
}

function heartbeat(state, authority, identity, timestamp, records) {
  const entries = Object.values(records);
  const last = (name) => {
    const matching = entries.filter((record) => record.state === name).sort((a, b) =>
      String(a.updated_at).localeCompare(String(b.updated_at))
    );
    return matching.at(-1)?.logical_event_id || null;
  };
  state.current_generation = authority.generation;
  state.active_control_conversation_id = authority.conversationId;
  state.consumer_identity = identity;
  state.task_name = "GBB_TEMP_CONTROL_DOORBELL";
  state.runtime_identity = slash(ROOT);
  state.process_identity = { pid: process.pid, executable: process.execPath };
  state.last_successful_poll_at = timestamp;
  state.last_seen_event_id = last("SEEN") || last("CLAIMED") || last("DELIVERED") || last("CONSUMED");
  state.last_claimed_event_id = last("CLAIMED");
  state.last_delivered_event_id = last("DELIVERED");
  state.last_consumed_event_id = last("CONSUMED");
  state.heartbeat_is_semantic_authority = false;
  state.authority_comment_ids = authority.comment_ids;
}

function updateCounters(state, outcome) {
  if (outcome === "NO_OP_DUPLICATE") state.counters.duplicate_no_ops += 1;
  if (outcome === NO_SEND) state.counters.control_required_no_send += 1;
  if (outcome === TERMINAL_NO_RETRY) state.counters.uncertain_send_no_blind_retry += 1;
}

async function pollOnce() {
  const config = await readJson(CONFIG_PATH);
  assertConfig(config);
  const state = await readJson(STATE_PATH);
  assert.equal(state.schema, "CONTROL_DOORBELL_G13_STATE_V1");
  const timestamp = nowIso();
  const identity = claimLease(state, timestamp);
  const authority = await readCurrentAuthority();
  const herdrTargets = await readHerdrTargets(config);
  const controlTargets = [{ role: "CONTROL", id: authority.conversationId }];
  const comments = await fetchIssueComments(ISSUE);
  state.counters.polls += 1;
  const events = [];
  const receipts = [];
  for (const comment of comments) {
    const parsed = parseDurableComment(comment);
    if (!parsed) continue;
    if (parsed.marker === EVENT_MARKER) events.push(parsed);
    if (parsed.marker === RECEIPT_MARKER) receipts.push(parsed);
  }
  const records = { ...(state.records || {}) };
  for (const event of events.sort((a, b) => Number(a.comment_id) - Number(b.comment_id))) {
    const fields = event.fields;
    if (!fields.logical_event_id) {
      state.counters.control_required_no_send += 1;
      continue;
    }
    const targets = fields.direction === "A" ? herdrTargets : controlTargets;
    const result = reconcileEvent(event, records, authority, targets, timestamp);
    if (result.record && !records[fields.logical_event_id]) records[fields.logical_event_id] = result.record;
    updateCounters(state, result.outcome);
  }
  for (const receipt of receipts.sort((a, b) => Number(a.comment_id) - Number(b.comment_id))) {
    const key = receipt.fields.logical_event_id;
    if (!key) {
      state.counters.control_required_no_send += 1;
      continue;
    }
    const result = mergeReceipt(records, receipt, authority, timestamp);
    if (result.record) records[key] = result.record;
    updateCounters(state, result.outcome);
  }
  state.records = records;
  heartbeat(state, authority, identity, timestamp, records);
  state.last_result = "POLL_OK_NO_PHYSICAL_SEND";
  state.updated_at = timestamp;
  await writeJsonAtomically(STATE_PATH, state);
  return {
    authority,
    event_count: events.length,
    receipt_count: receipts.length,
    records: Object.keys(records).length,
    target_count_A: herdrTargets.length,
    target_count_B: controlTargets.length,
    physical_send_count: 0,
    browser_send_count: 0,
    process_mutation_count: 0
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function selfTest() {
  const authority = {
    generation: GENERATION,
    conversationId: "6aa41339-7b94-83e8-9d24-24de07cf5235"
  };
  const event = {
    marker: EVENT_MARKER,
    logical_event_id: "evt-1",
    issue: String(ISSUE),
    card_or_authority_comment: "5722694009",
    control_generation: GENERATION,
    active_control_conversation_id: authority.conversationId,
    direction: "A",
    requested_action: "wake",
    wake_at_if_any: "NONE",
    exact_target_role: "HERDR",
    idempotency_key: "idem-1"
  };
  const oneHerdr = [{ role: "HERDR", id: "w2:p1" }];
  assert.equal(validateEvent(event, authority, oneHerdr).ok, true);
  assert.equal(validateEvent({ ...event, control_generation: "012" }, authority, oneHerdr).reason, NO_SEND);
  assert.equal(validateEvent({ ...event, active_control_conversation_id: "wrong" }, authority, oneHerdr).reason, NO_SEND);
  assert.equal(validateEvent({ ...event, target_id: "w2:p9" }, authority, oneHerdr).reason, NO_SEND);
  assert.equal(validateEvent(event, authority, [{ role: "HERDR" }, { role: "HERDR" }]).reason, NO_SEND);
  assert.equal(validateEvent({ logical_event_id: "partial" }, authority, oneHerdr).reason, NO_SEND);
  const bEvent = { ...event, logical_event_id: "evt-b", direction: "B", exact_target_role: "CONTROL", target_id: authority.conversationId };
  assert.equal(validateEvent(bEvent, authority, [{ role: "CONTROL", id: authority.conversationId }]).ok, true);
  const claimed = reconcileEvent(event, {}, authority, oneHerdr, "2026-09-18T00:00:00.000Z");
  assert.equal(claimed.record.state, "CLAIMED");
  assert.equal(reconcileEvent(event, { "evt-1": claimed.record }, authority, oneHerdr).outcome, "NO_OP_DUPLICATE");
  assert.equal(reconcileReceipt({ state: "SEND_ATTEMPTED" }, null).state, TERMINAL_NO_RETRY);
  const delivered = reconcileReceipt({ receipt_state: "DELIVERED" }, { ...claimed.record, state: "SEND_ATTEMPTED" });
  assert.equal(delivered.state, "DELIVERED");
  const consumed = reconcileReceipt({ receipt_state: "CONSUMED" }, delivered);
  assert.equal(consumed.state, "CONSUMED");
  const hb = { records: {}, counters: { polls: 0, duplicate_no_ops: 0, control_required_no_send: 0, uncertain_send_no_blind_retry: 0 } };
  heartbeat(hb, authority, { owner_id: "test", host: "test", pid: 1 }, "2026-09-18T00:00:00.000Z", {});
  for (const field of [
    "current_generation",
    "active_control_conversation_id",
    "consumer_identity",
    "task_name",
    "runtime_identity",
    "process_identity",
    "last_successful_poll_at",
    "last_seen_event_id",
    "last_claimed_event_id",
    "last_delivered_event_id",
    "last_consumed_event_id"
  ]) assert.ok(Object.prototype.hasOwnProperty.call(hb, field), field);
  console.log("G13_SELF_TEST_PASS");
}

async function main() {
  const loop = process.argv.includes("--loop");
  do {
    try {
      const result = await pollOnce();
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(JSON.stringify({ state: error.message || "CONTROL_REQUIRED_NO_SEND" }));
      if (!loop) {
        process.exitCode = 1;
        return;
      }
    }
    if (loop) {
      const config = await readJson(CONFIG_PATH);
      await delay(config.poll_interval_ms);
    }
  } while (loop);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
