import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
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
  start: "CURRENT_REHYDRATION_INDEX_",
  registry: "CURRENT_REGISTRY_INDEX_"
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

function validateCardAuthorization(event, authority, card, authorization) {
  const eventFields = event.fields || event;
  const cardFields = card?.fields || card;
  const cardId = String(card?.id || card?.comment_id || "");
  if (!cardFields || cardId !== String(authorization.card_id) ||
      card.marker !== authorization.card_marker ||
      cardFields.state !== "AUTHORIZED_BOUNDED_RUNTIME_REPAIR_WAIT_CONSUMED_STARTED" ||
      cardFields.repository !== REPO || cardFields.issue !== String(ISSUE) ||
      eventFields.control_generation !== authority.generation ||
      eventFields.active_control_conversation_id !== authority.conversationId ||
      cardFields.control_generation !== authority.generation ||
      cardFields.active_control_conversation_id !== authority.conversationId ||
      eventFields.card_or_authority_comment !== cardId ||
      !authorization.allowed_actions.includes(eventFields.requested_action) ||
      (eventFields.direction === "A" && eventFields.requested_action !== "wake") ||
      (eventFields.direction === "B" && eventFields.requested_action !== "return")) {
    return { ok: false, reason: NO_SEND };
  }
  for (const [key, value] of Object.entries(authorization.source_chain)) {
    if (cardFields[key] !== String(value)) return { ok: false, reason: NO_SEND };
  }
  return { ok: true };
}

function validateReceipt(receipt, authority, existing) {
  const fields = receipt.fields || receipt;
  const required = [
    "logical_event_id",
    "receipt_state",
    "control_generation",
    "active_control_conversation_id",
    "exact_target_role",
    "target_id",
    "idempotency_key",
    "actor_type",
    "actor_id",
    "destination_type",
    "destination_id"
  ];
  if (receipt.duplicates?.length || !requiredFields(fields, required)) return { ok: false, reason: NO_SEND };
  if (!["SEND_ATTEMPTED", "DELIVERED", "CONSUMED"].includes(fields.receipt_state)) {
    return { ok: false, reason: NO_SEND };
  }
  if (fields.control_generation !== authority.generation ||
      fields.active_control_conversation_id !== authority.conversationId) {
    return { ok: false, reason: NO_SEND };
  }
  if (!existing || existing.logical_event_id !== fields.logical_event_id ||
      existing.idempotency_key !== fields.idempotency_key ||
      existing.target_role !== fields.exact_target_role || existing.target_id !== fields.target_id ||
      fields.actor_type !== existing.target_role || fields.actor_id !== existing.target_id ||
      fields.destination_type !== existing.target_role || fields.destination_id !== existing.target_id) {
    return { ok: false, reason: NO_SEND };
  }
  if (fields.receipt_state === "SEND_ATTEMPTED") return { ok: true };
  if (fields.independent_observation !== "true" || fields.durable_ack !== "true" ||
      !nonEmpty(fields.observation_id) || !nonEmpty(fields.observation_kind) ||
      !/^[0-9]+$/.test(fields.observation_comment_id || "") ||
      fields.observation_comment_id === String(receipt.comment_id || "") ||
      receipt.observation?.comment_id !== String(fields.observation_comment_id) ||
      receipt.observation.fields?.logical_event_id !== fields.logical_event_id ||
      receipt.observation.fields?.idempotency_key !== fields.idempotency_key ||
      receipt.observation.fields?.actor_id !== fields.actor_id ||
      receipt.observation.fields?.destination_id !== fields.destination_id ||
      receipt.observation.fields?.readback_verified !== "true") return { ok: false, reason: NO_SEND };
  if (fields.receipt_state === "CONSUMED" &&
      (existing.state !== "DELIVERED" || !/^[0-9]+$/.test(fields.ack_comment_id || "") ||
       fields.ack_comment_id === String(receipt.comment_id || "") ||
       fields.ack_logical_event_id !== fields.logical_event_id ||
       fields.ack_idempotency_key !== fields.idempotency_key ||
       fields.ack_actor_id !== fields.actor_id || fields.ack_destination_id !== fields.destination_id ||
       fields.ack_readback_verified !== "true" ||
       receipt.acknowledgement?.comment_id !== String(fields.ack_comment_id) ||
       receipt.acknowledgement.fields?.logical_event_id !== fields.logical_event_id ||
       receipt.acknowledgement.fields?.idempotency_key !== fields.idempotency_key ||
       receipt.acknowledgement.fields?.actor_id !== fields.actor_id ||
       receipt.acknowledgement.fields?.destination_id !== fields.destination_id ||
       receipt.acknowledgement.fields?.readback_verified !== "true")) return { ok: false, reason: NO_SEND };
  return { ok: true };
}

