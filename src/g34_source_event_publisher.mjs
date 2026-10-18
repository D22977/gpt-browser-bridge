import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { g34Field, githubCommentIdentity, parseG34ReceiptFields, sourceEventSchema } from "./g34_contract.mjs";

const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const eventFields = [
  "marker", "event_id", "control_generation", "active_control_id", "control_conversation_id",
  "event_kind", "source_comment_id", "source_body_sha256", "repository", "card_comment_id",
  "binding_comment_id", "dispatch_comment_id", "claim_comment_id", "claim_acceptance_comment_id", "attempt_id", "lease_id", "lease_generation", "agent_name", "agent_session", "pane",
  "terminal", "cwd", "model", "reasoning_effort", "state", "branch", "base_sha", "head_sha",
  "terminal_comment_id", "start_receipt_comment_id", "review_comment_id", "user_relay_count",
];

function eventBody(event) {
  return eventFields.filter((key) => event[key] !== undefined)
    .map((key) => `${key}=${event[key]}`).join("\n");
}

function requireBoundValue(receipt, binding, key, label = key) {
  const expected = binding[key];
  if (typeof expected !== "string" || !expected || receipt[key] !== expected) {
    throw new Error(`executor receipt ${label} does not match the accepted Worker binding`);
  }
}

function executorReceiptFields(sourceComment) {
  const parsed = parseG34ReceiptFields(sourceComment);
  const keys = [
    "state", "control_generation", "control_conversation_id", "repository", "card_comment_id", "binding_comment_id",
    "dispatch_comment_id", "claim_comment_id", "claim_acceptance_comment_id", "start_receipt_comment_id",
    "attempt_id", "lease_id", "lease_generation", "agent_name", "agent_session", "pane", "terminal", "cwd",
    "model", "reasoning_effort", "branch", "base_sha", "head_sha", "user_relay_count", "review_comment_id",
  ];
  return Object.fromEntries([["marker", parsed.marker], ...keys.map((key) => [
    key, g34Field(parsed, key, ["EXECUTOR_IDENTITY", "EXECUTOR_BINDING", "EXECUTOR", "TICKET", "CLAIM_CHAIN", "RESULT"]),
  ])]);
}

function validateExecutorReceipt({ sourceComment, sourceIssueNumber, sourceRepositoryFullName, eventKind, binding, branch, baseSha, headSha, state, terminalCommentId, reviewCommentId }) {
  const identity = githubCommentIdentity(sourceComment, "source executor comment");
  if (identity.issue_number !== sourceIssueNumber || sourceRepositoryFullName !== "D22977/gpt-browser-bridge") {
    throw new Error("source executor comment is not bound to its exact GitHub issue/repository");
  }
  if (!binding?.worker_author || sourceComment.user?.login !== binding.worker_author) {
    throw new Error("source executor comment author is not the bound Worker");
  }
  const receipt = executorReceiptFields(sourceComment);
  const expectedMarker = eventKind === "WORKER_STARTED"
    ? "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1"
    : "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1";
  if (receipt.marker !== expectedMarker) throw new Error("source executor receipt marker does not match event kind");
  if (receipt.control_generation !== "034" || receipt.control_conversation_id !== binding.control_conversation_id) {
    throw new Error("source executor receipt Control identity does not match its binding");
  }
  requireBoundValue(receipt, binding, "card_comment_id");
  requireBoundValue(receipt, binding, "binding_comment_id");
  requireBoundValue(receipt, binding, "dispatch_comment_id");
  requireBoundValue(receipt, binding, "claim_comment_id");
  requireBoundValue(receipt, binding, "claim_acceptance_comment_id");
  requireBoundValue(receipt, binding, "repository");
  for (const key of [
    "card_comment_id", "binding_comment_id", "dispatch_comment_id", "agent_name",
    "agent_session", "pane", "terminal", "cwd", "model", "reasoning_effort",
  ]) requireBoundValue(receipt, binding, key);
  if (receipt.state !== state || receipt.branch !== branch || receipt.base_sha !== baseSha || receipt.head_sha !== headSha) {
    throw new Error("source executor receipt state or Git binding does not match the requested event");
  }
  if (branch !== binding.branch || baseSha !== binding.base_sha || headSha !== binding.head_sha) {
    throw new Error("event Git binding does not match the accepted Worker binding");
  }
  if (receipt.user_relay_count !== "0") throw new Error("source executor receipt must bind user_relay_count=0");
  requireBoundValue(receipt, binding, "attempt_id");
  requireBoundValue(receipt, binding, "lease_id");
  requireBoundValue(receipt, binding, "lease_generation");
  if (eventKind === "WORKER_STARTED") {
    if (identity.id !== binding.start_comment_id || state !== "CONSUMED_STARTED") {
      throw new Error("start receipt id/state does not match the accepted Worker start chain");
    }
  } else {
    if (identity.id !== String(terminalCommentId ?? "") ||
        receipt.start_receipt_comment_id !== binding.start_comment_id ||
        String(terminalCommentId) !== identity.id) {
      throw new Error("terminal receipt is missing its bound Worker start/result chain");
    }
    if (reviewCommentId && receipt.review_comment_id !== String(reviewCommentId)) {
      throw new Error("terminal receipt review pointer does not match");
    }
  }
  return receipt;
}

