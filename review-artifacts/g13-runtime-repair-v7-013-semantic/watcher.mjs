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
const OBSERVATION_MARKER = "GBB_G13_BIDIRECTIONAL_WAKE_OBSERVATION_V1";
const ACK_MARKER = "GBB_G13_BIDIRECTIONAL_WAKE_ACK_V1";
const STATES = ["SEEN", "CLAIMED", "SEND_ATTEMPTED", "DELIVERED", "CONSUMED"];
const TERMINAL_NO_RETRY = "UNCERTAIN_SEND";
const NO_SEND = "CONTROL_REQUIRED_NO_SEND";
const OWNER_LOGIN = "D22977";
const OWNER_ASSOCIATION = "OWNER";
const AUTHORITY_MARKERS = {
  controlSwitch: "CONTROL_GENERATION_SWITCH_V1",
  start: "CURRENT_REHYDRATION_INDEX_",
  registry: "CURRENT_REGISTRY_INDEX_"
};
const DEFAULT_ADMITTED_PRODUCERS = [
  {
    producer_id: "herdr-daemon",
    github_login: "herdr-agent",
    allowed_provenance: "HERDR_LOCAL_OBSERVATION",
    allowed_states: ["DELIVERED"]
  },
  {
    producer_id: "herdr-consumer",
    github_login: "herdr-consumer",
    allowed_provenance: "HERDR_LOCAL_ACK",
    allowed_states: ["CONSUMED"]
  }
];
const DEFAULT_RECOGNIZED_CANARY_SCOPES = [
  "issue162-single-event",
  "issue162-bounded-pane-canary"
];

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
  if (![EVENT_MARKER, RECEIPT_MARKER, OBSERVATION_MARKER, ACK_MARKER].includes(parsed.marker)) return null;
  const issueUrl = String(comment.issue_url || "");
  const issueMatch = /\/issues\/(\d+)(?:$|\?|\/)/.exec(issueUrl);
  return {
    marker: parsed.marker,
    fields: parsed.fields,
    duplicates: parsed.duplicates,
    comment_id: String(comment.id),
    created_at: comment.created_at || null,
    issue_number: comment.issue_number ? String(comment.issue_number) : issueMatch?.[1] || null,
    issue_url: comment.issue_url || null,
    author_login: comment.author_login || comment.user?.login || null,
    author_association: comment.author_association || null
  };
}

function isAuthorizedGitHubComment(comment, expectedIssue = ISSUE, allowNonOwner = false) {
  return comment?.issue_number === String(expectedIssue) &&
    (allowNonOwner ? Boolean(comment.author_login) : (comment.author_login === OWNER_LOGIN && comment.author_association === OWNER_ASSOCIATION));
}