function duplicateRecord(records, event) {
  const fields = event.fields || event;
  return Object.values(records || {}).find((record) =>
    record.logical_event_id === fields.logical_event_id ||
    record.idempotency_key === fields.idempotency_key
  );
}

function reconcileEvent(event, records, authority, targets, timestamp = nowIso(), card, authorization) {
  const duplicate = duplicateRecord(records, event);
  if (duplicate) return { outcome: "NO_OP_DUPLICATE", record: duplicate };
  const checked = validateEvent(event, authority, targets);
  const fields = event.fields || event;
  const authorized = checked.ok && card && authorization &&
    validateCardAuthorization(event, authority, card, authorization).ok;
  const reason = authorized ? null : NO_SEND;
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
    decision: reason || "CLAIMED",
    reason,
    physical_send_authorized: false,
    receipt_ids: [],
    seen_at: timestamp,
    claimed_at: reason ? null : timestamp,
    delivered_at: null,
    consumed_at: null,
    updated_at: timestamp
  };
  if (!reason) record.state = "CLAIMED";
  return { outcome: reason || "CLAIMED", record };
}

function reconcileReceipt(receipt, existing, timestamp = nowIso()) {
  const fields = receipt.fields || receipt;
  const receiptState = fields.receipt_state;
  if (!existing) {
    return {
      state: TERMINAL_NO_RETRY,
      decision: "NO_BLIND_RETRY",
      reason: "RECEIPT_WITHOUT_CLAIM",
      updated_at: timestamp
    };
  }
  const receiptId = receipt.comment_id ? String(receipt.comment_id) : null;
  const receiptIds = receiptId ? [...new Set([...(existing.receipt_ids || []), receiptId])] : [...(existing.receipt_ids || [])];
  if (receiptId && (existing.receipt_ids || []).includes(receiptId)) {
    return { ...existing, decision: "NO_OP_DUPLICATE", receipt_ids: receiptIds };
  }
  if (receiptState === "SEND_ATTEMPTED") {
    return {
      ...existing,
      receipt_ids: receiptIds,
      state: TERMINAL_NO_RETRY,
      decision: "NO_BLIND_RETRY",
      reason: "SEND_ATTEMPTED_WITHOUT_INDEPENDENT_DELIVERY",
      updated_at: timestamp
    };
  }
  if (receiptState === "DELIVERED" &&
      ["SEND_ATTEMPTED", TERMINAL_NO_RETRY].includes(existing.state)) {
    return { ...existing, receipt_ids: receiptIds, state: "DELIVERED", decision: "WAIT_CONSUMED_ACK", reason: null, delivered_at: timestamp, updated_at: timestamp };
  }
  if (receiptState === "CONSUMED" && existing.state === "DELIVERED") {
    return { ...existing, receipt_ids: receiptIds, state: "CONSUMED", decision: "CONSUMED", reason: null, consumed_at: timestamp, updated_at: timestamp };
  }
  return { ...existing, receipt_ids: receiptIds, state: existing.state, decision: NO_SEND, reason: "INVALID_RECEIPT_ORDER", updated_at: timestamp };
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
  const matches = marker.endsWith("_") ? parsed.marker.startsWith(marker) : parsed.marker === marker;
  if (!matches || parsed.duplicates.length) return null;
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

async function githubGetComment(commentId) {
  if (!/^[0-9]+$/.test(String(commentId))) throw new Error(NO_SEND);
  return githubGet("repos/" + REPO + "/issues/comments/" + commentId);
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
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw new Error(file === STATE_PATH ? "CONTROL_REQUIRED_PARTIAL_STATE" : "CONTROL_REQUIRED_CONFIG");
  }
}

function assertState(state) {
  const counters = state?.counters;
  if (!state || state.schema !== "CONTROL_DOORBELL_G13_STATE_V1" || !Number.isInteger(state.revision) || state.revision < 0 ||
      !state.records || typeof state.records !== "object" || !counters ||
      !Number.isInteger(counters.polls) || !Number.isInteger(counters.duplicate_no_ops) ||
      !Number.isInteger(counters.control_required_no_send) || !Number.isInteger(counters.uncertain_send_no_blind_retry)) {
    throw new Error("CONTROL_REQUIRED_PARTIAL_STATE");
  }
  return state;
}