export function createSourceEvent({ sourceComment, sourceIssueNumber, sourceRepositoryFullName, eventKind, authority, binding, branch, baseSha, headSha, state, terminalCommentId, reviewCommentId, expectedAuthor }) {
  if (typeof expectedAuthor !== "string" || !expectedAuthor.trim()) throw new Error("expected publisher GitHub author is required");
  const identity = githubCommentIdentity(sourceComment, "source executor comment");
  const receipt = validateExecutorReceipt({
    sourceComment, sourceIssueNumber, sourceRepositoryFullName, eventKind, binding,
    branch, baseSha, headSha, state, terminalCommentId, reviewCommentId,
  });
  const eventId = sha256Hex(JSON.stringify([authority?.control_generation, eventKind, identity.id]));
  const parsed = sourceEventSchema.parse({
    marker: "GITHUB_SOURCE_EVENT_V1",
    event_id: eventId,
    control_generation: authority?.control_generation,
    active_control_id: authority?.active_control_id,
    control_conversation_id: authority?.control_conversation_id,
    event_kind: eventKind,
    source_comment_id: identity.id,
    source_body_sha256: sha256Hex(sourceComment.body),
    repository: receipt.repository,
    card_comment_id: receipt.card_comment_id,
    binding_comment_id: receipt.binding_comment_id,
    dispatch_comment_id: receipt.dispatch_comment_id,
    claim_comment_id: receipt.claim_comment_id,
    claim_acceptance_comment_id: receipt.claim_acceptance_comment_id,
    attempt_id: receipt.attempt_id,
    lease_id: receipt.lease_id,
    lease_generation: receipt.lease_generation,
    agent_name: receipt.agent_name,
    agent_session: receipt.agent_session,
    pane: receipt.pane,
    terminal: receipt.terminal,
    cwd: receipt.cwd,
    model: receipt.model,
    reasoning_effort: receipt.reasoning_effort,
    state: receipt.state,
    branch: receipt.branch,
    base_sha: receipt.base_sha,
    head_sha: receipt.head_sha,
    ...(terminalCommentId ? { terminal_comment_id: String(terminalCommentId) } : {}),
    ...(receipt.start_receipt_comment_id ? { start_receipt_comment_id: String(receipt.start_receipt_comment_id) } : {}),
    ...(reviewCommentId ? { review_comment_id: String(reviewCommentId) } : {}),
    user_relay_count: 0,
  });
  return {
    ...parsed, body: eventBody(parsed), expected_author: expectedAuthor,
    source_issue_number: sourceIssueNumber, source_repository_full_name: sourceRepositoryFullName,
  };
}

function ledgerPathFor(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || !runtimeRoot.trim()) throw new Error("runtimeRoot is required");
  const root = path.resolve(runtimeRoot);
  const file = path.resolve(root, "events", "g34-source-events.json");
  if (!file.startsWith(root + path.sep)) throw new Error("event ledger escapes runtimeRoot");
  return file;
}

