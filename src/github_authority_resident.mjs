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
function commentNumber(value, name) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return BigInt(value);
  fail(`MALFORMED_${name}`);
}
function commentText(value, name) { return commentNumber(value, name).toString(); }
async function readback(github, receipt) {
  const item = await github.getReceipt(receipt.github_comment_id);
  const { github_comment_id, ...fields } = receipt;
  if (!item || !exact(item, fields) || commentNumber(item.github_comment_id, "RECEIPT_COMMENT_ID") !== commentNumber(github_comment_id, "RECEIPT_COMMENT_ID")) fail("RECEIPT_READBACK_MISMATCH");
  return item;
}
async function publish(github, receipt) {
  const commentId = await github.publishReceipt(receipt);
  if (!commentId) fail("RECEIPT_PUBLICATION_UNCONFIRMED");
  return readback(github, { ...receipt, github_comment_id: commentText(commentId, "RECEIPT_COMMENT_ID") });
}
async function confirmAuthority(github, authority) {
  const current = authorityCheck(await github.readAuthority());
  if (!exact(current, authority)) fail("AUTHORITY_CHANGED");
}
function sourceFields(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) fail("MALFORMED_SOURCE_EVENT");
  const source_issue = source.source_issue;
  if (!Number.isSafeInteger(source_issue) || source_issue <= 0) fail("MALFORMED_SOURCE_ISSUE");
  const fields = {
    source_repo: need(source.source_repo, "SOURCE_REPO"),
    source_issue,
    source_comment_id: commentText(source.source_comment_id, "SOURCE_COMMENT_ID"),
    source_event_type: need(source.source_event_type, "SOURCE_EVENT_TYPE"),
    control_generation: need(source.control_generation, "SOURCE_CONTROL_GENERATION"),
    active_control_conversation_id: need(source.active_control_conversation_id, "SOURCE_CONTROL_IDENTITY"),
  };
  if (fields.source_event_type === "TERMINAL" || fields.source_event_type === "CONTROL_NEEDED") fields.named_executor = need(source.named_executor, "NAMED_EXECUTOR");
  return fields;
}
async function readSource(github, fields) {
  let item;
  try { item = await github.getReceipt(fields.source_comment_id); }
  catch { fail("SOURCE_READBACK_MISMATCH"); }
  let itemId;
  let itemSourceId;
  try {
    itemId = commentText(item?.github_comment_id, "SOURCE_COMMENT_ID");
    itemSourceId = commentText(item?.source_comment_id, "SOURCE_COMMENT_ID");
  }
  catch { fail("SOURCE_READBACK_MISMATCH"); }
  if (itemId !== fields.source_comment_id || itemSourceId !== fields.source_comment_id || !exact({ ...item, source_comment_id: itemSourceId }, fields)) fail("SOURCE_READBACK_MISMATCH");
}
function sourceOutcome(state, source, extra = {}) {
  return { state, source_comment_id: source?.source_comment_id, ...extra };
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

function createExecutorRelease(source, request, ack, decision, authority) {
  const ack_comment_id = commentText(ack.github_comment_id, "ACK_COMMENT_ID");
  const decision_comment_id = commentText(decision.github_comment_id, "DECISION_COMMENT_ID");
  const named_executor = need(decision.named_executor, "NAMED_EXECUTOR");
  const release_id = id([
    request.wake_request_id,
    source.source_repo,
    source.source_issue,
    commentText(source.source_comment_id, "SOURCE_COMMENT_ID"),
    authority.control_generation,
    authority.active_control_conversation_id,
    ack_comment_id,
    need(ack.ack_idempotency_key, "ACK_IDEMPOTENCY_KEY"),
    decision_comment_id,
    need(decision.decision_idempotency_key, "DECISION_IDEMPOTENCY_KEY"),
    named_executor,
  ]);
  return {
    type: "LOCAL_CONTROL_EXECUTOR_RELEASE_V1",
    release_id,
    idempotency_key: `release:${release_id}`,
    wake_request_id: request.wake_request_id,
    source_repo: source.source_repo,
    source_issue: source.source_issue,
    source_comment_id: commentText(source.source_comment_id, "SOURCE_COMMENT_ID"),
    control_generation: authority.control_generation,
    active_control_conversation_id: authority.active_control_conversation_id,
    ack_comment_id,
    decision_comment_id,
    named_executor,
    readback_required: true,
  };
}

function validateExecutorRelease(receipt) {
  try {
    const fields = [
      "type", "release_id", "idempotency_key", "wake_request_id", "source_repo", "source_issue",
      "source_comment_id", "control_generation", "active_control_conversation_id", "ack_comment_id",
      "decision_comment_id", "named_executor", "readback_required", "github_comment_id",
    ];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || Object.keys(receipt).length !== fields.length
      || fields.some((field) => !Object.hasOwn(receipt, field))
      || Object.keys(receipt).some((field) => !fields.includes(field))
      || receipt.type !== "LOCAL_CONTROL_EXECUTOR_RELEASE_V1"
      || !Number.isSafeInteger(receipt.source_issue) || receipt.source_issue <= 0
      || !/^[0-9a-f]{64}$/.test(receipt.release_id)
      || !/^[0-9a-f]{64}$/.test(receipt.wake_request_id)
      || receipt.idempotency_key !== `release:${receipt.release_id}`
      || receipt.readback_required !== true) fail("MALFORMED_EXECUTOR_RELEASE");
    for (const field of ["source_repo", "control_generation", "active_control_conversation_id", "named_executor"]) need(receipt[field], `EXECUTOR_RELEASE_${field}`);
    for (const field of ["source_comment_id", "ack_comment_id", "decision_comment_id", "github_comment_id"]) commentText(receipt[field], `EXECUTOR_RELEASE_${field}`);
  } catch { fail("MALFORMED_EXECUTOR_RELEASE"); }
}