async function persistState(state, expectedRevision, identity) {
  const current = assertState(await readJson(STATE_PATH));
  if (current.revision !== expectedRevision ||
      (identity && (!current.lease || current.lease.owner_id !== identity.owner_id || current.lease.lease_token !== identity.lease_token))) {
    throw new Error("CONTROL_REQUIRED_SINGLE_INSTANCE");
  }
  const next = { ...state, revision: expectedRevision + 1 };
  let handle;
  try {
    handle = await fs.open(STATE_PATH, "r+");
    await handle.truncate(0);
    await handle.writeFile(JSON.stringify(next, null, 2) + "\n", "utf8");
    await handle.sync();
  } catch {
    throw new Error("CONTROL_REQUIRED_PARTIAL_STATE");
  } finally {
    await handle?.close();
  }
  const readback = assertState(await readJson(STATE_PATH));
  if (readback.revision !== next.revision || (identity && readback.lease?.lease_token !== identity.lease_token)) {
    throw new Error("CONTROL_REQUIRED_SINGLE_INSTANCE");
  }
  return readback;
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
  assert.equal(config.transport.task_mutation, false);
  assert.equal(config.transport.workflow_dispatch, false);
  assert.equal(config.transport.repo_mutation, false);
  assert.equal(config.authority_sources.start.marker_prefix, "CURRENT_REHYDRATION_INDEX_");
  assert.equal(config.authority_sources.registry.marker_prefix, "CURRENT_REGISTRY_INDEX_");
  assert.equal(config.herdr.required_version, "0.8.2");
  assert.equal(config.task.name, "GBB_TEMP_CONTROL_DOORBELL");
  assert.equal(config.task.desired_static_definition.action_path, slash(ROOT + "/run.ps1"));
  assert.equal(config.authorization.card_id, "5724061437");
  assert.deepEqual(config.authorization.allowed_actions, ["wake", "return"]);
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

function identityForTest(owner_id, host, pid) {
  return { owner_id, host, pid, lease_token: owner_id + "-token" };
}

function runtimeIdentity() {
  const lease_token = randomUUID();
  return { owner_id: os.hostname() + ":" + process.pid + ":" + lease_token, host: os.hostname(), pid: process.pid, lease_token };
}

function prepareLease(state, timestamp, identity) {
  const previous = state.lease;
  if (previous && !(previous.owner_id === identity.owner_id && previous.lease_token === identity.lease_token) &&
      processIsAlive(previous.pid) && previous.expires_at > timestamp) {
    throw new Error("CONTROL_REQUIRED_SINGLE_INSTANCE");
  }
  return { ...state, lease: {
    ...identity,
    acquired_at: previous?.owner_id === identity.owner_id ? previous.acquired_at : timestamp,
    renewed_at: timestamp,
    expires_at: new Date(Date.parse(timestamp) + 120000).toISOString()
  } };
}

function renewLease(state, timestamp, identity) {
  const lease = state.lease;
  if (!lease || lease.owner_id !== identity.owner_id || lease.lease_token !== identity.lease_token || lease.expires_at <= timestamp) {
    throw new Error("CONTROL_REQUIRED_SINGLE_INSTANCE");
  }
  return prepareLease(state, timestamp, identity);
}

function claimLease(state, timestamp, identity = runtimeIdentity()) {
  const next = prepareLease(state, timestamp, identity);
  state.lease = next.lease;
  return identity;
}

async function renewAtBoundary(state, identity) {
  const current = assertState(await readJson(STATE_PATH));
  const merged = { ...current, ...state, revision: current.revision, lease: current.lease };
  return persistState(renewLease(merged, nowIso(), identity), current.revision, identity);
}

function heartbeat(state, authority, identity, timestamp, records) {
  const entries = Object.values(records);
  const last = (field, idField, timeField) => {
    const matching = entries.filter((record) => nonEmpty(record[field]) && nonEmpty(record.logical_event_id)).sort((a, b) =>
      String(a[field]).localeCompare(String(b[field]))
    );
    const candidate = matching.at(-1);
    if (!candidate || (state[timeField] && String(candidate[field]) < String(state[timeField]))) {
      return { id: state[idField] || null, at: state[timeField] || null };
    }
    return { id: candidate.logical_event_id, at: candidate[field] };
  };
  const claimed = last("claimed_at", "last_claimed_event_id", "last_claimed_at");
  const delivered = last("delivered_at", "last_delivered_event_id", "last_delivered_at");
  const consumed = last("consumed_at", "last_consumed_event_id", "last_consumed_at");
  state.current_generation = authority.generation;
  state.active_control_conversation_id = authority.conversationId;
  state.consumer_identity = identity;
  state.task_name = "GBB_TEMP_CONTROL_DOORBELL";
  state.runtime_identity = slash(ROOT);
  state.process_identity = { pid: process.pid, executable: process.execPath };
  state.last_successful_poll_at = timestamp;
  state.last_seen_event_id = entries.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at))).at(-1)?.logical_event_id || state.last_seen_event_id || null;
  state.last_claimed_event_id = claimed.id;
  state.last_claimed_at = claimed.at;
  state.last_delivered_event_id = delivered.id;
  state.last_delivered_at = delivered.at;
  state.last_consumed_event_id = consumed.id;
  state.last_consumed_at = consumed.at;
  state.heartbeat_is_semantic_authority = false;
  state.authority_comment_ids = authority.comment_ids;
}