const LEDGER_STATES = new Set([
  "SEEN", "CLAIMED", "SEND_ATTEMPTED", "UNCERTAIN_SEND", "DELIVERED",
  "SUCCESSOR_SEND_ATTEMPTED", "SUCCESSOR_UNCERTAIN", "SUCCESSOR_DELIVERED", "CONSUMED",
]);

async function readLedger(file) {
  try {
    const ledger = JSON.parse(await readFile(file, "utf8"));
    if (!ledger || Array.isArray(ledger) || typeof ledger !== "object") throw new Error("invalid G34 event ledger");
    for (const [eventId, entry] of Object.entries(ledger)) {
      if (!/^[0-9a-f]{64}$/.test(eventId) || !entry || typeof entry !== "object" ||
          !LEDGER_STATES.has(entry.state) ||
          !/^[1-9][0-9]*$/.test(String(entry.source_comment_id ?? "")) ||
          (["DELIVERED", "SUCCESSOR_SEND_ATTEMPTED", "SUCCESSOR_UNCERTAIN", "SUCCESSOR_DELIVERED", "CONSUMED"].includes(entry.state) &&
            !/^[1-9][0-9]*$/.test(String(entry.comment_id ?? ""))) ||
          (["SUCCESSOR_SEND_ATTEMPTED", "SUCCESSOR_UNCERTAIN", "SUCCESSOR_DELIVERED", "CONSUMED"].includes(entry.state) &&
            !/^[1-9][0-9]*$/.test(String(entry.control_comment_id ?? ""))) ||
          (["SUCCESSOR_DELIVERED", "CONSUMED"].includes(entry.state) &&
            !/^[1-9][0-9]*$/.test(String(entry.successor_comment_id ?? ""))) ||
          (entry.state === "CONSUMED" &&
            (!/^[1-9][0-9]*$/.test(String(entry.control_comment_id ?? "")) ||
             !/^[1-9][0-9]*$/.test(String(entry.worker_receipt_id ?? ""))))) {
        throw new Error("invalid G34 event ledger entry");
      }
    }
    return ledger;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`cannot read G34 event ledger: ${error.message}`);
  }
}

async function saveLedger(file, ledger) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(ledger, null, 2) + "\n");
}

async function findMatch(event, issueNumber, repositoryFullName, github) {
  const matches = await github.findEventComments({ issueNumber, eventId: event.event_id });
  if (!Array.isArray(matches)) throw new Error("GitHub event lookup returned invalid metadata");
  if (matches.length > 1) throw new Error("DUPLICATE_EVENT: more than one matching GitHub source event");
  if (!matches.length) return null;
  return verifyComment(event, issueNumber, repositoryFullName, matches[0], github);
}

async function verifyComment(event, issueNumber, repositoryFullName, metadata, github) {
  if (!metadata || !/^[1-9][0-9]*$/.test(String(metadata.id ?? ""))) {
    throw new Error("UNCERTAIN_SEND: GitHub event comment has no exact comment id");
  }
  const exact = await github.getIssueComment(String(metadata.id));
  const identity = githubCommentIdentity(exact, "source event comment");
  if (
    identity.id !== String(metadata.id) || identity.issue_number !== issueNumber ||
    exact.user?.login !== event.expected_author || exact.body !== event.body ||
    !exact.body.includes(`event_id=${event.event_id}`) ||
    !exact.body.includes(`source_comment_id=${event.source_comment_id}`) ||
    !exact.body.includes(`source_body_sha256=${event.source_body_sha256}`) ||
    event.repository !== repositoryFullName
  ) throw new Error("UNCERTAIN_SEND: exact GitHub event metadata/body read-back mismatch");
  return exact;
}