function exactExecutorRelease(receipt, expected) {
  const { github_comment_id, ...fields } = receipt;
  return Object.keys(fields).length === Object.keys(expected).length && exact(fields, expected);
}

function executorReleaseMatches(receipt, expected) {
  return receipt.release_id === expected.release_id
    || receipt.idempotency_key === expected.idempotency_key
    || receipt.wake_request_id === expected.wake_request_id
    || receipt.source_comment_id === expected.source_comment_id;
}

export async function runOnce(args) { return processOnce(args); }

async function processOnce({ github, transport, residentInstanceId, triggerContractHash, now }) {
  need(residentInstanceId, "resident_instance_id");
  need(triggerContractHash, "trigger_contract_hash");
  const authority = authorityCheck(await github.readAuthority());
  let receipts = await github.listReceipts();
  if (!Array.isArray(receipts)) fail("MALFORMED_GITHUB_RECEIPTS");
  for (const receipt of receipts.filter((r) => r.type === "LOCAL_CONTROL_EXECUTOR_RELEASE_V1")) validateExecutorRelease(receipt);
  const relevantLeases = receipts.filter((r) => r.type === "LOCAL_CONTROL_RESIDENT_LEASE_V1" && r.control_generation === authority.control_generation && r.trigger_contract_hash === triggerContractHash);
  const candidates = relevantLeases.filter((r) => instant(r.expires_at, "lease_expires_at") > instant(now, "now"));
  if (candidates.length !== 1) fail(candidates.length ? "CONFLICTING_LEASE" : "NO_CURRENT_LEASE");
  const lease = validateLease(candidates[0], authority, receipts, now);
  if (lease.resident_instance_id !== residentInstanceId) fail("LEASE_OWNER_MISMATCH");
  await readback(github, lease);
  const events = await github.listSourceEvents();
  if (!Array.isArray(events)) fail("MALFORMED_SOURCE_EVENTS");
  const indexed = events.map((source, index) => {
    try { return { source, index, commentId: commentNumber(source?.source_comment_id, "SOURCE_COMMENT_ID") }; }
    catch { return { source, index, error: "MALFORMED_SOURCE_COMMENT_ID" }; }
  });
  const ordered = indexed.filter((item) => !item.error).sort((a, b) => a.commentId < b.commentId ? -1 : a.commentId > b.commentId ? 1 : a.index - b.index);
  const malformed = indexed.filter((item) => item.error);
  const results = [];
  for (const entry of [...ordered, ...malformed]) {
    const source = entry.source;
    if (entry.error) {
      results.push(sourceOutcome(entry.error, source));
      continue;
    }
    let event;
    try {
      const fields = sourceFields(source);
      await readSource(github, fields);
      event = { ...source, ...fields };
    } catch (error) {
      results.push(sourceOutcome(error?.message || "SOURCE_PROCESSING_FAILED", source));
      continue;
    }
    if (event.control_generation !== authority.control_generation || event.active_control_conversation_id !== authority.active_control_conversation_id) {
      results.push(sourceOutcome("STALE_GENERATION_OR_CONTROL_IDENTITY", event));
      continue;
    }
    if (!lease.watched_issue_set.includes(`${event.source_repo}#${event.source_issue}`)) {
      results.push(sourceOutcome("SOURCE_NOT_WATCHED", event));
      continue;
    }
    const expected = createWakeRequest(event, lease);
    const matches = receipts.filter((r) => r.type === expected.type && (r.wake_request_id === expected.wake_request_id || (r.source_repo === event.source_repo && r.source_issue === event.source_issue && r.source_comment_id === event.source_comment_id)));
    if (matches.some((r) => !exact(r, expected)) || matches.length > 1) fail("CONFLICTING_WAKE_REQUEST");
    let request = matches[0];
    let diagnostic;
    if (request) {
      await readback(github, request);
    } else {
      request = await publish(github, expected);
      const afterReceipts = await github.listReceipts();
      const after = afterReceipts.filter((r) => r.type === expected.type && r.wake_request_id === expected.wake_request_id);
      const { github_comment_id, ...fields } = request;
      if (after.length !== 1 || commentNumber(after[0].github_comment_id, "WAKE_REQUEST_COMMENT_ID") !== commentNumber(github_comment_id, "WAKE_REQUEST_COMMENT_ID") || !exact(after[0], fields)) fail("CONFLICTING_WAKE_REQUEST");
      receipts = afterReceipts;
      await confirmAuthority(github, authority);
      try {
        diagnostic = await transport?.({ source_repo: event.source_repo, source_issue: event.source_issue, source_comment_id: event.source_comment_id, wake_request_comment_id: request.github_comment_id });
      } catch { diagnostic = "ERROR"; }
    }
    const ackCandidates = receipts.filter((r) => r.type === "ACTIVE_CONTROL_WAKE_ACK_V1" && (r.wake_request_id === request.wake_request_id || r.source_comment_id === event.source_comment_id));
    for (const item of ackCandidates) verifyAck(item, request, authority);
    const uniqueAcks = new Set(ackCandidates.map((r) => r.ack_idempotency_key));
    if (uniqueAcks.size > 1) fail("CONFLICTING_ACK");
    const controlAck = ackCandidates[0];
    if (controlAck) {
      if (commentNumber(controlAck.github_comment_id, "ACK_COMMENT_ID") <= commentNumber(request.github_comment_id, "WAKE_REQUEST_COMMENT_ID")) fail("ACK_COMMENT_NOT_AFTER_WAKE_REQUEST");
      await readback(github, controlAck);
      await confirmAuthority(github, authority);
    }
    const terminal = event.source_event_type === "TERMINAL" || event.source_event_type === "CONTROL_NEEDED";
    if (controlAck && terminal) {
      const decisions = receipts.filter((r) => r.type === "ACTIVE_CONTROL_SOURCE_DECISION_V1" && (r.wake_request_id === request.wake_request_id || r.source_comment_id === event.source_comment_id));
      for (const decision of decisions) {
        if (!exact(decision, { wake_request_id: request.wake_request_id, source_comment_id: event.source_comment_id, control_generation: authority.control_generation, active_control_conversation_id: authority.active_control_conversation_id, ack_comment_id: controlAck.github_comment_id, named_executor: event.named_executor }) || !decision.decision_idempotency_key || commentNumber(decision.github_comment_id, "DECISION_COMMENT_ID") <= commentNumber(controlAck.github_comment_id, "ACK_COMMENT_ID")) fail("DECISION_BINDING_MISMATCH");
      }
      if (decisions.length > 1) fail("CONFLICTING_DECISION");
      if (decisions[0]) {
        await readback(github, decisions[0]);
        await confirmAuthority(github, authority);
        const expectedRelease = createExecutorRelease(event, request, controlAck, decisions[0], authority);
        const existing = receipts
          .filter((r) => r.type === expectedRelease.type)
          .filter((r) => executorReleaseMatches(r, expectedRelease));
        if (existing.length > 1) fail("CONFLICTING_EXECUTOR_RELEASE");
        if (existing.length === 1 && !exactExecutorRelease(existing[0], expectedRelease)) fail("CONFLICTING_EXECUTOR_RELEASE");
        const duplicate = existing.length === 1;
        const release = duplicate ? await readback(github, existing[0]) : await publish(github, expectedRelease);
        validateExecutorRelease(release);
        if (!exactExecutorRelease(release, expectedRelease)) fail("CONFLICTING_EXECUTOR_RELEASE");
        const afterReceipts = await github.listReceipts();
        if (!Array.isArray(afterReceipts)) fail("MALFORMED_GITHUB_RECEIPTS");
        for (const receipt of afterReceipts.filter((r) => r.type === expectedRelease.type)) validateExecutorRelease(receipt);
        const afterRelease = afterReceipts.filter((r) => r.type === expectedRelease.type).filter((r) => executorReleaseMatches(r, expectedRelease));
        const releaseCommentId = commentText(release.github_comment_id, "EXECUTOR_RELEASE_COMMENT_ID");
        if (afterRelease.length !== 1 || !exactExecutorRelease(afterRelease[0], expectedRelease) || commentNumber(afterRelease[0].github_comment_id, "EXECUTOR_RELEASE_COMMENT_ID") !== commentNumber(releaseCommentId, "EXECUTOR_RELEASE_COMMENT_ID")) fail("CONFLICTING_EXECUTOR_RELEASE");
        receipts = afterReceipts;
        await confirmAuthority(github, authority);
        results.push(sourceOutcome(duplicate ? "NO_OP_DUPLICATE" : "RELEASED_TO_NAMED_EXECUTOR", event, {
          ...(!duplicate ? { named_executor: release.named_executor, wake_request_comment_id: request.github_comment_id, ack_comment_id: controlAck.github_comment_id, decision_comment_id: decisions[0].github_comment_id } : {}),
          release_id: expectedRelease.release_id,
          release_receipt_comment_id: releaseCommentId,
        }));
        continue;
      }
    }
    const semanticState = terminal ? "WAIT_CONTROL_DECISION" : controlAck ? "ACKED" : "WAIT_CONTROL_ACK";
    results.push(sourceOutcome((matches.length && !controlAck) || ackCandidates.length > 1 ? "NO_OP_DUPLICATE" : semanticState, event, { semantic_state: semanticState, wake_consumed: Boolean(controlAck), wake_request_comment_id: request.github_comment_id, ...(controlAck ? { ack_comment_id: controlAck.github_comment_id } : {}), ...(diagnostic === undefined ? {} : { transport_diagnostic: diagnostic }) }));
  }
  return results.length ? { ...results.at(-1), results } : { state: "NO_SOURCE_EVENT", results };
}