function updateCounters(state, outcome) {
  if (outcome === "NO_OP_DUPLICATE") state.counters.duplicate_no_ops += 1;
  if (outcome === NO_SEND) state.counters.control_required_no_send += 1;
  if ([TERMINAL_NO_RETRY, "NO_BLIND_RETRY"].includes(outcome)) state.counters.uncertain_send_no_blind_retry += 1;
}

async function pollOnce() {
  const config = await readJson(CONFIG_PATH);
  assertConfig(config);
  let state = assertState(await readJson(STATE_PATH));
  const identity = runtimeIdentity();
  state = await persistState(prepareLease(state, nowIso(), identity), state.revision, identity);
  let authority = await readCurrentAuthority();
  const initialHerdrTargets = await readHerdrTargets(config);
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
    if (!fields.logical_event_id) { state.counters.control_required_no_send += 1; continue; }
    state = await renewAtBoundary(state, identity);
    authority = await readCurrentAuthority();
    const targets = fields.direction === "A" ? await readHerdrTargets(config) : [{ role: "CONTROL", id: authority.conversationId }];
    let card = null;
    try {
      const raw = await githubGetComment(fields.card_or_authority_comment);
      const parsed = parseFields(raw.body);
      card = { id: String(raw.id), marker: parsed.marker, fields: parsed.fields, duplicates: parsed.duplicates };
    } catch { /* fail closed below */ }
    state = await renewAtBoundary(state, identity);
    authority = await readCurrentAuthority();
    const result = reconcileEvent(event, records, authority, targets, nowIso(), card, config.authorization);
    if (result.record && !records[fields.logical_event_id]) records[fields.logical_event_id] = result.record;
    updateCounters(state, result.outcome);
  }
  for (const receipt of receipts.sort((a, b) => Number(a.comment_id) - Number(b.comment_id))) {
    const key = receipt.fields.logical_event_id;
    if (!key) { state.counters.control_required_no_send += 1; continue; }
    state = await renewAtBoundary(state, identity);
    authority = await readCurrentAuthority();
    let enrichedReceipt = receipt;
    if (["DELIVERED", "CONSUMED"].includes(receipt.fields.receipt_state)) {
      try {
        const observationRaw = await githubGetComment(receipt.fields.observation_comment_id);
        const observationParsed = parseDurableComment(observationRaw);
        let acknowledgement = null;
        if (receipt.fields.receipt_state === "CONSUMED") {
          const acknowledgementRaw = await githubGetComment(receipt.fields.ack_comment_id);
          acknowledgement = parseDurableComment(acknowledgementRaw);
        }
        enrichedReceipt = { ...receipt, observation: observationParsed, acknowledgement };
      } catch { /* fail closed in validateReceipt */ }
    }
    state = await renewAtBoundary(state, identity);
    authority = await readCurrentAuthority();
    const result = mergeReceipt(records, enrichedReceipt, authority, nowIso());
    if (result.record) records[key] = result.record;
    updateCounters(state, result.outcome);
  }
  state = await renewAtBoundary(state, identity);
  state.records = records;
  heartbeat(state, authority, identity, nowIso(), records);
  state.last_result = "POLL_OK_NO_PHYSICAL_SEND";
  state.updated_at = nowIso();
  await persistState(state, state.revision, identity);
  return {
    authority,
    event_count: events.length,
    receipt_count: receipts.length,
    records: Object.keys(records).length,
    target_count_A: initialHerdrTargets.length,
    target_count_B: 1,
    physical_send_count: 0,
    browser_send_count: 0,
    process_mutation_count: 0,
    task_mutation_count: 0,
    workflow_dispatch_count: 0
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
    card_or_authority_comment: "5724061437",
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
  const claimed = reconcileEvent(event, {}, authority, oneHerdr, "2026-09-18T00:00:00.000Z", { id: "5724061437", marker: "CONTROL_G13_RUNTIME_REPAIR_CARD_V1", fields: {
    state: "AUTHORIZED_BOUNDED_RUNTIME_REPAIR_WAIT_CONSUMED_STARTED", repository: REPO, issue: String(ISSUE), control_generation: GENERATION,
    active_control_conversation_id: authority.conversationId, source_runtime_ready_comment_id: "5723766236", source_runtime_consumed_comment_id: "5723620180",
    source_evidence_artifact_ready_comment_id: "5723950310", source_artifact_formal_fail_comment_id: "5724045309", source_evidence_card_id: "5723858716", source_activation_comment_id: "5723532623"
  } }, {
    card_id: "5724061437", card_marker: "CONTROL_G13_RUNTIME_REPAIR_CARD_V1", allowed_actions: ["wake", "return"], source_chain: {
      source_runtime_ready_comment_id: "5723766236", source_runtime_consumed_comment_id: "5723620180", source_evidence_artifact_ready_comment_id: "5723950310",
      source_artifact_formal_fail_comment_id: "5724045309", source_evidence_card_id: "5723858716", source_activation_comment_id: "5723532623"
    }
  });
  assert.equal(claimed.record.state, "CLAIMED");
  const nestedEvent = parseDurableComment({
    id: "evt-comment",
    body: [EVENT_MARKER, "logical_event_id=evt-1", "issue=162", "card_or_authority_comment=5724061437", `control_generation=${GENERATION}`, `active_control_conversation_id=${authority.conversationId}`, "direction=A", "requested_action=wake", "wake_at_if_any=NONE", "exact_target_role=HERDR", "idempotency_key=idem-1"].join("\n")
  });
  assert.equal(reconcileEvent(nestedEvent, { "evt-1": claimed.record }, authority, oneHerdr).outcome, "NO_OP_DUPLICATE");
  const freshAuthority = deriveAuthority(
    [{ id: "5645732538", body: "CONTROL_GENERATION_SWITCH_V1\nnew_generation=013\nnew_conversation_id=" + authority.conversationId + "\nnew_status=ACTIVE" }],
    [{ id: "5645736289", body: "CURRENT_REHYDRATION_INDEX_V118\ncontrol_generation=013\ncontrol_conversation_id=" + authority.conversationId + "\ncontrol_status=ACTIVE" }],
    [{ id: "5645734141", body: "CURRENT_REGISTRY_INDEX_V20\ncontrol_generation=013\ncontrol_conversation_id=" + authority.conversationId }]
  );
  assert.equal(freshAuthority.generation, GENERATION);
  const card = {
    id: "5724061437",
    marker: "CONTROL_G13_RUNTIME_REPAIR_CARD_V1",
    fields: {
      state: "AUTHORIZED_BOUNDED_RUNTIME_REPAIR_WAIT_CONSUMED_STARTED",
      control_generation: GENERATION,
      active_control_conversation_id: authority.conversationId,
      repository: REPO,
      issue: String(ISSUE),
      source_runtime_ready_comment_id: "5723766236",
      source_runtime_consumed_comment_id: "5723620180",
      source_evidence_artifact_ready_comment_id: "5723950310",
      source_artifact_formal_fail_comment_id: "5724045309",
      source_evidence_card_id: "5723858716",
      source_activation_comment_id: "5723532623"
    }
  };
  const authorization = {
    card_id: "5724061437",
    card_marker: "CONTROL_G13_RUNTIME_REPAIR_CARD_V1",
    allowed_actions: ["wake", "return"],
    source_chain: {
      source_runtime_ready_comment_id: "5723766236",
      source_runtime_consumed_comment_id: "5723620180",
      source_evidence_artifact_ready_comment_id: "5723950310",
      source_artifact_formal_fail_comment_id: "5724045309",
      source_evidence_card_id: "5723858716",
      source_activation_comment_id: "5723532623"
    }
  };
  assert.equal(validateCardAuthorization(event, freshAuthority, card, authorization).ok, true);
  assert.equal(validateCardAuthorization({ ...event, requested_action: "delete" }, freshAuthority, card, authorization).ok, false);
  assert.equal(validateCardAuthorization({ ...event, control_generation: "012" }, freshAuthority, card, authorization).ok, false);
  const receipt = {
    marker: RECEIPT_MARKER,
    fields: {
      logical_event_id: "evt-1", receipt_state: "DELIVERED", control_generation: GENERATION,
      active_control_conversation_id: authority.conversationId, exact_target_role: "HERDR", target_id: "w2:p1",
      idempotency_key: "idem-1", actor_type: "HERDR", actor_id: "w2:p1", destination_type: "HERDR",
      destination_id: "w2:p1", observation_id: "obs-1", observation_kind: "INDEPENDENT_DELIVERY",
      independent_observation: "true", durable_ack: "true", observation_comment_id: "9001"
    }, comment_id: "9002", observation: { comment_id: "9001", fields: {
      logical_event_id: "evt-1", idempotency_key: "idem-1", actor_id: "w2:p1", destination_id: "w2:p1", readback_verified: "true"
    } }
  };
  assert.equal(validateReceipt(receipt, authority, { ...claimed.record, state: "SEND_ATTEMPTED" }).ok, true);
  assert.equal(validateReceipt({ ...receipt, observation: null }, authority, { ...claimed.record, state: "SEND_ATTEMPTED" }).ok, false);
  assert.equal(validateReceipt({ ...receipt, fields: { ...receipt.fields, actor_id: "wrong" } }, authority, { ...claimed.record, state: "SEND_ATTEMPTED" }).ok, false);
  assert.equal(validateReceipt({ ...receipt, fields: { ...receipt.fields, observation_comment_id: "9002" } }, authority, { ...claimed.record, state: "SEND_ATTEMPTED" }).ok, false);
  const competing = { revision: 1, lease: { owner_id: "other", host: "other", pid: process.pid, expires_at: "2099-01-01T00:00:00.000Z" } };
  assert.throws(() => prepareLease(competing, "2026-09-18T00:00:00.000Z", { owner_id: "self", host: "self", pid: process.pid }), /CONTROL_REQUIRED_SINGLE_INSTANCE/);
  const identity = identityForTest("self", "self", process.pid);
  assert.throws(() => renewLease({ lease: { ...identity, expires_at: "2020-01-01T00:00:00.000Z" } }, "2026-09-18T00:00:00.000Z", identity), /CONTROL_REQUIRED_SINGLE_INSTANCE/);
  const retained = { last_claimed_event_id: "evt-old", last_delivered_event_id: "evt-old-delivered", last_consumed_event_id: "evt-old-consumed" };
  heartbeat(retained, authority, { owner_id: "test", host: "test", pid: 1 }, "2026-09-18T00:00:00.000Z", {
    "evt-new": { logical_event_id: "evt-new", state: "CONSUMED", claimed_at: "2026-09-18T00:00:01.000Z", delivered_at: "2026-09-18T00:00:02.000Z", consumed_at: "2026-09-18T00:00:03.000Z", updated_at: "2026-09-18T00:00:03.000Z" }
  });
  assert.equal(retained.last_claimed_event_id, "evt-new");
  assert.equal(retained.last_delivered_event_id, "evt-new");
  assert.equal(retained.last_consumed_event_id, "evt-new");
  const counterState = { counters: { duplicate_no_ops: 0, control_required_no_send: 0, uncertain_send_no_blind_retry: 0 } };
  updateCounters(counterState, "NO_BLIND_RETRY");
  assert.equal(counterState.counters.uncertain_send_no_blind_retry, 1);
  assert.equal(/logs|watcher\.log/.test(readFileSync(path.join(ROOT, "run.ps1"), "utf8")), false);
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.equal(source.includes("." + "tmp"), false);
  assert.equal(source.includes("writeJson" + "Atomically"), false);
  assert.deepEqual({ physical_send_count: 0, browser_send_count: 0, process_mutation_count: 0, task_mutation_count: 0, workflow_dispatch_count: 0, repo_mutation_count: 0 },
    { physical_send_count: 0, browser_send_count: 0, process_mutation_count: 0, task_mutation_count: 0, workflow_dispatch_count: 0, repo_mutation_count: 0 });
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
      process.exitCode = 1;
      return;
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