export async function publishSourceEvent({ event, issueNumber, runtimeRoot, github, repositoryFullName = "D22977/gpt-browser-bridge" }) {
  const { body, expected_author: expectedAuthor, source_issue_number: sourceIssueNumber, source_repository_full_name: sourceRepositoryFullName, ...fields } = event ?? {};
  const validated = sourceEventSchema.parse(fields);
  if (typeof body !== "string" || body !== eventBody(validated) || !expectedAuthor ||
      sourceIssueNumber !== issueNumber || sourceRepositoryFullName !== repositoryFullName) {
    throw new Error("source event body and expected author are required");
  }
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("valid issueNumber is required");
  for (const method of ["findEventComments", "createIssueComment", "getIssueComment"]) {
    if (typeof github?.[method] !== "function") throw new Error(`GitHub client is missing ${method}`);
  }

  const file = ledgerPathFor(runtimeRoot);
  const ledger = await readLedger(file);
  const prior = ledger[validated.event_id];
  if (prior && prior.source_comment_id !== validated.source_comment_id) {
    throw new Error("DUPLICATE_EVENT: event id is bound to another source comment");
  }

  if (prior?.state === "SEND_ATTEMPTED" || prior?.state === "UNCERTAIN_SEND") {
    let exact;
    try {
      exact = await findMatch({ ...validated, body, expected_author: expectedAuthor }, issueNumber, repositoryFullName, github);
    } catch (error) {
      if (error.message.startsWith("DUPLICATE_EVENT:")) throw error;
    }
    if (exact) {
      ledger[validated.event_id] = { ...prior, state: "DELIVERED", comment_id: String(exact.id) };
      await saveLedger(file, ledger);
      return { state: "NO_OP", comment_id: String(exact.id) };
    }
    ledger[validated.event_id] = { ...prior, state: "UNCERTAIN_SEND" };
    await saveLedger(file, ledger);
    return { state: "UNCERTAIN_SEND" };
  }

  if (prior?.state === "DELIVERED" || prior?.state === "SUCCESSOR_SEND_ATTEMPTED" ||
      prior?.state === "SUCCESSOR_UNCERTAIN" || prior?.state === "SUCCESSOR_DELIVERED" || prior?.state === "CONSUMED") {
    const exact = await findMatch({ ...validated, body, expected_author: expectedAuthor }, issueNumber, repositoryFullName, github);
    if (!exact || String(exact.id) !== prior.comment_id) throw new Error("DUPLICATE_EVENT: delivered ledger does not match GitHub");
    return { state: "NO_OP", comment_id: String(exact.id) };
  }

  const existing = await findMatch({ ...validated, body, expected_author: expectedAuthor }, issueNumber, repositoryFullName, github);
  if (existing) {
    ledger[validated.event_id] = { state: "DELIVERED", source_comment_id: validated.source_comment_id, comment_id: String(existing.id) };
    await saveLedger(file, ledger);
    return { state: "NO_OP", comment_id: String(existing.id) };
  }

  ledger[validated.event_id] = { state: "SEEN", source_comment_id: validated.source_comment_id };
  await saveLedger(file, ledger);
  ledger[validated.event_id].state = "CLAIMED";
  await saveLedger(file, ledger);
  ledger[validated.event_id].state = "SEND_ATTEMPTED";
  await saveLedger(file, ledger);
  try {
    const created = await github.createIssueComment(issueNumber, body);
    const exact = await verifyComment({ ...validated, body, expected_author: expectedAuthor }, issueNumber, repositoryFullName, created, github);
    ledger[validated.event_id] = { state: "DELIVERED", source_comment_id: validated.source_comment_id, comment_id: String(exact.id) };
    await saveLedger(file, ledger);
    return { state: "DELIVERED", comment_id: String(exact.id) };
  } catch (error) {
    ledger[validated.event_id].state = "UNCERTAIN_SEND";
    await saveLedger(file, ledger);
    if (error.message.startsWith("DUPLICATE_EVENT:")) throw error;
    throw new Error(`UNCERTAIN_SEND: ${error.message}`);
  }
}

