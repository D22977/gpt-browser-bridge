import { createHash } from "node:crypto";

function fail(code) { throw new Error(code); }
function need(value, name) {
  if (typeof value !== "string" || !value.trim()) fail(`MALFORMED_${name}`);
  return value;
}
function instant(value, name) {
  need(value, name);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail(`MALFORMED_${name}`);
  return ms;
}
function id(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function authorityCheck(authority) {
  if (!authority || authority.switch_conflict !== false) fail("AUTHORITY_CONFLICT_OR_MALFORMED");
  for (const field of ["control_generation", "active_control_conversation_id", "current_start_receipt", "current_registry_receipt", "active_switch_receipt"]) need(authority[field], `AUTHORITY_${field}`);
  return authority;
}
function exact(actual, expected) {
  return Object.entries(expected).every(([key, value]) => JSON.stringify(actual?.[key]) === JSON.stringify(value));
}
async function readback(github, receipt) {
  const item = await github.getReceipt(receipt.github_comment_id);
  const { github_comment_id, ...fields } = receipt;
  if (!item || !exact(item, fields) || String(item.github_comment_id) !== String(github_comment_id)) fail("RECEIPT_READBACK_MISMATCH");
  return item;
}
async function publish(github, receipt) {
  const commentId = await github.publishReceipt(receipt);
  if (!commentId) fail("RECEIPT_PUBLICATION_UNCONFIRMED");
  return readback(github, { ...receipt, github_comment_id: String(commentId) });
}
async function confirmAuthority(github, authority) {
  const current = authorityCheck(await github.readAuthority());
  if (!exact(current, authority)) fail("AUTHORITY_CHANGED");
}

export function createLease(input) {
  for (const field of ["resident_instance_id", "control_generation", "active_control_conversation_id", "trigger_contract_hash"]) need(input?.[field], field);
  const acquired = instant(input.acquired_at, "acquired_at");
  const expires = instant(input.expires_at, "expires_at");
  if (expires <= acquired) fail("MALFORMED_LEASE_INTERVAL");
  if (!Array.isArray(input.watched_issue_set) || !input.watched_issue_set.length) fail("MALFORMED_WATCHED_ISSUE_SET");
  const watched = [...new Set(input.watched_issue_set.map((value) => need(value, "watched_issue")))].sort();
  const leaseId = id([input.control_generation, input.active_control_conversation_id, input.trigger_contract_hash, input.resident_instance_id, watched]);
  return {
    type: "LOCAL_CONTROL_RESIDENT_LEASE_V1",
    lease_id: leaseId,
    resident_instance_id: input.resident_instance_id,
    control_generation: input.control_generation,
    active_control_conversation_id: input.active_control_conversation_id,
    acquired_at: input.acquired_at,
    expires_at: input.expires_at,
    watched_issue_set: watched,
    trigger_contract_hash: input.trigger_contract_hash,
    idempotency_key: `lease:${leaseId}`,
    readback_required: true,
  };
}

export function validateLease(lease, authority, receipts, now) {
  authorityCheck(authority);
  if (!lease || lease.type !== "LOCAL_CONTROL_RESIDENT_LEASE_V1" || lease.readback_required !== true) fail("MALFORMED_LEASE");
  for (const field of ["lease_id", "resident_instance_id", "control_generation", "active_control_conversation_id", "trigger_contract_hash", "idempotency_key"]) need(lease[field], `LEASE_${field}`);
  if (!Array.isArray(lease.watched_issue_set) || !lease.watched_issue_set.length) fail("MALFORMED_LEASE");
  const current = instant(now, "now");
  const acquired = instant(lease.acquired_at, "acquired_at");
  const expires = instant(lease.expires_at, "expires_at");
  if (lease.control_generation !== authority.control_generation || lease.active_control_conversation_id !== authority.active_control_conversation_id) fail("STALE_GENERATION_OR_CONTROL_IDENTITY");
  if (acquired > current || expires <= current || expires <= acquired) fail("EXPIRED_LEASE");
  if (lease.idempotency_key !== `lease:${lease.lease_id}` || createLease(lease).lease_id !== lease.lease_id) fail("MALFORMED_LEASE_IDENTITY");
  const { github_comment_id: _commentId, ...leaseFields } = lease;
  const relevant = (receipts || []).filter((other) =>
    other?.type === "LOCAL_CONTROL_RESIDENT_LEASE_V1" &&
    other.control_generation === authority.control_generation &&
    other.trigger_contract_hash === lease.trigger_contract_hash);
  for (const other of relevant) {
    instant(other.acquired_at, "lease_acquired_at");
    if (instant(other.expires_at, "lease_expires_at") > current && !exact(other, leaseFields)) fail("CONFLICTING_LEASE");
  }
  return lease;
}

export function createHeartbeat(input) {
  for (const field of ["lease_id", "resident_instance_id", "control_generation", "trigger_contract_hash"]) need(input?.[field], field);
  instant(input.observed_at, "observed_at");
  instant(input.lease_expires_at, "lease_expires_at");
  need(input.last_processed_comment_id, "last_processed_comment_id");
  return { ...input, type: "LOCAL_CONTROL_RESIDENT_HEARTBEAT_V1" };
}

export function watcherRunning(heartbeat, lease, authority, now, maxAgeMs) {
  try {
    validateLease(lease, authority, [lease], now);
    if (!heartbeat || heartbeat.type !== "LOCAL_CONTROL_RESIDENT_HEARTBEAT_V1") return false;
    for (const field of ["lease_id", "resident_instance_id", "control_generation", "trigger_contract_hash"]) {
      if (heartbeat[field] !== lease[field]) return false;
    }
    if (heartbeat.lease_expires_at !== lease.expires_at || !heartbeat.last_processed_comment_id) return false;
    const observed = instant(heartbeat.observed_at, "observed_at");
    if (observed < instant(lease.acquired_at, "acquired_at") || observed >= instant(lease.expires_at, "expires_at")) return false;
    const age = instant(now, "now") - observed;
    return Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && age >= 0 && age <= maxAgeMs;
  } catch { return false; }
}

export function createWakeRequest(source, lease) {
  for (const field of ["source_repo", "source_comment_id", "source_event_type", "control_generation", "active_control_conversation_id"]) need(source?.[field], field);
  if (!Number.isSafeInteger(source.source_issue) || source.source_issue <= 0) fail("MALFORMED_SOURCE_ISSUE");
  if (source.source_event_type === "TERMINAL" || source.source_event_type === "CONTROL_NEEDED") need(source.named_executor, "NAMED_EXECUTOR");
  if (source.control_generation !== lease.control_generation || source.active_control_conversation_id !== lease.active_control_conversation_id) fail("STALE_GENERATION_OR_CONTROL_IDENTITY");
  const wakeId = id([source.source_repo, source.source_issue, source.source_comment_id, source.source_event_type, source.control_generation, lease.trigger_contract_hash]);
  return {
    type: "LOCAL_CONTROL_WAKE_REQUEST_V1",
    wake_request_id: wakeId,
    lease_id: lease.lease_id,
    resident_instance_id: lease.resident_instance_id,
    source_repo: source.source_repo,
    source_issue: source.source_issue,
    source_comment_id: source.source_comment_id,
    source_event_type: source.source_event_type,
    control_generation: source.control_generation,
    active_control_conversation_id: source.active_control_conversation_id,
    trigger_contract_hash: lease.trigger_contract_hash,
    idempotency_key: `wake:${wakeId}`,
  };
}

export function verifyAck(ack, request, authority) {
  authorityCheck(authority);
  if (!ack || ack.type !== "ACTIVE_CONTROL_WAKE_ACK_V1") fail("ACK_BINDING_MISMATCH");
  const expected = {
    wake_request_id: request.wake_request_id,
    source_comment_id: request.source_comment_id,
    control_generation: authority.control_generation,
    active_control_conversation_id: authority.active_control_conversation_id,
    rehydrated_current_start_receipt: authority.current_start_receipt,
    rehydrated_current_registry_receipt: authority.current_registry_receipt,
    rehydrated_active_switch_receipt: authority.active_switch_receipt,
  };
  if (!exact(ack, expected) || !ack.ack_idempotency_key) fail("ACK_BINDING_MISMATCH");
  return true;
}

export async function runOnce(args) { return processOnce(args); }

async function processOnce({ github, transport, residentInstanceId, triggerContractHash, now }, afterSourceId) {
  need(residentInstanceId, "resident_instance_id");
  need(triggerContractHash, "trigger_contract_hash");
  const authority = authorityCheck(await github.readAuthority());
  const receipts = await github.listReceipts();
  if (!Array.isArray(receipts)) fail("MALFORMED_GITHUB_RECEIPTS");
  const relevantLeases = receipts.filter((r) => r.type === "LOCAL_CONTROL_RESIDENT_LEASE_V1" && r.control_generation === authority.control_generation && r.trigger_contract_hash === triggerContractHash);
  const candidates = relevantLeases.filter((r) => instant(r.expires_at, "lease_expires_at") > instant(now, "now"));
  if (candidates.length !== 1) fail(candidates.length ? "CONFLICTING_LEASE" : "NO_CURRENT_LEASE");
  const lease = validateLease(candidates[0], authority, receipts, now);
  if (lease.resident_instance_id !== residentInstanceId) fail("LEASE_OWNER_MISMATCH");
  await readback(github, lease);
  const events = await github.listSourceEvents();
  if (!Array.isArray(events)) fail("MALFORMED_SOURCE_EVENTS");
  const ordered = [...events].filter((event) => afterSourceId === undefined || BigInt(event.source_comment_id) > BigInt(afterSourceId)).sort((a, b) => BigInt(a.source_comment_id) < BigInt(b.source_comment_id) ? -1 : 1);
  const source = ordered[0];
  if (!source) return { state: "NO_SOURCE_EVENT" };
  if (source.control_generation !== authority.control_generation || source.active_control_conversation_id !== authority.active_control_conversation_id) fail("STALE_GENERATION_OR_CONTROL_IDENTITY");
  if (!lease.watched_issue_set.includes(`${source.source_repo}#${source.source_issue}`)) fail("SOURCE_NOT_WATCHED");
  const expected = createWakeRequest(source, lease);
  const matches = receipts.filter((r) => r.type === expected.type && (r.wake_request_id === expected.wake_request_id || (r.source_repo === source.source_repo && r.source_issue === source.source_issue && r.source_comment_id === source.source_comment_id)));
  if (matches.some((r) => !exact(r, expected)) || matches.length > 1) fail("CONFLICTING_WAKE_REQUEST");
  let request = matches[0];
  let diagnostic;
  if (request) {
    await readback(github, request);
  } else {
    request = await publish(github, expected);
    const after = (await github.listReceipts()).filter((r) => r.type === expected.type && r.wake_request_id === expected.wake_request_id);
    const { github_comment_id, ...fields } = request;
    if (after.length !== 1 || String(after[0].github_comment_id) !== String(github_comment_id) || !exact(after[0], fields)) fail("CONFLICTING_WAKE_REQUEST");
    await confirmAuthority(github, authority);
    try {
      diagnostic = await transport?.({ source_repo: source.source_repo, source_issue: source.source_issue, source_comment_id: source.source_comment_id, wake_request_comment_id: request.github_comment_id });
    } catch { diagnostic = "ERROR"; }
  }
  const ackCandidates = receipts.filter((r) => r.type === "ACTIVE_CONTROL_WAKE_ACK_V1" && (r.wake_request_id === request.wake_request_id || r.source_comment_id === source.source_comment_id));
  for (const item of ackCandidates) verifyAck(item, request, authority);
  const uniqueAcks = new Set(ackCandidates.map((r) => r.ack_idempotency_key));
  if (uniqueAcks.size > 1) fail("CONFLICTING_ACK");
  const controlAck = ackCandidates[0];
  if (controlAck) await readback(github, controlAck);
  const terminal = source.source_event_type === "TERMINAL" || source.source_event_type === "CONTROL_NEEDED";
  if (controlAck && terminal) {
    const decisions = receipts.filter((r) => r.type === "ACTIVE_CONTROL_SOURCE_DECISION_V1" && (r.wake_request_id === request.wake_request_id || r.source_comment_id === source.source_comment_id));
    for (const decision of decisions) {
      if (!exact(decision, { wake_request_id: request.wake_request_id, source_comment_id: source.source_comment_id, control_generation: authority.control_generation, active_control_conversation_id: authority.active_control_conversation_id, ack_comment_id: controlAck.github_comment_id, named_executor: source.named_executor }) || !decision.decision_idempotency_key || BigInt(decision.github_comment_id) <= BigInt(controlAck.github_comment_id)) fail("DECISION_BINDING_MISMATCH");
    }
    if (decisions.length > 1) fail("CONFLICTING_DECISION");
    if (decisions[0]) {
      await readback(github, decisions[0]);
      await confirmAuthority(github, authority);
      if (ordered.length > 1) return processOnce({ github, transport, residentInstanceId, triggerContractHash, now }, source.source_comment_id);
      return { state: "RELEASED_TO_NAMED_EXECUTOR", named_executor: decisions[0].named_executor, wake_request_comment_id: request.github_comment_id, ack_comment_id: controlAck.github_comment_id, decision_comment_id: decisions[0].github_comment_id };
    }
  }
  const semanticState = terminal ? "WAIT_CONTROL_DECISION" : controlAck ? "ACKED" : "WAIT_CONTROL_ACK";
  return { state: (matches.length && !controlAck) || ackCandidates.length > 1 ? "NO_OP_DUPLICATE" : semanticState, semantic_state: semanticState, wake_consumed: Boolean(controlAck), wake_request_comment_id: request.github_comment_id, ...(controlAck ? { ack_comment_id: controlAck.github_comment_id } : {}), ...(diagnostic === undefined ? {} : { transport_diagnostic: diagnostic }) };
}