function parseGitHubRecord(comment) {
  const durable = parseDurableComment(comment);
  if (durable) return durable;
  const parsed = parseFields(comment.body);
  const issueUrl = String(comment.issue_url || "");
  const issueMatch = /\/issues\/(\d+)(?:$|\?|\/)/.exec(issueUrl);
  return {
    marker: parsed.marker,
    fields: parsed.fields,
    duplicates: parsed.duplicates,
    comment_id: String(comment.id),
    issue_number: comment.issue_number ? String(comment.issue_number) : issueMatch?.[1] || null,
    issue_url: comment.issue_url || null,
    author_login: comment.user?.login || null,
    author_association: comment.author_association || null
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
  if (event.duplicates?.length || !requiredFields(fields, required) || !isAuthorizedGitHubComment(event, ISSUE)) return { ok: false, reason: NO_SEND };
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
  if (fields.direction === "B" && !validateReturnTarget(fields, authority, targets).ok) return { ok: false, reason: NO_SEND };
  return { ok: true, target };
}

function validateReturnTarget(event, authority, targets = [{ role: "CONTROL", id: authority?.conversationId }]) {
  const fields = event.fields || event;
  if (fields.direction !== "B" || !nonEmpty(fields.target_id) || fields.target_id !== authority?.conversationId) {
    return { ok: false, reason: NO_SEND };
  }
  const matching = (targets || []).filter((target) => target.role === "CONTROL");
  return matching.length === 1 && matching[0].id === authority.conversationId
    ? { ok: true, target: matching[0] }
    : { ok: false, reason: NO_SEND };
}

function validateCardAuthorization(event, authority, card, authorization = null) {
  const eventFields = event.fields || event;
  const cardFields = card?.fields || card;
  const cardId = String(card?.id || card?.comment_id || "");
  const expiresAt = Date.parse(cardFields?.expires_at || "");
  const boundedScope = cardFields?.canary_scope;
  const recognizedScopes = new Set(authorization?.recognized_canary_scopes || DEFAULT_RECOGNIZED_CANARY_SCOPES);
  const actionCapabilities = authorization?.action_capabilities || {
    wake: "HERDR_SINGLE_PANE_WAKE",
    return: "CONTROL_DOORBELL_RETURN"
  };
  const requiredCapability = actionCapabilities[eventFields.requested_action];
  const cardCapability = cardFields?.operational_capability || cardFields?.capability;

  if (!cardFields || !isAuthorizedGitHubComment(card, ISSUE) ||
      !/^GBB_G13_(WAKE|RETURN)_OPERATIONAL_CARD_V1$/.test(card.marker) ||
      cardFields.state !== "AUTHORIZED_BOUNDED_OPERATIONAL_SEND" ||
      cardFields.repository !== REPO || cardFields.issue !== String(ISSUE) ||
      cardFields.control_generation !== authority.generation ||
      cardFields.active_control_conversation_id !== authority.conversationId ||
      cardFields.requested_action !== eventFields.requested_action ||
      cardFields.direction !== eventFields.direction ||
      cardFields.exact_target_role !== eventFields.exact_target_role ||
      cardFields.target_id !== eventFields.target_id ||
      cardFields.logical_event_id !== eventFields.logical_event_id ||
      cardFields.idempotency_key !== eventFields.idempotency_key ||
      eventFields.card_or_authority_comment !== cardId ||
      !nonEmpty(cardCapability) || cardCapability !== requiredCapability ||
      !nonEmpty(boundedScope) || !recognizedScopes.has(boundedScope) ||
      ["unbounded", "everything", "all", "global", "any", "unrestricted"].includes(boundedScope.toLowerCase()) ||
      !/^issue162-(?:single-event|bounded-[a-z0-9-]+)$/.test(boundedScope) ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
      (eventFields.direction === "A" && eventFields.requested_action !== "wake") ||
      (eventFields.direction === "B" && eventFields.requested_action !== "return")) {
    return { ok: false, reason: NO_SEND };
  }
  return { ok: true };
}

function validateReceipt(receipt, authority, existing, config = null) {
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
  if (receipt.duplicates?.length || !requiredFields(fields, required) || !isAuthorizedGitHubComment(receipt, ISSUE)) return { ok: false, reason: NO_SEND };
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
  if (fields.actor_id === receipt.author_login || fields.destination_id === receipt.author_login) {
    return { ok: false, reason: NO_SEND };
  }
  if (fields.receipt_state === "SEND_ATTEMPTED") return { ok: true };

  const admittedProducers = config?.transport?.admitted_producers || DEFAULT_ADMITTED_PRODUCERS;
  const obsProducer = admittedProducers.find((p) =>
    p.producer_id === fields.transport_producer_id &&
    p.allowed_provenance === fields.transport_provenance &&
    (!p.allowed_states || p.allowed_states.includes("DELIVERED"))
  );
  if (!obsProducer) return { ok: false, reason: NO_SEND };

  if (fields.independent_observation !== "true" || fields.durable_ack !== "true" ||
      !nonEmpty(fields.observation_id) || !nonEmpty(fields.observation_kind) ||
      !/^[0-9]+$/.test(fields.observation_comment_id || "") ||
      fields.observation_comment_id === String(receipt.comment_id || "") ||
      !receipt.observation ||
      receipt.observation.duplicates?.length ||
      receipt.observation.comment_id !== String(fields.observation_comment_id) ||
      receipt.observation.fields?.logical_event_id !== fields.logical_event_id ||
      receipt.observation.fields?.idempotency_key !== fields.idempotency_key ||
      receipt.observation.fields?.actor_id !== fields.actor_id ||
      receipt.observation.fields?.destination_id !== fields.destination_id ||
      receipt.observation.fields?.actor_type !== fields.actor_type ||
      receipt.observation.fields?.destination_type !== fields.destination_type ||
      receipt.observation.fields?.readback_verified !== "true" ||
      receipt.observation.marker !== OBSERVATION_MARKER ||
      !isAuthorizedGitHubComment(receipt.observation, ISSUE, true) ||
      receipt.observation.author_login === OWNER_LOGIN ||
      receipt.observation.author_login === receipt.author_login ||
      receipt.observation.author_login !== obsProducer.github_login ||
      receipt.observation.fields?.transport_producer_id !== fields.transport_producer_id ||
      receipt.observation.fields?.transport_provenance !== fields.transport_provenance ||
      receipt.observation.comment_id === String(receipt.comment_id || "")) return { ok: false, reason: NO_SEND };

  if (fields.receipt_state === "CONSUMED") {
    const ackProducer = admittedProducers.find((p) =>
      (p.producer_id === receipt.acknowledgement?.fields?.transport_producer_id || p.producer_id === "herdr-consumer") &&
      (p.allowed_provenance === receipt.acknowledgement?.fields?.transport_provenance || p.allowed_provenance === "HERDR_LOCAL_ACK") &&
      (!p.allowed_states || p.allowed_states.includes("CONSUMED"))
    );
    if (!ackProducer) return { ok: false, reason: NO_SEND };

    if (existing.state !== "DELIVERED" || !/^[0-9]+$/.test(fields.ack_comment_id || "") ||
        fields.ack_comment_id === String(receipt.comment_id || "") ||
        fields.ack_logical_event_id !== fields.logical_event_id ||
        fields.ack_idempotency_key !== fields.idempotency_key ||
        fields.ack_actor_id !== fields.actor_id || fields.ack_destination_id !== fields.destination_id ||
        fields.ack_readback_verified !== "true" ||
        !receipt.acknowledgement ||
        receipt.acknowledgement.duplicates?.length ||
        receipt.acknowledgement.comment_id !== String(fields.ack_comment_id) ||
        receipt.acknowledgement.fields?.logical_event_id !== fields.logical_event_id ||
        receipt.acknowledgement.fields?.idempotency_key !== fields.idempotency_key ||
        receipt.acknowledgement.fields?.actor_id !== fields.actor_id ||
        receipt.acknowledgement.fields?.destination_id !== fields.destination_id ||
        receipt.acknowledgement.fields?.actor_type !== fields.actor_type ||
        receipt.acknowledgement.fields?.destination_type !== fields.destination_type ||
        receipt.acknowledgement.fields?.readback_verified !== "true" ||
        receipt.acknowledgement.marker !== ACK_MARKER ||
        !isAuthorizedGitHubComment(receipt.acknowledgement, ISSUE, true) ||
        receipt.acknowledgement.author_login === OWNER_LOGIN ||
        receipt.acknowledgement.author_login === receipt.author_login ||
        receipt.acknowledgement.author_login === receipt.observation.author_login ||
        receipt.acknowledgement.author_login !== ackProducer.github_login ||
        receipt.acknowledgement.comment_id === String(receipt.comment_id || "") ||
        receipt.acknowledgement.comment_id === receipt.observation.comment_id) return { ok: false, reason: NO_SEND };
  }
  return { ok: true };
}

function duplicateRecord(records, event) {
  const fields = event.fields || event;
  const exact = Object.values(records || {}).find((record) => record.logical_event_id === fields.logical_event_id);
  if (exact) return { kind: exact.idempotency_key === fields.idempotency_key ? "exact" : "logical_conflict", record: exact };
  const alias = Object.values(records || {}).find((record) => record.idempotency_key === fields.idempotency_key);
  return alias ? { kind: "idempotency_alias", record: alias } : null;
}

function assertCanonicalRecords(records) {
  for (const [key, record] of Object.entries(records || {})) {
    if (!record || key !== record.logical_event_id) throw new Error(NO_SEND);
  }
  return records;
}

function reconcileEvent(event, records, authority, targets, timestamp = nowIso(), card, authorization = null) {
  const duplicate = duplicateRecord(records, event);
  if (duplicate?.kind === "exact") return { outcome: "NO_OP_DUPLICATE", record: duplicate.record };
  if (duplicate) return { outcome: NO_SEND, record: null, alias_rejected: true };
  const checked = validateEvent(event, authority, targets);
  const fields = event.fields || event;
  const authorized = checked.ok && card &&
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
  const eventCommentId = Number(existing.source_comment_id || 0);
  const eventTime = existing.seen_at || existing.claimed_at || "";

  if (receiptState === "SEND_ATTEMPTED") {
    const sendCommentId = Number(receipt.comment_id || 0);
    const sendTime = receipt.created_at || timestamp;
    if (!sendCommentId || !eventCommentId || sendCommentId <= eventCommentId || (sendTime && eventTime && sendTime < eventTime)) {
      return { ...existing, receipt_ids: receiptIds, state: existing.state, decision: NO_SEND, reason: "CAUSAL_ORDER_VIOLATION", updated_at: timestamp };
    }
    return {
      ...existing,
      receipt_ids: receiptIds,
      state: TERMINAL_NO_RETRY,
      decision: "NO_BLIND_RETRY",
      reason: "SEND_ATTEMPTED_WITHOUT_INDEPENDENT_DELIVERY",
      send_attempted_comment_id: String(sendCommentId),
      send_attempted_at: sendTime,
      updated_at: timestamp
    };
  }
  if (receiptState === "DELIVERED" &&
      ["SEND_ATTEMPTED", TERMINAL_NO_RETRY].includes(existing.state)) {
    const sendCommentId = Number(existing.send_attempted_comment_id || 0);
    const sendTime = existing.send_attempted_at || eventTime;
    const obsCommentId = Number(fields.observation_comment_id || 0);
    const obsTime = receipt.observation?.created_at || receipt.observation?.fields?.created_at || "";
    const deliveredCommentId = Number(receipt.comment_id || 0);
    const deliveredTime = receipt.created_at || timestamp;

    if (!sendCommentId || !obsCommentId || !deliveredCommentId ||
        obsCommentId <= sendCommentId ||
        deliveredCommentId < obsCommentId ||
        (obsTime && sendTime && obsTime < sendTime) ||
        (deliveredTime && obsTime && deliveredTime < obsTime)) {
      return { ...existing, receipt_ids: receiptIds, state: existing.state, decision: NO_SEND, reason: "CAUSAL_ORDER_VIOLATION", updated_at: timestamp };
    }
    return {
      ...existing,
      receipt_ids: receiptIds,
      state: "DELIVERED",
      decision: "WAIT_CONSUMED_ACK",
      reason: null,
      observation_comment_id: String(obsCommentId),
      observation_at: obsTime,
      delivered_comment_id: String(deliveredCommentId),
      delivered_at: deliveredTime,
      updated_at: timestamp
    };
  }
  if (receiptState === "CONSUMED" && existing.state === "DELIVERED") {
    const deliveredCommentId = Number(existing.delivered_comment_id || 0);
    const deliveredTime = existing.delivered_at || "";
    const ackCommentId = Number(fields.ack_comment_id || 0);
    const ackTime = receipt.acknowledgement?.created_at || receipt.acknowledgement?.fields?.created_at || "";
    const consumedCommentId = Number(receipt.comment_id || 0);
    const consumedTime = receipt.created_at || timestamp;

    if (!deliveredCommentId || !ackCommentId || !consumedCommentId ||
        ackCommentId <= deliveredCommentId ||
        consumedCommentId < ackCommentId ||
        (ackTime && deliveredTime && ackTime < deliveredTime) ||
        (consumedTime && ackTime && consumedTime < ackTime)) {
      return { ...existing, receipt_ids: receiptIds, state: existing.state, decision: NO_SEND, reason: "CAUSAL_ORDER_VIOLATION", updated_at: timestamp };
    }
    return {
      ...existing,
      receipt_ids: receiptIds,
      state: "CONSUMED",
      decision: "CONSUMED",
      reason: null,
      ack_comment_id: String(ackCommentId),
      ack_at: ackTime,
      consumed_comment_id: String(consumedCommentId),
      consumed_at: consumedTime,
      updated_at: timestamp
    };
  }
  return { ...existing, receipt_ids: receiptIds, state: existing.state, decision: NO_SEND, reason: "INVALID_RECEIPT_ORDER", updated_at: timestamp };
}

function mergeReceipt(records, receipt, authority, timestamp = nowIso(), config = null) {
  const fields = receipt.fields || receipt;
  const key = fields.logical_event_id;
  const existing = records[key];
  const checked = validateReceipt(receipt, authority, existing, config);
  if (!checked.ok) {
    return { outcome: checked.reason, record: existing || null };
  }
  const next = reconcileReceipt(receipt, existing, timestamp);
  return { outcome: next.decision, record: next };
}

function parseAuthorityCandidate(comment, expectedIssue) {
  const issueMatch = /\/issues\/(\d+)(?:$|\?|\/)/.exec(String(comment?.issue_url || comment?.html_url || ""));
  const issueNum = comment?.issue_number || issueMatch?.[1];
  const login = comment?.author_login || comment?.user?.login;
  const assoc = comment?.author_association;
  if (String(issueNum) !== String(expectedIssue) || login !== OWNER_LOGIN || assoc !== OWNER_ASSOCIATION) {
    return null;
  }
  const firstLine = String(comment?.body || "").trim().split(/\r?\n/)[0].trim();
  return {
    id: String(comment.id),
    firstLine,
    comment
  };
}

function parseAuthorityComment(comment, marker) {
  const parsed = parseFields(comment?.body || "");
  const matches = marker.endsWith("_") ? parsed.marker.startsWith(marker) : parsed.marker === marker;
  if (!matches || parsed.duplicates.length) return null;
  const issueUrl = String(comment?.issue_url || "");
  const issueMatch = /\/issues\/(\d+)(?:$|\?|\/)/.exec(issueUrl);
  return {
    id: String(comment.id),
    marker: parsed.marker,
    fields: parsed.fields,
    created_at: comment.created_at || null,
    issue_number: comment.issue_number ? String(comment.issue_number) : issueMatch?.[1] || null,
    issue_url: comment.issue_url || null,
    author_login: comment.author_login || comment.user?.login || null,
    author_association: comment.author_association || null
  };
}

function latestAuthority(comments, marker, required, expectedIssue) {
  const matching = [];
  for (const comment of comments || []) {
    const cand = parseAuthorityCandidate(comment, expectedIssue);
    if (!cand) continue;
    const matches = marker.endsWith("_") ? cand.firstLine.startsWith(marker) : cand.firstLine === marker;
    if (matches) {
      matching.push(cand);
    }
  }
  if (!matching.length) throw new Error(NO_SEND);
  matching.sort((a, b) => Number(a.id) - Number(b.id));
  const latest = matching[matching.length - 1];
  const parsed = parseFields(latest.comment.body);
  const markerMatches = marker.endsWith("_") ? parsed.marker.startsWith(marker) : parsed.marker === marker;
  if (!markerMatches || parsed.duplicates.length > 0 || !requiredFields(parsed.fields, required)) {
    throw new Error(NO_SEND);
  }
  return {
    id: latest.id,
    marker: parsed.marker,
    fields: parsed.fields,
    created_at: latest.comment.created_at || null,
    issue_number: String(expectedIssue),
    issue_url: latest.comment.issue_url || null,
    author_login: latest.comment.author_login || latest.comment.user?.login || null,
    author_association: latest.comment.author_association || null
  };
}

function deriveAuthority(switchComments, startComments, registryComments) {
  const controlSwitch = latestAuthority(
    switchComments,
    AUTHORITY_MARKERS.controlSwitch,
    ["new_generation", "new_conversation_id", "new_status"],
    88
  );
  const start = latestAuthority(
    startComments,
    AUTHORITY_MARKERS.start,
    ["control_generation", "control_conversation_id", "control_status"],
    43
  );
  const registry = latestAuthority(
    registryComments,
    AUTHORITY_MARKERS.registry,
    ["control_generation", "control_conversation_id"],
    81
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

function acquireSingletonGuard(options = {}) {
  const mutexName = options.mutexName || "Local\\GBB_G13_CONTROL_DOORBELL_013_V2";
  const timeoutMs = options.timeoutMs || 5000;
  const script = [
    "$m = [System.Threading.Mutex]::new($false, '" + mutexName + "');",
    "if (-not $m.WaitOne(0)) { [Console]::Out.WriteLine('BUSY'); [Console]::Out.Flush(); exit 17 };",
    "[Console]::Out.WriteLine('ACQUIRED'); [Console]::Out.Flush();",
    "while (($line = [Console]::In.ReadLine()) -ne $null) {",
    "  if ($line -eq 'PING') { [Console]::Out.WriteLine('PONG'); [Console]::Out.Flush() } elseif ($line -eq 'RELEASE') { break }",
    "};",
    "$m.ReleaseMutex(); $m.Dispose()"
  ].join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let buffer = "";
    let stderr = "";
    let settled = false;
    let pending = null;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(error);
      } else if (pending) {
        const current = pending;
        pending = null;
        current.reject(error);
      }
    };
    const consume = (chunk) => {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (!settled) {
          settled = true;
          if (line === "ACQUIRED") {
            resolve(makeGuard(child, timeoutMs, fail));
          } else {
            child.kill();
            reject(new Error("CONTROL_REQUIRED_SINGLE_INSTANCE"));
          }
        } else if (pending) {
          const current = pending;
          pending = null;
          line === "PONG" ? current.resolve() : current.reject(new Error("CONTROL_REQUIRED_SINGLE_INSTANCE"));
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", consume);
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", fail);
    child.on("close", (code) => {
      if (!settled) fail(new Error(stderr.trim() || "CONTROL_REQUIRED_SINGLE_INSTANCE"));
      else if (pending) {
        const current = pending;
        pending = null;
        current.reject(new Error("CONTROL_REQUIRED_SINGLE_INSTANCE"));
      }
    });
    setTimeout(() => {
      if (!settled) fail(new Error("CONTROL_REQUIRED_SINGLE_INSTANCE"));
    }, timeoutMs);
  });
}

function makeGuard(child, timeoutMs, fail) {
  let released = false;
  let renewing = false;
  let pending = null;
  let expiresAt = Date.now() + timeoutMs;
  const stdout = child.stdout;
  const bufferState = { buffer: "" };
  const onData = (chunk) => {
    bufferState.buffer += String(chunk);
    let newline;
    while ((newline = bufferState.buffer.indexOf("\n")) >= 0) {
      const line = bufferState.buffer.slice(0, newline).trim();
      bufferState.buffer = bufferState.buffer.slice(newline + 1);
      if (line === "PONG" && pending) {
        const request = pending;
        pending = null;
        renewing = false;
        expiresAt = Date.now() + timeoutMs;
        request.resolve();
      }
    }
  };
  stdout.on("data", onData);
  return {
    async renew() {
      if (released || Date.now() >= expiresAt || renewing) throw new Error("CONTROL_REQUIRED_SINGLE_INSTANCE");
      renewing = true;
      child.stdin.write("PING\n");
      await new Promise((resolve, reject) => {
        pending = { resolve, reject };
        setTimeout(() => {
          if (pending) {
            pending = null;
            renewing = false;
            fail(new Error("CONTROL_REQUIRED_SINGLE_INSTANCE"));
            reject(new Error("CONTROL_REQUIRED_SINGLE_INSTANCE"));
          }
        }, timeoutMs);
      });
    },
    async release() {
      if (released) return;
      released = true;
      child.stdin.write("RELEASE\n");
      child.stdin.end();
      await new Promise((resolve) => child.once("close", resolve));
    }
  };
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

async function readCurrentAuthority(fetchComments = fetchIssueComments) {
  const [switchComments, startComments, registryComments] = await Promise.all([
    fetchComments(88),
    fetchComments(43),
    fetchComments(81)
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

async function persistState(state, expectedRevision, identity, storage = null) {
  const read = storage?.read || (() => readJson(STATE_PATH));
  const write = storage?.write || (async (next) => {
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
  });
  const current = assertState(await read());
  const initialAcquire = expectedRevision === 0 && current.revision === 0 &&
    state.lease?.owner_id === identity?.owner_id && state.lease?.lease_token === identity?.lease_token;
  if (current.revision !== expectedRevision ||
      (!initialAcquire && identity && (!current.lease || current.lease.owner_id !== identity.owner_id || current.lease.lease_token !== identity.lease_token))) {
    throw new Error("CONTROL_REQUIRED_SINGLE_INSTANCE");
  }
  const next = { ...state, revision: expectedRevision + 1 };
  await write(next);
  const readback = assertState(await read());
  if (readback.revision !== next.revision || (identity && readback.lease?.lease_token !== identity.lease_token)) {
    throw new Error("CONTROL_REQUIRED_SINGLE_INSTANCE");
  }
  return readback;
}

function assertConfig(config) {
  const expectedFiles = ["watcher.mjs", "config.json", "state.json", "run.ps1"];
  assert.equal(config.schema, "CONTROL_DOORBELL_G13_CONFIG_V1");
  assert.equal(slash(config.runtime_root), slash("D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell"));
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
  assert.equal(config.task.desired_static_definition.action_path, slash("D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/run.ps1"));
  assert.equal(config.authorization.model, "dynamic_per_event_operational_card");
  assert.equal(config.authorization.operational_card_prefix, "GBB_G13_");
  assert.deepEqual(config.authorization.allowed_actions, ["wake", "return"]);
  assert.equal(config.authorization.action_capabilities?.wake, "HERDR_SINGLE_PANE_WAKE");
  assert.equal(config.authorization.action_capabilities?.return, "CONTROL_DOORBELL_RETURN");
  assert.ok(Array.isArray(config.transport.admitted_producers));
  return config;
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

function prepareInitialLease(state, timestamp, identity) {
  if (state.revision === 0 && !state.lease) {
    return { ...state, lease: {
      ...identity,
      acquired_at: timestamp,
      renewed_at: timestamp,
      expires_at: new Date(Date.parse(timestamp) + 120000).toISOString()
    } };
  }
  return prepareLease(state, timestamp, identity);
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

async function renewAtBoundary(state, identity, io) {
  await io.guard.renew();
  const current = assertState(await io.readState());
  const merged = { ...current, ...state, revision: current.revision, lease: current.lease };
  return io.persistState(renewLease(merged, io.now(), identity), current.revision, identity);
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

function productionIo() {
  return {
    readConfig: () => readJson(CONFIG_PATH),
    readState: () => readJson(STATE_PATH),
    persistState: (state, revision, identity) => persistState(state, revision, identity),
    acquireGuard: () => acquireSingletonGuard(),
    readAuthority: () => readCurrentAuthority(),
    readTargets: (config) => readHerdrTargets(config),
    fetchComments: () => fetchIssueComments(ISSUE),
    fetchComment: (id) => githubGetComment(id),
    now: nowIso
  };
}

function controlTargets(authority) {
  return [{ role: "CONTROL", id: authority.conversationId }];
}

async function persistSemantic(state, records, authority, identity, io, timestamp) {
  state.records = records;
  heartbeat(state, authority, identity, timestamp, records);
  state.last_result = "POLL_OK_NO_PHYSICAL_SEND";
  state.updated_at = timestamp;
  return io.persistState(state, state.revision, identity);
}

async function pollOnce(harness) {
  const io = { ...productionIo(), ...(harness || {}) };
  const config = assertConfig(await io.readConfig());
  let state = assertState(await io.readState());
  const identity = io.identity || runtimeIdentity();
  const guard = await io.acquireGuard();
  io.guard = guard;
  const initialRevision = state.revision;
  try {
    state = await io.persistState(prepareInitialLease(state, io.now(), identity), initialRevision, identity);
    let authority = await io.readAuthority();
    const initialHerdrTargets = await io.readTargets(config);
    const comments = await io.fetchComments();
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
    assertCanonicalRecords(records);
    for (const event of events.sort((a, b) => Number(a.comment_id) - Number(b.comment_id))) {
      const fields = event.fields;
      state = await renewAtBoundary(state, identity, io);
      authority = await io.readAuthority();
      const targets = fields.direction === "A" ? await io.readTargets(config) : controlTargets(authority);
      let card = null;
      try { card = parseGitHubRecord(await io.fetchComment(fields.card_or_authority_comment)); } catch { /* fail closed below */ }
      state = await renewAtBoundary(state, identity, io);
      authority = await io.readAuthority();
      const finalTargets = fields.direction === "A" ? await io.readTargets(config) : controlTargets(authority);
      const result = fields.logical_event_id
        ? reconcileEvent(event, records, authority, finalTargets, io.now(), card, config.authorization)
        : { outcome: NO_SEND, record: null };
      if (result.record) {
        if (result.record.logical_event_id !== fields.logical_event_id) throw new Error(NO_SEND);
        records[result.record.logical_event_id] = result.record;
      }
      updateCounters(state, result.outcome);
      state = await persistSemantic(state, records, authority, identity, io, io.now());
    }
    for (const receipt of receipts.sort((a, b) => Number(a.comment_id) - Number(b.comment_id))) {
      const key = receipt.fields.logical_event_id;
      state = await renewAtBoundary(state, identity, io);
      authority = await io.readAuthority();
      let enrichedReceipt = receipt;
      if (["DELIVERED", "CONSUMED"].includes(receipt.fields.receipt_state)) {
        try {
          const observation = parseDurableComment(await io.fetchComment(receipt.fields.observation_comment_id));
          let acknowledgement = null;
          if (receipt.fields.receipt_state === "CONSUMED") {
            acknowledgement = parseDurableComment(await io.fetchComment(receipt.fields.ack_comment_id));
          }
          enrichedReceipt = { ...receipt, observation, acknowledgement };
        } catch { /* fail closed in validateReceipt */ }
      }
      state = await renewAtBoundary(state, identity, io);
      authority = await io.readAuthority();
      const result = key ? mergeReceipt(records, enrichedReceipt, authority, io.now(), config) : { outcome: NO_SEND, record: null };
      if (result.record) {
        if (result.record.logical_event_id !== key) throw new Error(NO_SEND);
        records[key] = result.record;
      }
      updateCounters(state, result.outcome);
      state = await persistSemantic(state, records, authority, identity, io, io.now());
    }
    state = await renewAtBoundary(state, identity, io);
    const finalAuthority = await io.readAuthority();
    const finalTargets = controlTargets(finalAuthority);
    assertCanonicalRecords(records);
    for (const record of Object.values(records)) {
      if (record.direction === "B" && !validateReturnTarget(record, finalAuthority, finalTargets).ok) throw new Error(NO_SEND);
    }
    authority = finalAuthority;
    state = await persistSemantic(state, records, authority, identity, io, io.now());
    return {
      authority,
      event_count: events.length,
      receipt_count: receipts.length,
      records: Object.keys(records).length,
      target_count_A: initialHerdrTargets.length,
      target_count_B: finalTargets.length,
      physical_send_count: 0,
      browser_send_count: 0,
      process_mutation_count: 0,
      task_mutation_count: 0,
      workflow_dispatch_count: 0
    };
  } finally {
    await guard.release();
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function testComment(id, marker, fields, overrides = {}) {
  return {
    id: String(id),
    issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/162",
    user: { login: OWNER_LOGIN },
    author_association: OWNER_ASSOCIATION,
    created_at: "2026-09-18T00:00:00.000Z",
    body: [marker, ...Object.entries(fields).map(([key, value]) => `${key}=${value}`)].join("\n"),
    ...overrides
  };
}

function authorityCommentFixture(conversationId) {
  const meta = (issue) => ({ issue_url: `https://api.github.com/repos/D22977/gpt-browser-bridge/issues/${issue}`, user: { login: OWNER_LOGIN }, author_association: OWNER_ASSOCIATION });
  return {
    controlSwitch: [{ id: "7001", ...meta(88), body: `CONTROL_GENERATION_SWITCH_V1\nnew_generation=${GENERATION}\nnew_conversation_id=${conversationId}\nnew_status=ACTIVE` }],
    start: [{ id: "5725452761", ...meta(43), body: `CURRENT_REHYDRATION_INDEX_V118\ncontrol_generation: ${GENERATION}\ncontrol_status: ACTIVE\ncontrol_conversation_id: ${conversationId}` }],
    registry: [{ id: "7003", ...meta(81), body: `CURRENT_REGISTRY_INDEX_V20\ncontrol_generation=${GENERATION}\ncontrol_conversation_id=${conversationId}` }]
  };
}

function metaFixture(issue) {
  return { issue_url: `https://api.github.com/repos/D22977/gpt-browser-bridge/issues/${issue}`, user: { login: OWNER_LOGIN }, author_association: OWNER_ASSOCIATION };
}

function authorityFixture(conversationId) {
  const fixture = authorityCommentFixture(conversationId);
  return deriveAuthority(fixture.controlSwitch, fixture.start, fixture.registry);
}

async function selfTest() {
  assert.equal(pollOnce.length, 1, "pollOnce exposes the bounded real-I/O harness");
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  assertConfig(config);
  const authority = authorityFixture("6aa41339-7b94-83e8-9d24-24de07cf5235");
  const authorityComments = authorityCommentFixture(authority.conversationId);
  const readAuthority = await readCurrentAuthority(async (issue) => ({ 88: authorityComments.controlSwitch, 43: authorityComments.start, 81: authorityComments.registry }[issue]));
  assert.deepEqual(readAuthority, authority);
  assert.throws(() => deriveAuthority(
    authorityComments.controlSwitch,
    [{ ...authorityComments.start[0], issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/162" }],
    authorityComments.registry
  ), /CONTROL_REQUIRED_NO_SEND/);
  assert.throws(() => deriveAuthority(
    [{ ...authorityComments.controlSwitch[0], issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/162" }],
    authorityComments.start,
    authorityComments.registry
  ), /CONTROL_REQUIRED_NO_SEND/);
  assert.throws(() => deriveAuthority(
    [{ ...authorityComments.controlSwitch[0], issue_url: null }],
    authorityComments.start,
    authorityComments.registry
  ), /CONTROL_REQUIRED_NO_SEND/);
  await assert.rejects(() => readCurrentAuthority(async (issue) => {
    const values = { 88: authorityComments.controlSwitch, 43: authorityComments.start, 81: authorityComments.registry };
    if (issue === 81) return [{ ...values[issue][0], issue_url: "https://github.com/D22977/gpt-browser-bridge/issues/162" }];
    return values[issue];
  }), /CONTROL_REQUIRED_NO_SEND/);
  const cardFields = {
    state: "AUTHORIZED_BOUNDED_OPERATIONAL_SEND", recorded_by_role: "CONTROL", control_generation: GENERATION,
    active_control_conversation_id: authority.conversationId, repository: REPO, issue: String(ISSUE),
    requested_action: "wake", direction: "A", exact_target_role: "HERDR", target_id: "w2:p1",
    logical_event_id: "evt-1", idempotency_key: "idem-1", operational_capability: "HERDR_SINGLE_PANE_WAKE",
    canary_scope: "issue162-single-event", expires_at: "2099-01-01T00:00:00.000Z"
  };
  const cardRaw = testComment("5725999001", "GBB_G13_WAKE_OPERATIONAL_CARD_V1", cardFields);
  const eventFields = {
    logical_event_id: "evt-1", issue: String(ISSUE), card_or_authority_comment: "5725999001", control_generation: GENERATION,
    active_control_conversation_id: authority.conversationId, direction: "A", requested_action: "wake", wake_at_if_any: "NONE",
    exact_target_role: "HERDR", target_count: "1", target_id: "w2:p1", idempotency_key: "idem-1"
  };
  const eventRaw = testComment("7100", EVENT_MARKER, eventFields);
  const event = parseDurableComment(eventRaw);
  const nestedEvent = parseDurableComment(eventRaw);
  assert.equal(nestedEvent.fields.logical_event_id, "evt-1");
  assert.equal(isAuthorizedGitHubComment(event), true);
  assert.equal(validateEvent(event, authority, [{ role: "HERDR", id: "w2:p1" }]).ok, true);
  assert.equal(validateEvent({ ...event, issue_number: "43" }, authority, [{ role: "HERDR", id: "w2:p1" }]).reason, NO_SEND);
  assert.equal(validateEvent({ ...event, author_login: "attacker" }, authority, [{ role: "HERDR", id: "w2:p1" }]).reason, NO_SEND);
  assert.throws(() => latestAuthority([{ id: "7004", issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/162", user: { login: "attacker" }, author_association: "OWNER", body: "CONTROL_GENERATION_SWITCH_V1\nnew_generation=013\nnew_conversation_id=bad\nnew_status=ACTIVE" }], AUTHORITY_MARKERS.controlSwitch, ["new_generation", "new_conversation_id", "new_status"]), /CONTROL_REQUIRED_NO_SEND/);
  assert.equal(prepareInitialLease({ revision: 0, lease: null }, "2026-09-18T00:00:00.000Z", identityForTest("first", "host", 1)).lease.owner_id, "first");
  assert.throws(() => prepareLease({ revision: 1, lease: { owner_id: "other", host: "other", pid: process.pid, expires_at: "2099-01-01T00:00:00.000Z" } }, "2026-09-18T00:00:00.000Z", identityForTest("self", "self", process.pid)), /CONTROL_REQUIRED_SINGLE_INSTANCE/);
  assert.doesNotThrow(() => prepareLease({ revision: 1, lease: { owner_id: "other", host: "other", pid: process.pid, expires_at: "2020-01-01T00:00:00.000Z" } }, "2026-09-18T00:00:00.000Z", identityForTest("self", "self", process.pid)));
  assert.throws(() => renewLease({ lease: { ...identityForTest("self", "self", process.pid), expires_at: "2020-01-01T00:00:00.000Z" } }, "2026-09-18T00:00:00.000Z", identityForTest("self", "self", process.pid)), /CONTROL_REQUIRED_SINGLE_INSTANCE/);

  const sendFields = { ...eventFields, receipt_state: "SEND_ATTEMPTED", actor_type: "HERDR", actor_id: "w2:p1", destination_type: "HERDR", destination_id: "w2:p1", readback_verified: "true" };
  const observationFields = {
    logical_event_id: "evt-1", idempotency_key: "idem-1", actor_type: "HERDR", actor_id: "w2:p1", destination_type: "HERDR", destination_id: "w2:p1",
    readback_verified: "true", transport_producer_id: "herdr-daemon", transport_provenance: "HERDR_LOCAL_OBSERVATION"
  };
  const ackFields = {
    logical_event_id: "evt-1", idempotency_key: "idem-1", actor_type: "HERDR", actor_id: "w2:p1", destination_type: "HERDR", destination_id: "w2:p1",
    readback_verified: "true", transport_producer_id: "herdr-consumer", transport_provenance: "HERDR_LOCAL_ACK"
  };
  const deliveredFields = { ...sendFields, receipt_state: "DELIVERED", independent_observation: "true", durable_ack: "true", observation_id: "obs-1", observation_kind: "INDEPENDENT_DELIVERY", observation_comment_id: "7201", transport_producer_id: "herdr-daemon", transport_provenance: "HERDR_LOCAL_OBSERVATION" };
  const consumedFields = { ...deliveredFields, receipt_state: "CONSUMED", ack_comment_id: "7203", ack_logical_event_id: "evt-1", ack_idempotency_key: "idem-1", ack_actor_type: "HERDR", ack_actor_id: "w2:p1", ack_destination_type: "HERDR", ack_destination_id: "w2:p1", ack_readback_verified: "true" };
  const sendRaw = testComment("7101", RECEIPT_MARKER, sendFields, { created_at: "2026-09-18T00:00:01.000Z" });
  const observationRaw = testComment("7201", OBSERVATION_MARKER, observationFields, { user: { login: "herdr-agent" }, created_at: "2026-09-18T00:00:02.000Z" });
  const deliveredRaw = testComment("7202", RECEIPT_MARKER, deliveredFields, { created_at: "2026-09-18T00:00:03.000Z" });
  const ackRaw = testComment("7203", ACK_MARKER, ackFields, { user: { login: "herdr-consumer" }, created_at: "2026-09-18T00:00:04.000Z" });
  const consumedRaw = testComment("7204", RECEIPT_MARKER, consumedFields, { created_at: "2026-09-18T00:00:05.000Z" });
  const card = parseGitHubRecord(cardRaw);
  const claimed = reconcileEvent(event, {}, authority, [{ role: "HERDR", id: "w2:p1" }], "2026-09-18T00:00:00.000Z", card, config.authorization);
  assert.equal(claimed.record.state, "CLAIMED");
  assert.equal(reconcileEvent(nestedEvent, { "evt-1": claimed.record }, authority, [{ role: "HERDR", id: "w2:p1" }]).outcome, "NO_OP_DUPLICATE");
  assert.equal(reconcileEvent(parseDurableComment(testComment("7104", EVENT_MARKER, { ...eventFields, logical_event_id: "evt-2" })), { "evt-1": claimed.record }, authority, [{ role: "HERDR", id: "w2:p1" }], nowIso(), card, config.authorization).outcome, NO_SEND);
  const badCard = { ...card, author_login: "attacker" };
  assert.equal(validateCardAuthorization(event, authority, badCard, config.authorization).ok, false);
  assert.equal(validateCardAuthorization(event, authority, { ...card, issue_number: "43" }, config.authorization).ok, false);
  const expiredCard = { ...card, fields: { ...card.fields, expires_at: "2020-01-01T00:00:00.000Z" } };
  assert.equal(validateCardAuthorization(event, authority, expiredCard, config.authorization).ok, false);
  const missingCapabilityCard = { ...card, fields: { ...card.fields, operational_capability: "" } };
  assert.equal(validateCardAuthorization(event, authority, missingCapabilityCard, config.authorization).ok, false);
  const wrongCapabilityCard = { ...card, fields: { ...card.fields, operational_capability: "CONTROL_DOORBELL_RETURN" } };
  assert.equal(validateCardAuthorization(event, authority, wrongCapabilityCard, config.authorization).ok, false);
  const everythingScopeCard = { ...card, fields: { ...card.fields, canary_scope: "everything" } };
  assert.equal(validateCardAuthorization(event, authority, everythingScopeCard, config.authorization).ok, false);
  const unboundedScopeCard = { ...card, fields: { ...card.fields, canary_scope: "unbounded" } };
  assert.equal(validateCardAuthorization(event, authority, unboundedScopeCard, config.authorization).ok, false);
  const repairCard = { ...card, marker: "CONTROL_G13_ISSUE162_SEMANTIC_REPAIR_V7_CARD_V1" };
  assert.equal(validateCardAuthorization(event, authority, repairCard, config.authorization).ok, false);
  const claimedRecord = { ...claimed.record, state: TERMINAL_NO_RETRY, source_comment_id: "7100", send_attempted_comment_id: "7101", send_attempted_at: "2026-09-18T00:00:01.000Z" };
  const delivered = parseDurableComment(deliveredRaw);
  assert.equal(validateReceipt({ ...delivered, observation: parseDurableComment(observationRaw) }, authority, claimedRecord, config).ok, true);
  assert.equal(validateReceipt({ ...delivered, issue_number: "43", observation: parseDurableComment(observationRaw) }, authority, claimedRecord, config).ok, false);
  assert.equal(validateReceipt({ ...delivered, observation: { ...parseDurableComment(observationRaw), issue_number: "43" } }, authority, claimedRecord, config).ok, false);
  assert.equal(validateReceipt({ ...delivered, observation: null }, authority, claimedRecord, config).ok, false);
  const samePublisherObservation = { ...parseDurableComment(observationRaw), author_login: OWNER_LOGIN };
  assert.equal(validateReceipt({ ...delivered, observation: samePublisherObservation }, authority, claimedRecord, config).ok, false);
  const samePublisherDelivered = { ...delivered, fields: { ...delivered.fields, transport_producer_id: OWNER_LOGIN, transport_provenance: "OWNER_CONTROL_PUBLICATION" } };
  assert.equal(validateReceipt({ ...samePublisherDelivered, observation: parseDurableComment(observationRaw) }, authority, claimedRecord, config).ok, false);
  const forgedObservation = { ...parseDurableComment(observationRaw), author_login: "unrelated-account" };
  assert.equal(validateReceipt({ ...delivered, observation: forgedObservation }, authority, claimedRecord, config).ok, false);
  const forgedProducerDelivered = { ...delivered, fields: { ...delivered.fields, transport_producer_id: "unrelated-producer", transport_provenance: "HERDR_LOCAL_OBSERVATION" } };
  assert.equal(validateReceipt({ ...forgedProducerDelivered, observation: forgedObservation }, authority, claimedRecord, config).ok, false);
  const consumed = parseDurableComment(consumedRaw);
  const deliveredRecord = { ...claimed.record, state: "DELIVERED", source_comment_id: "7100", send_attempted_comment_id: "7101", send_attempted_at: "2026-09-18T00:00:01.000Z", observation_comment_id: "7201", observation_at: "2026-09-18T00:00:02.000Z", delivered_comment_id: "7202", delivered_at: "2026-09-18T00:00:03.000Z" };
  assert.equal(validateReceipt({ ...consumed, observation: parseDurableComment(observationRaw), acknowledgement: parseDurableComment(ackRaw) }, authority, deliveredRecord, config).ok, true);
  assert.equal(validateReceipt({ ...consumed, observation: parseDurableComment(observationRaw), acknowledgement: parseDurableComment(observationRaw) }, authority, deliveredRecord, config).ok, false);
  assert.equal(validateReceipt({ ...consumed, observation: parseDurableComment(observationRaw), acknowledgement: { ...parseDurableComment(ackRaw), author_login: OWNER_LOGIN } }, authority, deliveredRecord, config).ok, false);
  const forgedAck = { ...parseDurableComment(ackRaw), author_login: "unrelated-account" };
  assert.equal(validateReceipt({ ...consumed, observation: parseDurableComment(observationRaw), acknowledgement: forgedAck }, authority, deliveredRecord, config).ok, false);

  const preplayedDelivered = { ...delivered, observation: parseDurableComment(observationRaw) };
  const noSendAttemptRecord = { ...claimed.record, state: TERMINAL_NO_RETRY, source_comment_id: "7100" };
  assert.equal(reconcileReceipt(preplayedDelivered, noSendAttemptRecord).reason, "CAUSAL_ORDER_VIOLATION");
  const observationBeforeSend = {
    ...delivered,
    fields: { ...delivered.fields, observation_comment_id: "7100" },
    observation: { ...parseDurableComment(observationRaw), comment_id: "7100", created_at: "2026-09-18T00:00:00.500Z" }
  };
  assert.equal(reconcileReceipt(observationBeforeSend, claimedRecord).reason, "CAUSAL_ORDER_VIOLATION");
  const ackBeforeDelivered = {
    ...consumed,
    fields: { ...consumed.fields, ack_comment_id: "7201" },
    acknowledgement: { ...parseDurableComment(ackRaw), comment_id: "7201", created_at: "2026-09-18T00:00:02.500Z" },
    observation: parseDurableComment(observationRaw)
  };
  assert.equal(reconcileReceipt(ackBeforeDelivered, deliveredRecord).reason, "CAUSAL_ORDER_VIOLATION");
  const invertedDeliveredReceipt = { ...delivered, comment_id: "7099", observation: parseDurableComment(observationRaw) };
  assert.equal(reconcileReceipt(invertedDeliveredReceipt, claimedRecord).reason, "CAUSAL_ORDER_VIOLATION");
  const invertedObsReceipt = { ...delivered, fields: { ...delivered.fields, observation_comment_id: "7098" }, observation: { ...parseDurableComment(observationRaw), comment_id: "7098" } };
  assert.equal(reconcileReceipt(invertedObsReceipt, claimedRecord).reason, "CAUSAL_ORDER_VIOLATION");
  const invertedAckReceipt = { ...consumed, fields: { ...consumed.fields, ack_comment_id: "7095" }, acknowledgement: { ...parseDurableComment(ackRaw), comment_id: "7095" }, observation: parseDurableComment(observationRaw) };
  assert.equal(reconcileReceipt(invertedAckReceipt, deliveredRecord).reason, "CAUSAL_ORDER_VIOLATION");

  // H01 tests: duplicate key rejection and V118 acceptance across issues 43, 88, 81
  const dupV117Comment = {
    id: "7005", ...metaFixture(43),
    body: `CURRENT_REHYDRATION_INDEX_V117\ncontrol_generation=013\ncontrol_conversation_id=6aa41339-7b94-83e8-9d24-24de07cf5235\ncontrol_status=ACTIVE\nrelease_authorized=false\nrelease_authorized=false`
  };
  assert.equal(parseAuthorityComment(dupV117Comment, AUTHORITY_MARKERS.start), null);
  const v118Comment = {
    id: "5725452761", ...metaFixture(43),
    body: `CURRENT_REHYDRATION_INDEX_V118\nstate: CURRENT_START_HERE\ncontrol_generation: 013\ncontrol_status: ACTIVE\ncontrol_conversation_id: 6aa41339-7b94-83e8-9d24-24de07cf5235`
  };
  const parsedV118 = parseAuthorityComment(v118Comment, AUTHORITY_MARKERS.start);
  assert.ok(parsedV118);
  assert.equal(parsedV118.fields.control_generation, "013");
  assert.equal(parsedV118.fields.control_conversation_id, "6aa41339-7b94-83e8-9d24-24de07cf5235");
  assert.equal(latestAuthority([v118Comment], AUTHORITY_MARKERS.start, ["control_generation", "control_conversation_id", "control_status"], 43).id, "5725452761");
  const duplicateV119 = {
    id: "5725452762", ...metaFixture(43),
    body: `CURRENT_REHYDRATION_INDEX_V119\ncontrol_generation: 013\ncontrol_conversation_id: 6aa41339-7b94-83e8-b701-f8f664620751\ncontrol_status: ACTIVE\ncontrol_status: ACTIVE`
  };
  assert.throws(() => latestAuthority([v118Comment, duplicateV119], AUTHORITY_MARKERS.start, ["control_generation", "control_conversation_id", "control_status"], 43), /CONTROL_REQUIRED_NO_SEND/);
  const malformedV119 = {
    id: "5725452763", ...metaFixture(43),
    body: `CURRENT_REHYDRATION_INDEX_V119\ncontrol_generation: 013\ncontrol_status: ACTIVE`
  };
  assert.throws(() => latestAuthority([v118Comment, malformedV119], AUTHORITY_MARKERS.start, ["control_generation", "control_conversation_id", "control_status"], 43), /CONTROL_REQUIRED_NO_SEND/);

  assert.equal(validateReturnTarget({ direction: "B", target_id: "old" }, { conversationId: "new" }).ok, false);
  assert.equal(validateReturnTarget({ direction: "B" }, { conversationId: "new" }).ok, false);

  const baseState = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  const memorySnapshots = [];
  let memoryState = JSON.parse(JSON.stringify(baseState));
  let guardRenewals = 0;
  let guardReleases = 0;
  const commentMap = new Map([cardRaw, eventRaw, sendRaw, deliveredRaw, consumedRaw, observationRaw, ackRaw].map((comment) => [String(comment.id), comment]));
  const harness = {
    readConfig: async () => config,
    readState: async () => JSON.parse(JSON.stringify(memoryState)),
    persistState: async (next, revision, identity) => {
      const persisted = await persistState(next, revision, identity, { read: async () => JSON.parse(JSON.stringify(memoryState)), write: async (value) => { memoryState = JSON.parse(JSON.stringify(value)); } });
      memorySnapshots.push(JSON.parse(JSON.stringify(persisted)));
      return persisted;
    },
    acquireGuard: async () => ({ renew: async () => { guardRenewals += 1; }, release: async () => { guardReleases += 1; } }),
    readAuthority: async () => authority,
    readTargets: async () => [{ role: "HERDR", id: "w2:p1" }],
    fetchComments: async () => [eventRaw, sendRaw, observationRaw, deliveredRaw, ackRaw, consumedRaw],
    fetchComment: async (id) => commentMap.get(String(id)),
    now: () => "2026-09-18T00:00:00.000Z",
    identity: identityForTest("harness", "host", process.pid)
  };
  const beforeFiles = (await fs.readdir(ROOT)).sort();
  const pollResult = await pollOnce(harness);
  const afterFiles = (await fs.readdir(ROOT)).sort();
  assert.equal(pollResult.records, 1);
  assert.equal(memoryState.revision, memorySnapshots.length);
  assert.equal(memoryState.records["evt-1"].state, "CONSUMED");
  assert.ok(memorySnapshots.some((snapshot) => snapshot.records["evt-1"]?.state === "CLAIMED"));
  assert.ok(memorySnapshots.some((snapshot) => snapshot.records["evt-1"]?.state === TERMINAL_NO_RETRY));
  assert.ok(memorySnapshots.some((snapshot) => snapshot.records["evt-1"]?.state === "DELIVERED"));
  assert.ok(memorySnapshots.some((snapshot) => snapshot.records["evt-1"]?.state === "CONSUMED"));
  assert.equal(Object.keys(memoryState.records).every((key) => key === memoryState.records[key].logical_event_id), true);
  assert.ok(guardRenewals > 0);
  assert.equal(guardReleases, 1);

  const mutexName = `Local\\GBB_G13_SELFTEST_${process.pid}_${Date.now()}`;
  const guardA = await acquireSingletonGuard({ mutexName, timeoutMs: 3000 });
  await assert.rejects(() => acquireSingletonGuard({ mutexName, timeoutMs: 1000 }), /CONTROL_REQUIRED_SINGLE_INSTANCE/);
  await guardA.renew();
  await guardA.release();
  const guardB = await acquireSingletonGuard({ mutexName, timeoutMs: 3000 });
  await guardB.release();

  const retained = { last_claimed_event_id: "old", last_delivered_event_id: "old", last_consumed_event_id: "old" };
  heartbeat(retained, authority, identityForTest("test", "test", 1), "2026-09-18T00:00:00.000Z", { newer: { logical_event_id: "newer", claimed_at: "2026-09-18T00:00:01.000Z", delivered_at: "2026-09-18T00:00:02.000Z", consumed_at: "2026-09-18T00:00:03.000Z", updated_at: "2026-09-18T00:00:03.000Z" } });
  assert.equal(retained.last_consumed_event_id, "newer");
  assert.deepEqual(afterFiles, beforeFiles);
  assert.equal(/watcher\.log|state\.json\.\$\{process\.pid\}|\.tmp/.test(readFileSync(path.join(ROOT, "run.ps1"), "utf8")), false);
  assert.equal(afterFiles.some((name) => /\.tmp$|watcher\.log$|state\.json\.\d+/.test(name)), false);
  assert.deepEqual({ physical_send_count: pollResult.physical_send_count, browser_send_count: pollResult.browser_send_count, process_mutation_count: pollResult.process_mutation_count, task_mutation_count: pollResult.task_mutation_count, workflow_dispatch_count: pollResult.workflow_dispatch_count }, { physical_send_count: 0, browser_send_count: 0, process_mutation_count: 0, task_mutation_count: 0, workflow_dispatch_count: 0 });
  assert.equal(parseDurableComment(sendRaw).fields.receipt_state, "SEND_ATTEMPTED");
  console.log(JSON.stringify({ marker: "G13_SELF_TEST_PASS", real_initial_poll_lease_acquisition: true, semantic_persistence_snapshots: memorySnapshots.length, live_contention: true, guard_renewals: guardRenewals, side_effect_counters: { physical_send_count: 0, browser_send_count: 0, process_mutation_count: 0, task_mutation_count: 0, workflow_dispatch_count: 0 } }));
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
  selfTest().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