export async function beginSuccessorDelivery({ eventId, sourceCommentId, controlCommentId, successor, runtimeRoot }) {
  const file = ledgerPathFor(runtimeRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const lockFile = file + ".delivery-lock";
  let lock;
  try {
    lock = await open(lockFile, "wx");
  } catch (error) {
    if (error.code === "EEXIST") return { state: "UNCERTAIN_DELIVERY" };
    throw error;
  }
  try {
    const ledger = await readLedger(file);
    const prior = ledger[eventId];
    if (!prior || prior.source_comment_id !== String(sourceCommentId)) {
      throw new Error("successor delivery requires the exact source event");
    }
    if (["SUCCESSOR_SEND_ATTEMPTED", "SUCCESSOR_UNCERTAIN"].includes(prior.state)) {
      return { state: "UNCERTAIN_DELIVERY" };
    }
    if (["SUCCESSOR_DELIVERED", "CONSUMED"].includes(prior.state)) return { state: "NO_OP" };
    if (prior.state !== "DELIVERED") throw new Error("successor delivery requires the exact delivered source event");
    if (!/^[1-9][0-9]*$/.test(String(controlCommentId ?? "")) ||
        !/^[1-9][0-9]*$/.test(String(successor?.comment_id ?? "")) ||
        !/^[1-9][0-9]*$/.test(String(successor?.issue_number ?? ""))) {
      throw new Error("successor delivery must bind exact Control and successor comment identities");
    }
    ledger[eventId] = {
      ...prior,
      state: "SUCCESSOR_SEND_ATTEMPTED",
      control_comment_id: String(controlCommentId),
      successor_comment_id: String(successor.comment_id),
      successor_issue_number: String(successor.issue_number),
      successor_agent_session: successor.agent_session,
      successor_pane: successor.pane,
      successor_terminal: successor.terminal,
      successor_worker_author: successor.worker_author,
    };
    await saveLedger(file, ledger);
    return { state: "SUCCESSOR_SEND_ATTEMPTED" };
  } finally {
    await lock.close();
    await unlink(lockFile).catch(() => {});
  }
}

export async function recordSuccessorDelivery({ eventId, sourceCommentId, delivery, runtimeRoot }) {
  const file = ledgerPathFor(runtimeRoot);
  const ledger = await readLedger(file);
  const prior = ledger[eventId];
  if (!prior || prior.source_comment_id !== String(sourceCommentId) || prior.state !== "SUCCESSOR_SEND_ATTEMPTED") {
    throw new Error("no matching successor delivery attempt is pending");
  }
  if (delivery?.state !== "DELIVERED" || !/^[A-Za-z0-9._:-]{1,200}$/.test(String(delivery.receipt_id ?? "")) ||
      String(delivery.comment_id ?? "") !== prior.successor_comment_id ||
      String(delivery.issue_number ?? "") !== prior.successor_issue_number ||
      String(delivery.agent_session ?? "") !== prior.successor_agent_session ||
      String(delivery.pane ?? "") !== prior.successor_pane ||
      String(delivery.terminal ?? "") !== prior.successor_terminal ||
      String(delivery.worker_author ?? "") !== prior.successor_worker_author) {
    ledger[eventId] = { ...prior, state: "SUCCESSOR_UNCERTAIN" };
    await saveLedger(file, ledger);
    return { state: "UNCERTAIN_DELIVERY" };
  }
  ledger[eventId] = {
    ...prior,
    state: "SUCCESSOR_DELIVERED",
    delivery_receipt_id: String(delivery.receipt_id),
  };
  await saveLedger(file, ledger);
  return { state: "SUCCESSOR_DELIVERED_AWAITING_RECEIPT" };
}

export async function reconcileSuccessorDelivery({ eventId, sourceCommentId, evidence, runtimeRoot }) {
  const file = ledgerPathFor(runtimeRoot);
  const ledger = await readLedger(file);
  const prior = ledger[eventId];
  if (!prior || prior.source_comment_id !== String(sourceCommentId) ||
      !["SUCCESSOR_SEND_ATTEMPTED", "SUCCESSOR_UNCERTAIN"].includes(prior.state)) {
    throw new Error("no uncertain successor delivery exists to reconcile");
  }
  if (evidence?.state !== "DELIVERED" ||
      String(evidence.comment_id ?? "") !== prior.successor_comment_id ||
      String(evidence.issue_number ?? "") !== prior.successor_issue_number ||
      String(evidence.control_comment_id ?? "") !== prior.control_comment_id ||
      String(evidence.agent_session ?? "") !== prior.successor_agent_session ||
      String(evidence.pane ?? "") !== prior.successor_pane ||
      String(evidence.terminal ?? "") !== prior.successor_terminal ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(String(evidence.receipt_id ?? ""))) {
    ledger[eventId] = { ...prior, state: "SUCCESSOR_UNCERTAIN" };
    await saveLedger(file, ledger);
    return { state: "UNCERTAIN_DELIVERY" };
  }
  ledger[eventId] = { ...prior, state: "SUCCESSOR_DELIVERED", delivery_receipt_id: String(evidence.receipt_id) };
  await saveLedger(file, ledger);
  return { state: "SUCCESSOR_DELIVERED_AWAITING_RECEIPT" };
}

export async function markSourceEventConsumed({ eventId, sourceCommentId, controlCommentId, runtimeRoot, workerReceipt, expectedWorkerAuthor, successor, github }) {
  if (typeof github?.getIssueComment !== "function") throw new Error("exact GitHub client is required to verify Worker consumption");
  const file = ledgerPathFor(runtimeRoot);
  const ledger = await readLedger(file);
  const prior = ledger[eventId];
  if (!prior || prior.source_comment_id !== String(sourceCommentId)) {
    throw new Error("cannot consume an unbound source event");
  }
  if (prior.state === "CONSUMED") {
    if (prior.control_comment_id !== String(controlCommentId) || prior.worker_receipt_id !== String(workerReceipt?.id ?? "")) {
      throw new Error("consumed event read-back does not match the exact Worker receipt");
    }
    return { state: "NO_OP" };
  }
  if (prior.state !== "SUCCESSOR_DELIVERED" || prior.control_comment_id !== String(controlCommentId) ||
      !expectedWorkerAuthor || workerReceipt?.user?.login !== expectedWorkerAuthor ||
      !successor || String(successor.comment_id) !== prior.successor_comment_id ||
        String(successor.issue_number) !== prior.successor_issue_number ||
        String(successor.agent_session) !== prior.successor_agent_session ||
        String(successor.pane) !== prior.successor_pane || String(successor.terminal) !== prior.successor_terminal) {
    throw new Error("cannot consume before verified delivery and bound Worker receipt");
  }
  const listedIdentity = githubCommentIdentity(workerReceipt, "listed successor Worker receipt");
  if (listedIdentity.issue_number !== Number(prior.successor_issue_number)) throw new Error("successor Worker receipt issue does not match delivery target");
  const exactWorkerReceipt = await github.getIssueComment(listedIdentity.id);
  const identity = githubCommentIdentity(exactWorkerReceipt, "exact successor Worker receipt");
  if (identity.id !== listedIdentity.id || identity.issue_number !== listedIdentity.issue_number ||
      exactWorkerReceipt.body !== workerReceipt.body || exactWorkerReceipt.user?.login !== workerReceipt.user?.login) {
    throw new Error("successor Worker receipt exact GET differs from its listing");
  }
  if (exactWorkerReceipt.user?.login !== expectedWorkerAuthor) throw new Error("successor Worker receipt author does not match the bound target");
  const receipt = parseG34ReceiptFields(exactWorkerReceipt);
  if (
    identity.issue_number !== Number(prior.successor_issue_number) ||
    receipt.marker !== "GBB_G34_SUCCESSOR_CONSUMED_V1" ||
    receipt.state !== "CONSUMED" ||
    receipt.source_event_id !== eventId ||
    receipt.control_acceptance_comment_id !== String(controlCommentId) ||
    receipt.successor_comment_id !== prior.successor_comment_id ||
    receipt.source_comment_id !== String(sourceCommentId) ||
    receipt.agent_session !== prior.successor_agent_session ||
    receipt.pane !== prior.successor_pane ||
    receipt.terminal !== prior.successor_terminal
  ) throw new Error("successor Worker consumption receipt does not match the accepted delivery");
  ledger[eventId] = {
    ...prior, state: "CONSUMED", worker_receipt_id: identity.id,
  };
  await saveLedger(file, ledger);
  return { state: "CONSUMED" };
}
