import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { parseG34ReceiptFields, parseActiveControlAuthority, sourceEventSchema } from "./g34_contract.mjs";

const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const executorTaskIdentity = (value) => {
  if (typeof value !== "string") return null;
  const match = /^collaboration task (\/[^\s;()]+)(?:\s*(?:\([^()\r\n]*\)|;[^\r\n]*))?$/.exec(value.trim());
  return match?.[1] ?? null;
};
function commentIssueNumber(comment, repositoryFullName) {
  const id = String(comment?.id ?? "");
  if (!/^[1-9][0-9]*$/.test(id)) return null;
  const web = typeof comment.url === "string"
    ? new RegExp(`^https://github\\.com/${repositoryFullName.replace("/", "\\/")}/issues/(\\d+)#issuecomment-(\\d+)$`).exec(comment.url)
    : null;
  const api = typeof comment.issue_url === "string"
    ? new RegExp(`^https://api\\.github\\.com/repos/${repositoryFullName.replace("/", "\\/")}/issues/(\\d+)$`).exec(comment.issue_url)
    : null;
  if (web && web[2] !== id) return null;
  const number = web ? Number(web[1]) : api ? Number(api[1]) : null;
  if (number !== null && comment.issue_number !== undefined && Number(comment.issue_number) !== number) return null;
  return number;
}
const eventFields = [
  "marker", "event_id", "control_generation", "active_control_id", "control_conversation_id",
  "event_kind", "source_comment_id", "source_body_sha256", "card_comment_id",
  "claim_comment_id", "acceptance_comment_id", "binding_comment_id", "dispatch_comment_id", "agent_name", "agent_session", "pane",
  "terminal", "cwd", "model", "reasoning_effort", "state", "branch", "base_sha", "head_sha", "tree_sha",
  "terminal_comment_id", "worker_start_comment_id", "review_comment_id", "user_relay_count",
];

function eventBody(event) {
  return eventFields.filter((key) => event[key] !== undefined)
    .map((key) => `${key}=${event[key]}`).join("\n");
}

export function createSourceEvent({ sourceComment, canonicalReceipt, sourceIssueNumber, sourceRepositoryFullName, eventKind, authority, binding, branch, baseSha, headSha, state, terminalCommentId, reviewCommentId, expectedAuthor }) {
  if (!sourceComment || !/^[1-9][0-9]*$/.test(String(sourceComment.id ?? "")) || typeof sourceComment.body !== "string") {
    throw new Error("source executor comment metadata is required");
  }
  const githubUrl = sourceComment.url;
  const normalized = typeof githubUrl === "string"
    ? new RegExp(`^https://github\\.com/${sourceRepositoryFullName.replace("/", "\\/")}/issues/(\\d+)#issuecomment-(\\d+)$`).exec(githubUrl)
    : null;
  const issueApi = sourceComment.issue_url;
  const apiMatch = typeof issueApi === "string"
    ? new RegExp(`^https://api\\.github\\.com/repos/${sourceRepositoryFullName.replace("/", "\\/")}/issues/(\\d+)$`).exec(issueApi)
    : null;
  const actualIssueNumber = normalized ? Number(normalized[1]) : apiMatch ? Number(apiMatch[1]) : null;
  if (!Number.isInteger(sourceIssueNumber) || sourceIssueNumber < 1 ||
      actualIssueNumber !== sourceIssueNumber ||
      (normalized && normalized[2] !== String(sourceComment.id))) {
    throw new Error("source executor comment is not bound to its exact GitHub issue");
  }
  if (typeof expectedAuthor !== "string" || !expectedAuthor.trim()) throw new Error("expected publisher GitHub author is required");
  const verifiedAuthor = authority?.publisher_login ?? expectedAuthor;
  if (verifiedAuthor !== expectedAuthor) throw new Error("expected publisher is not the verified active Control publisher");
  if (sourceComment.user?.login !== verifiedAuthor) throw new Error("source executor comment has an unrelated GitHub author");
  const receipt = canonicalReceipt ?? parseG34ReceiptFields(sourceComment);
  const expectedMarker = eventKind === "WORKER_STARTED"
    ? "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1"
    : eventKind === "WORKER_TERMINAL_RESULT" ? "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1" : null;
  const receiptHead = receipt.head_sha ?? receipt.remote_commit ?? receipt.local_tested_commit;
  const receiptTreeKeys = eventKind === "WORKER_STARTED"
    ? ["base_tree_sha", "tree_sha"]
    : ["tree_sha", "remote_api_tree", "remote_tree", "local_tested_tree"];
  const declaredTrees = receiptTreeKeys.map((key) => receipt[key]).filter((value) => value !== undefined);
  const receiptTree = declaredTrees[0];
  const exactTree = /^[0-9a-f]{40}$/.test(String(receiptTree ?? "")) &&
    declaredTrees.every((value) => value === receiptTree);
  const optionalTerminalBindingsMatch = [
    ["claim_comment_id", binding?.claim_comment_id],
    ["acceptance_comment_id", binding?.acceptance_comment_id],
    ["binding_comment_id", binding?.binding_comment_id],
    ["dispatch_comment_id", binding?.dispatch_comment_id],
    ["executor_identity", binding?.executor_identity],
    ["user_relay_count", "0"],
  ].every(([key, expected]) => receipt[key] === undefined || receipt[key] === String(expected));
  const commonReceiptMatches = expectedMarker && exactTree && receipt.marker === expectedMarker &&
    receipt.state === state && receipt.branch === branch &&
    receipt.base_sha === baseSha && receiptHead === headSha &&
    (eventKind === "WORKER_STARTED"
      ? receipt.claim_comment_id === String(binding?.claim_comment_id) &&
        receipt.acceptance_comment_id === String(binding?.acceptance_comment_id) &&
        receipt.binding_comment_id === String(binding?.binding_comment_id) &&
        receipt.dispatch_comment_id === String(binding?.dispatch_comment_id) &&
        receipt.executor_identity === binding?.executor_identity && receipt.user_relay_count === "0"
      : optionalTerminalBindingsMatch);
  const startReceiptMatches = eventKind === "WORKER_STARTED" &&
    receipt.card_comment_id === String(binding?.card_comment_id) &&
    receipt.control_generation === String(authority?.control_generation) &&
    receipt.control_conversation_id === String(authority?.control_conversation_id) &&
    receipt.repository === sourceRepositoryFullName &&
    receipt.agent_name === binding?.agent_name && receipt.agent_session === binding?.agent_session &&
    receipt.pane === binding?.pane && receipt.terminal === binding?.terminal && receipt.cwd === binding?.cwd &&
    receipt.model === binding?.model && receipt.reasoning_effort === binding?.reasoning_effort &&
    receipt.lease_id === binding?.lease_id && receipt.attempt_id === binding?.attempt_id;
  const terminalReceiptMatches = eventKind === "WORKER_TERMINAL_RESULT" &&
    receipt.worker_start_comment_id === String(binding?.start_comment_id) &&
    (receipt.lease_id === undefined || receipt.lease_id === binding?.lease_id) &&
    (receipt.attempt_id === undefined || receipt.attempt_id === binding?.attempt_id);
  const receiptMatches = commonReceiptMatches && (startReceiptMatches || terminalReceiptMatches);
  if (!receiptMatches) throw new Error("upstream executor receipt does not match its exact card, binding, state, executor, or branch tuple");
  if (eventKind === "WORKER_TERMINAL_RESULT" &&
      (!binding?.start_comment_id || receipt.worker_start_comment_id !== String(binding.start_comment_id))) {
    throw new Error("terminal result is not linked to its exact Worker start receipt");
  }
  const sourceCommentId = String(sourceComment.id);
  const eventId = sha256Hex(JSON.stringify([authority?.control_generation, eventKind, sourceCommentId]));
  const parsed = sourceEventSchema.parse({
    marker: "GITHUB_SOURCE_EVENT_V1",
    event_id: eventId,
    control_generation: authority?.control_generation,
    active_control_id: authority?.active_control_id,
    control_conversation_id: authority?.control_conversation_id,
    event_kind: eventKind,
    source_comment_id: sourceCommentId,
    source_body_sha256: sha256Hex(sourceComment.body),
    card_comment_id: String(binding?.card_comment_id ?? ""),
    claim_comment_id: String(binding?.claim_comment_id ?? ""),
    acceptance_comment_id: String(binding?.acceptance_comment_id ?? ""),
    binding_comment_id: String(binding?.binding_comment_id ?? ""),
    dispatch_comment_id: String(binding?.dispatch_comment_id ?? ""),
    agent_name: binding?.agent_name,
    agent_session: binding?.agent_session,
    pane: binding?.pane,
    terminal: binding?.terminal,
    cwd: binding?.cwd,
    model: binding?.model,
    reasoning_effort: binding?.reasoning_effort,
    state,
    branch,
    base_sha: baseSha,
    head_sha: headSha,
    tree_sha: receiptTree,
    ...(terminalCommentId ? { terminal_comment_id: String(terminalCommentId) } : {}),
    ...(eventKind === "WORKER_TERMINAL_RESULT" ? { worker_start_comment_id: String(binding.start_comment_id) } : {}),
    ...(reviewCommentId ? { review_comment_id: String(reviewCommentId) } : {}),
    user_relay_count: 0,
  });
  return { ...parsed, body: eventBody(parsed), expected_author: expectedAuthor, source_issue_number: sourceIssueNumber, source_repository_full_name: sourceRepositoryFullName };
}

function ledgerPathFor(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || !runtimeRoot.trim()) throw new Error("runtimeRoot is required");
  const root = path.resolve(runtimeRoot);
  const file = path.resolve(root, "events", "g34-source-events.json");
  if (!file.startsWith(root + path.sep)) throw new Error("event ledger escapes runtimeRoot");
  return file;
}

async function readLedger(file) {
  try {
    const ledger = JSON.parse(await readFile(file, "utf8"));
    if (!ledger || Array.isArray(ledger) || typeof ledger !== "object") throw new Error("invalid G34 event ledger");
    for (const [eventId, entry] of Object.entries(ledger)) {
      if (!/^[0-9a-f]{64}$/.test(eventId) || !entry || typeof entry !== "object" ||
          !["SEEN", "CLAIMED", "SEND_ATTEMPTED", "UNCERTAIN_SEND", "DELIVERED", "SUCCESSOR_SEND_ATTEMPTED", "SUCCESSOR_DELIVERY_UNCERTAIN", "CONSUMED"].includes(entry.state) ||
          !/^[1-9][0-9]*$/.test(String(entry.source_comment_id ?? "")) ||
          (["DELIVERED", "CONSUMED"].includes(entry.state) && !/^[1-9][0-9]*$/.test(String(entry.comment_id ?? ""))) ||
          (entry.state === "CONSUMED" && (!/^[1-9][0-9]*$/.test(String(entry.control_comment_id ?? "")) ||
            !/^[1-9][0-9]*$/.test(String(entry.successor_delivery_receipt_id ?? ""))))) {
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
  if (
    !exact || String(exact.id) !== String(metadata.id) ||
    commentIssueNumber(exact, repositoryFullName) !== issueNumber ||
    exact.user?.login !== event.expected_author || exact.body !== event.body ||
    !exact.body.includes(`event_id=${event.event_id}`) ||
    !exact.body.includes(`source_comment_id=${event.source_comment_id}`) ||
    !exact.body.includes(`source_body_sha256=${event.source_body_sha256}`)
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
      ledger[validated.event_id] = {
        ...prior,
        state: "DELIVERED",
        source_publication_state: "DELIVERED",
        comment_id: String(exact.id),
      };
      await saveLedger(file, ledger);
      return { state: "NO_OP", comment_id: String(exact.id) };
    }
    ledger[validated.event_id] = { ...prior, state: "UNCERTAIN_SEND" };
    await saveLedger(file, ledger);
    return { state: "UNCERTAIN_SEND" };
  }

  if (prior?.state === "DELIVERED" || prior?.state === "CONSUMED") {
    const exact = await findMatch({ ...validated, body, expected_author: expectedAuthor }, issueNumber, repositoryFullName, github);
    if (!exact || String(exact.id) !== prior.comment_id) throw new Error("DUPLICATE_EVENT: delivered ledger does not match GitHub");
    return { state: "NO_OP", comment_id: String(exact.id) };
  }

  if (prior?.state === "SUCCESSOR_SEND_ATTEMPTED" || prior?.state === "SUCCESSOR_DELIVERY_UNCERTAIN") {
    const exact = await findMatch({ ...validated, body, expected_author: expectedAuthor }, issueNumber, repositoryFullName, github);
    if (!exact || String(exact.id) !== String(prior.comment_id)) {
      throw new Error("UNCERTAIN_SUCCESSOR_DELIVERY: source event must retain its pending successor state");
    }
    return { state: "DELIVERY_UNCERTAIN", comment_id: String(exact.id) };
  }

  const existing = await findMatch({ ...validated, body, expected_author: expectedAuthor }, issueNumber, repositoryFullName, github);
  if (existing) {
    ledger[validated.event_id] = {
      state: "DELIVERED",
      source_publication_state: "DELIVERED",
      source_comment_id: validated.source_comment_id,
      comment_id: String(existing.id),
    };
    await saveLedger(file, ledger);
    return { state: "NO_OP", comment_id: String(existing.id) };
  }

  ledger[validated.event_id] = { state: "SEEN", source_comment_id: validated.source_comment_id };
  await saveLedger(file, ledger);
  ledger[validated.event_id].state = "CLAIMED";
  await saveLedger(file, ledger);
  ledger[validated.event_id].state = "SEND_ATTEMPTED";
  await saveLedger(file, ledger);
  let created;
  try {
    created = await github.createIssueComment(issueNumber, body);
    const exact = await verifyComment({ ...validated, body, expected_author: expectedAuthor }, issueNumber, repositoryFullName, created, github);
    ledger[validated.event_id] = {
      state: "DELIVERED",
      source_publication_state: "DELIVERED",
      source_comment_id: validated.source_comment_id,
      comment_id: String(exact.id),
    };
    await saveLedger(file, ledger);
    return { state: "DELIVERED", comment_id: String(exact.id) };
  } catch (error) {
    ledger[validated.event_id].state = "UNCERTAIN_SEND";
    await saveLedger(file, ledger);
    if (error.message.startsWith("DUPLICATE_EVENT:")) throw error;
    throw new Error(`UNCERTAIN_SEND: ${error.message}`);
  }
}

export async function markSourceEventConsumed({ eventId, sourceCommentId, controlCommentId, runtimeRoot }) {
  const file = ledgerPathFor(runtimeRoot);
  const ledger = await readLedger(file);
  const prior = ledger[eventId];
  if (!prior || prior.source_comment_id !== String(sourceCommentId)) {
    throw new Error("cannot consume an unbound source event");
  }
  if (prior.state === "CONSUMED") return { state: "NO_OP" };
  if (prior.state !== "SUCCESSOR_SEND_ATTEMPTED" && prior.state !== "SUCCESSOR_DELIVERY_UNCERTAIN") {
    throw new Error("cannot consume before a recorded successor delivery attempt");
  }
  if (!/^[1-9][0-9]*$/.test(String(controlCommentId ?? "")) ||
      prior.control_comment_id !== String(controlCommentId)) {
    throw new Error("cannot consume with an unbound Control acceptance");
  }
  throw new Error("cannot consume without an exact successor delivery confirmation receipt");
}

export async function readSourceEventPublication({ eventId, sourceCommentId, eventCommentId, runtimeRoot }) {
  const file = ledgerPathFor(runtimeRoot);
  const ledger = await readLedger(file);
  const prior = ledger[eventId];
  if (!prior || prior.source_comment_id !== String(sourceCommentId) ||
      prior.comment_id !== String(eventCommentId)) {
    throw new Error("cannot authorize an unbound source event publication");
  }
  const publicationState = prior.source_publication_state ??
    (prior.state === "DELIVERED" || ["SUCCESSOR_SEND_ATTEMPTED", "SUCCESSOR_DELIVERY_UNCERTAIN", "CONSUMED"].includes(prior.state)
      ? "DELIVERED"
      : null);
  if (publicationState !== "DELIVERED") {
    throw new Error("source event has no verified delivered publication state");
  }
  return {
    state: publicationState,
    source_comment_id: prior.source_comment_id,
    comment_id: prior.comment_id,
  };
}

export async function beginSuccessorDelivery({ eventId, sourceCommentId, eventCommentId, controlCommentId, successorCommentId, deliver, runtimeRoot }) {
  const file = ledgerPathFor(runtimeRoot);
  const ledger = await readLedger(file);
  const prior = ledger[eventId];
  if (!prior || prior.source_comment_id !== String(sourceCommentId) ||
      prior.comment_id !== String(eventCommentId)) throw new Error("cannot deliver an unbound source event successor");
  if (prior.state === "CONSUMED") return { state: "NO_OP" };
  if (["SUCCESSOR_SEND_ATTEMPTED", "SUCCESSOR_DELIVERY_UNCERTAIN"].includes(prior.state)) {
    return { state: "DELIVERY_UNCERTAIN" };
  }
  if (prior.state !== "DELIVERED") throw new Error("cannot deliver a successor for an undelivered source event");
  if (typeof deliver !== "function") throw new Error("bound Worker transport is required");
  ledger[eventId] = {
    ...prior,
    state: "SUCCESSOR_SEND_ATTEMPTED",
    control_comment_id: String(controlCommentId),
    successor_comment_id: String(successorCommentId),
  };
  await saveLedger(file, ledger);
  return { state: "READY_TO_DELIVER" };
}

export async function recordSuccessorDelivery({ eventId, receiptId, event, controlCommentId, successor, github, uncertain, runtimeRoot }) {
  const file = ledgerPathFor(runtimeRoot);
  const ledger = await readLedger(file);
  const prior = ledger[eventId];
  if (!prior || !["SUCCESSOR_SEND_ATTEMPTED", "SUCCESSOR_DELIVERY_UNCERTAIN"].includes(prior.state)) {
    throw new Error("no pending successor delivery attempt to reconcile");
  }
  let exact = null;
  let consumerAckValid = false;
  if (!uncertain && /^[1-9][0-9]*$/.test(String(receiptId ?? "")) && typeof github?.getIssueComment === "function") {
    const id = String(receiptId);
    try {
      const first = await github.getIssueComment(id);
      const second = await github.getIssueComment(id);
      if (first && second && String(first.id) === id && String(second.id) === id &&
          first.url === second.url && first.body === second.body &&
          first.user?.login === "D22977" && second.user?.login === "D22977" &&
          first.url === `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`) {
        exact = parseG34ReceiptFields(second);
        if (exact && event?.event_id === eventId && event.source_repository_full_name === "D22977/gpt-browser-bridge" &&
            String(event.source_issue_number) === "211" && prior.comment_id === String(event?.comment_id ?? "") &&
            prior.source_comment_id === String(event?.source_comment_id ?? "")) {
          const eventCommentId = String(event.comment_id ?? "");
          const eventCommentFirst = await github.getIssueComment(eventCommentId);
          const eventCommentSecond = await github.getIssueComment(eventCommentId);
          const sourceUrl = `https://github.com/${event.source_repository_full_name}/issues/${event.source_issue_number}#issuecomment-${eventCommentId}`;
          const bodyFields = new Map(String(event.body ?? "").split(/\r?\n/).map((line) => {
            const separator = line.indexOf("=");
            return separator < 0 ? ["", ""] : [line.slice(0, separator), line.slice(separator + 1)];
          }));
          const boundFields = [
            "event_id", "control_generation", "active_control_id", "control_conversation_id", "event_kind",
            "source_comment_id", "source_body_sha256", "card_comment_id", "claim_comment_id",
            "acceptance_comment_id", "binding_comment_id", "dispatch_comment_id", "agent_name", "agent_session",
            "pane", "terminal", "cwd", "model", "reasoning_effort", "state", "branch", "base_sha", "head_sha", "tree_sha",
            "terminal_comment_id", "worker_start_comment_id", "review_comment_id", "user_relay_count",
          ];
          const bodyMatchesEvent = /^[0-9a-f]{40}$/.test(String(event.tree_sha ?? "")) &&
            event.body?.startsWith("marker=GITHUB_SOURCE_EVENT_V1\n") &&
            bodyFields.get("tree_sha") === event.tree_sha &&
            boundFields.every((key) => event[key] === undefined || bodyFields.get(key) === String(event[key]));
          if (!eventCommentFirst || !eventCommentSecond || String(eventCommentFirst.id) !== eventCommentId ||
              String(eventCommentSecond.id) !== eventCommentId || eventCommentFirst.url !== sourceUrl ||
              eventCommentSecond.url !== sourceUrl || eventCommentFirst.body !== event.body ||
              eventCommentSecond.body !== event.body || eventCommentFirst.user?.login !== "D22977" ||
              eventCommentSecond.user?.login !== "D22977" || !bodyMatchesEvent) {
            exact = null;
          }
        } else exact = null;
        if (exact && (exact.marker !== "GBB_G34_SUCCESSOR_DELIVERY_RECEIPT_V1" || exact.state !== "DELIVERED" ||
            exact.event_id !== eventId || exact.source_event_comment_id !== String(event?.comment_id ?? "") ||
            exact.control_comment_id !== String(controlCommentId ?? "") || exact.successor_comment_id !== String(successor?.comment_id ?? "") ||
            exact.successor_agent_name !== successor?.agent_name || exact.successor_agent_session !== successor?.agent_session ||
            exact.successor_pane !== successor?.pane || exact.successor_terminal !== successor?.terminal ||
            exact.source_claim_comment_id !== String(event?.claim_comment_id ?? "") ||
            exact.source_acceptance_comment_id !== String(event?.acceptance_comment_id ?? "") ||
            exact.source_binding_comment_id !== String(event?.binding_comment_id ?? "") ||
            exact.source_dispatch_comment_id !== String(event?.dispatch_comment_id ?? "") ||
            exact.source_worker_start_comment_id !== String(event?.worker_start_comment_id ?? event?.source_comment_id ?? "") ||
            exact.control_comment_id !== prior.control_comment_id || exact.successor_comment_id !== prior.successor_comment_id ||
            Number(id) <= Number(controlCommentId))) exact = null;
        if (exact && /^[1-9][0-9]*$/.test(String(exact.consumer_ack_comment_id ?? ""))) {
          const ackId = String(exact.consumer_ack_comment_id);
          const ackFirst = await github.getIssueComment(ackId);
          const ackSecond = await github.getIssueComment(ackId);
          const ackUrl = `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${ackId}`;
          if (ackFirst && ackSecond && String(ackFirst.id) === ackId && String(ackSecond.id) === ackId &&
              ackFirst.url === ackUrl && ackSecond.url === ackUrl && ackFirst.body === ackSecond.body &&
              ackFirst.user?.login === "D22977" && ackSecond.user?.login === "D22977" && Number(ackId) < Number(id)) {
            const ack = parseG34ReceiptFields(ackSecond);
            const readWorker = async (commentId) => {
              if (!/^[1-9][0-9]*$/.test(String(commentId ?? ""))) return null;
              const key = String(commentId);
              const a = await github.getIssueComment(key);
              const b = await github.getIssueComment(key);
              const url = `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${key}`;
              if (!a || !b || String(a.id) !== key || String(b.id) !== key || a.url !== url || b.url !== url ||
                  a.body !== b.body || a.user?.login !== "D22977" || b.user?.login !== "D22977") return null;
              return { ...parseG34ReceiptFields(b), id: key };
            };
            const [claim, accepted, route, dispatch, start, selectedSuccessor, sourceDispatch, sourceStart] = await Promise.all([
              readWorker(ack.claim_comment_id), readWorker(ack.acceptance_comment_id),
              readWorker(ack.binding_comment_id), readWorker(ack.dispatch_comment_id),
              readWorker(ack.worker_start_comment_id),
              readWorker(successor?.comment_id),
              readWorker(event?.dispatch_comment_id),
              readWorker(event?.worker_start_comment_id ?? event?.source_comment_id),
            ]);
            const routeBinding = route?.candidate_binding;
            const controlFirst = await github.getIssueComment(String(controlCommentId));
            const controlSecond = await github.getIssueComment(String(controlCommentId));
            const controlUrl = `https://github.com/D22977/gpt-browser-bridge/issues/88#issuecomment-${controlCommentId}`;
            const control = controlFirst && controlSecond && controlFirst.url === controlUrl &&
              controlSecond.url === controlUrl && String(controlFirst.id) === String(controlCommentId) &&
              String(controlSecond.id) === String(controlCommentId) && controlFirst.body === controlSecond.body &&
              controlFirst.user?.login === "D22977" && controlSecond.user?.login === "D22977"
              ? parseG34ReceiptFields(controlSecond) : {};
            const authorityPointers = typeof github.getCurrentAuthorityRecords === "function"
              ? await github.getCurrentAuthorityRecords() : null;
            const current = {};
            for (const key of ["switchReceipt", "index43", "index81", "rehydrationAck"]) {
              const pointer = authorityPointers?.[key];
              const exactPointer = pointer ? await github.getIssueComment(String(pointer.id)) : null;
              if (!pointer || !exactPointer || String(exactPointer.id) !== String(pointer.id) ||
                  exactPointer.url !== pointer.url || exactPointer.body !== pointer.body ||
                  exactPointer.user?.login !== "D22977") {
                throw new Error("current Control authority pointer exact read failed during CONSUMED validation");
              }
              current[key] = exactPointer;
            }
            const activeAuthority = parseActiveControlAuthority(current);
            const readControlLink = async (commentId) => {
              if (!/^[1-9][0-9]*$/.test(String(commentId ?? ""))) return null;
              const key = String(commentId);
              const [a, b] = await Promise.all([github.getIssueComment(key), github.getIssueComment(key)]);
              const url = `https://github.com/D22977/gpt-browser-bridge/issues/${key === control.adjudication_comment_id ? "211" : control.independent_review_card_issue_number}#issuecomment-${key}`;
              if (!a || !b || String(a.id) !== key || String(b.id) !== key || a.url !== url || b.url !== url ||
                  a.body !== b.body || a.user?.login !== "D22977" || b.user?.login !== "D22977") return null;
              return { ...parseG34ReceiptFields(b), id: key };
            };
            const [adjudication, review] = await Promise.all([
              readControlLink(control.adjudication_comment_id),
              readControlLink(control.independent_review_comment_id),
            ]);
            const sourceBaseSha = event?.base_sha ?? event?.head_sha;
            let reviewerBinding = null;
            let semanticChainValid = false;
            if (review) {
              const cardIssue = await github.getIssue(Number(control.independent_review_card_issue_number));
              const cardFields = cardIssue ? parseG34ReceiptFields(cardIssue) : {};
              reviewerBinding = await readControlLink(cardFields.reviewer_binding_comment_id);
              const workerExecutorIdentity = start?.executor_identity ?? event.executor_identity ?? `collaboration task ${event.agent_name}`;
              const controlIdentityIsWorker = reviewerBinding?.control_task_identity === event.agent_name ||
                reviewerBinding?.control_task_identity === event.agent_session ||
                reviewerBinding?.control_task_identity === workerExecutorIdentity ||
                executorTaskIdentity(workerExecutorIdentity) === reviewerBinding?.control_task_identity;
              semanticChainValid = control.marker === "CONTROL_SUCCESSOR_ACCEPTANCE_V1" &&
                control.state === "SUCCESSOR_ACCEPTED" && control.source_event_id === eventId &&
                control.source_event_comment_id === String(event?.comment_id ?? "") &&
                control.worker_receipt_comment_id === String(event?.source_comment_id ?? "") &&
                control.recorded_by_role === "ACTIVE_CONTROL" &&
                control.control_generation === activeAuthority.control_generation &&
                control.active_control_id === activeAuthority.active_control_id &&
                control.current_switch_comment_id === activeAuthority.record_ids.switch_comment_id &&
                control.current_index43_comment_id === activeAuthority.record_ids.index43_comment_id &&
                control.current_index81_comment_id === activeAuthority.record_ids.index81_comment_id &&
                control.independent_review_decision === "APPROVE" &&
                control.successor_count === "1" &&
                control.successor_comment_id === String(successor?.comment_id ?? "") &&
                control.successor_agent_name === successor?.agent_name &&
                control.successor_agent_session === successor?.agent_session &&
                control.successor_pane === successor?.pane &&
                control.successor_terminal === successor?.terminal &&
                dispatch?.marker === "GBB_211_REVIEW_REMEDIATION_SHIFT_V1" &&
                dispatch.state === "SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES" &&
                dispatch.recorded_by_role === "LOCAL_CONTROL_TOWER" &&
                typeof dispatch.control_task_identity === "string" && dispatch.control_task_identity.trim() !== "" &&
                executorTaskIdentity(dispatch.executor_identity) === successor?.agent_name &&
                Number(cardIssue?.number) === Number(control.independent_review_card_issue_number) &&
                cardFields.candidate_repository === event.source_repository_full_name &&
                cardFields.candidate_branch === event.branch &&
                cardFields.candidate_exact_head_sha === event.head_sha &&
                cardFields.candidate_tree_sha === event.tree_sha &&
                adjudication?.marker === "ACTIVE_CONTROL_ADJUDICATION_V1" && adjudication.state === "ACCEPTED" &&
                adjudication.source_event_id === eventId && adjudication.source_event_comment_id === String(event?.comment_id ?? "") &&
                review.marker === "GBB_G34_FRESH_INDEPENDENT_REVIEW_RESULT_V1" && review.decision === "APPROVE" &&
                review.state === "REVIEW_TERMINAL" && review.reviewer_binding_comment_id === reviewerBinding?.id &&
                review.card === `#${control.independent_review_card_issue_number}` &&
                review.role === "fresh independent GPT-6 Sol High read-only Reviewer" &&
                review.reviewed_repository === event.source_repository_full_name && review.reviewed_branch === event.branch &&
                reviewerBinding?.marker === "GBB_G34_REVIEWER_BINDING_V1" && reviewerBinding.state === "REVIEWER_ASSIGNED" &&
                reviewerBinding.recorded_by_role === "LOCAL_CONTROL_TOWER" &&
                typeof reviewerBinding.control_task_identity === "string" && reviewerBinding.control_task_identity.trim() !== "" &&
                sourceDispatch?.marker === "GBB_211_REVIEW_REMEDIATION_SHIFT_V1" &&
                sourceDispatch.state === "SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES" &&
                sourceDispatch.recorded_by_role === "LOCAL_CONTROL_TOWER" &&
                typeof sourceDispatch.control_task_identity === "string" && sourceDispatch.control_task_identity.trim() !== "" &&
                executorTaskIdentity(sourceDispatch.executor_identity) === event.agent_name &&
                sourceDispatch.branch === event.branch &&
                sourceStart?.marker === "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1" &&
                sourceStart.state === "CONSUMED_STARTED" && sourceStart.card_comment_id === "211" &&
                sourceStart.claim_comment_id === String(event?.claim_comment_id ?? "") &&
                sourceStart.acceptance_comment_id === String(event?.acceptance_comment_id ?? "") &&
                sourceStart.binding_comment_id === String(event?.binding_comment_id ?? "") &&
                sourceStart.dispatch_comment_id === sourceDispatch.id &&
                sourceStart.executor_identity === sourceDispatch.executor_identity &&
                sourceStart.agent_name === event.agent_name && sourceStart.agent_session === event.agent_session &&
                sourceStart.branch === event.branch && sourceStart.base_sha === sourceBaseSha &&
                sourceStart.head_sha === sourceBaseSha && sourceStart.lease_id === sourceDispatch.lease_id &&
                sourceStart.attempt_id === sourceDispatch.attempt_id &&
                sourceDispatch.exact_remote_base_sha === sourceBaseSha && sourceStart.base_sha === sourceDispatch.exact_remote_base_sha &&
                Number(sourceDispatch.id) < Number(sourceStart.id) &&
                reviewerBinding.control_task_identity === sourceDispatch.control_task_identity &&
                !controlIdentityIsWorker &&
                reviewerBinding.worker_task_identity === event.agent_name &&
                reviewerBinding.reviewer_task_identity === review.reviewer_task_identity &&
                reviewerBinding.reviewer_task_identity !== reviewerBinding.control_task_identity &&
                reviewerBinding.reviewer_task_identity !== event.agent_name &&
                reviewerBinding.reviewer_task_identity !== event.agent_session &&
                reviewerBinding.reviewer_task_identity !== workerExecutorIdentity &&
                executorTaskIdentity(workerExecutorIdentity) !== reviewerBinding.reviewer_task_identity &&
                reviewerBinding.role === review.role && reviewerBinding.model === "gpt-6-sol" &&
                reviewerBinding.reasoning_effort === "high" &&
                reviewerBinding.candidate_repository === event.source_repository_full_name &&
                reviewerBinding.candidate_branch === event.branch &&
                reviewerBinding.candidate_exact_head_sha === event.head_sha &&
                reviewerBinding.candidate_tree_sha === cardFields.candidate_tree_sha &&
                reviewerBinding.card_issue_number === String(cardIssue?.number) &&
                reviewerBinding.candidate_tree_sha === event.tree_sha &&
                Number(reviewerBinding.id) < Number(review.id) &&
                reviewerBinding.reviewer_task_identity !== event.agent_name &&
                reviewerBinding.reviewer_task_identity !== event.agent_session &&
                review.reviewed_exact_head === event.head_sha &&
                review.reviewed_tree === cardFields.candidate_tree_sha &&
                Number(event.comment_id) < Number(adjudication.id) && Number(adjudication.id) < Number(review.id) &&
                Number(review.id) < Number(controlCommentId) && Number(controlCommentId) < Number(ackId) && Number(ackId) < Number(id);
            }
            consumerAckValid = semanticChainValid && ack.marker === "GBB_G34_EXECUTOR_CONSUMED_ACK_V1" && ack.state === "CONSUMED_ACK" &&
              ack.card_comment_id === "211" && ack.event_id === eventId &&
              ack.source_event_comment_id === String(event?.comment_id ?? "") &&
              ack.source_claim_comment_id === String(event?.claim_comment_id ?? "") &&
              ack.source_acceptance_comment_id === String(event?.acceptance_comment_id ?? "") &&
              ack.source_binding_comment_id === String(event?.binding_comment_id ?? "") &&
              ack.source_dispatch_comment_id === String(event?.dispatch_comment_id ?? "") &&
              ack.source_worker_start_comment_id === String(event?.worker_start_comment_id ?? event?.source_comment_id ?? "") &&
              ack.worker_start_comment_id === selectedSuccessor?.id &&
              ack.control_comment_id === String(controlCommentId ?? "") &&
              ack.successor_comment_id === String(successor?.comment_id ?? "") &&
              ack.successor_agent_name === successor?.agent_name && ack.agent_name === successor?.agent_name &&
              ack.agent_session === successor?.agent_session && ack.pane === successor?.pane && ack.terminal === successor?.terminal &&
              ack.executor_identity === `collaboration task ${successor?.agent_name}` &&
              claim?.marker === "CLAIM_REQUESTED_V1" && claim.state === "CLAIM_REQUESTED" &&
              accepted?.marker === "CLAIM_ACCEPTED_V1" && accepted.state === "CLAIM_ACCEPTED" &&
              accepted.work_order === "D22977/gpt-browser-bridge#211 / GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1" &&
              String(accepted.accepted_claim ?? "").startsWith(`#211/${claim?.id}`) &&
              executorTaskIdentity(claim.executor_identity) === successor?.agent_name &&
              executorTaskIdentity(accepted.executor_identity) === successor?.agent_name &&
              route?.marker === "GBB_G036_211_CONTROL_ROUTE_AMENDMENT_V1" &&
              route?.state === "ONE_ALTERNATE_LOW_COST_WORKER_ROUTE_AUTHORIZED" &&
              routeBinding?.task_name === successor?.agent_name && routeBinding?.role === "Worker" &&
              dispatch?.marker === "GBB_211_REVIEW_REMEDIATION_SHIFT_V1" &&
              executorTaskIdentity(dispatch.executor_identity) === successor?.agent_name &&
              dispatch.attempt_id === start?.attempt_id && dispatch.lease_id === start?.lease_id &&
              dispatch.branch === start?.branch && dispatch.exact_remote_base_sha === start?.base_sha &&
              dispatch.exact_remote_base_sha === event?.head_sha &&
              start?.marker === "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1" && start.state === "CONSUMED_STARTED" &&
              start.card_comment_id === "211" && start.claim_comment_id === claim?.id &&
              start.acceptance_comment_id === accepted?.id && start.binding_comment_id === route?.id &&
              start.dispatch_comment_id === dispatch?.id && start.agent_name === successor?.agent_name &&
              start.agent_session === successor?.agent_session && start.pane === successor?.pane &&
              start.terminal === successor?.terminal && start.executor_identity === `collaboration task ${successor?.agent_name}` &&
              start.repository === event?.source_repository_full_name && start.branch === event?.branch &&
              start.base_sha === event?.head_sha && start.head_sha === event?.head_sha &&
              (start.source_event_id === undefined || start.source_event_id === eventId) &&
              (start.source_event_comment_id === undefined || start.source_event_comment_id === String(event?.comment_id ?? "")) &&
              selectedSuccessor?.marker === "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1" &&
              selectedSuccessor.state === "CONSUMED_STARTED" &&
              selectedSuccessor.executor_identity === `collaboration task ${successor?.agent_name}` &&
              selectedSuccessor.agent_name === successor?.agent_name &&
              selectedSuccessor.agent_session === successor?.agent_session &&
              selectedSuccessor.base_sha === event?.head_sha && selectedSuccessor.head_sha === event?.head_sha &&
              selectedSuccessor.pane === successor?.pane && selectedSuccessor.terminal === successor?.terminal &&
              selectedSuccessor.claim_comment_id === claim?.id && selectedSuccessor.acceptance_comment_id === accepted?.id &&
              selectedSuccessor.binding_comment_id === route?.id && selectedSuccessor.dispatch_comment_id === dispatch?.id &&
              Number(controlCommentId) < Number(selectedSuccessor?.id) && Number(selectedSuccessor?.id) < Number(ackId) &&
              Number(event?.comment_id) < Number(adjudication?.id) && Number(adjudication?.id) < Number(review?.id) &&
              Number(review?.id) < Number(controlCommentId) &&
              Number(route?.id) < Number(claim?.id) && Number(claim?.id) < Number(accepted?.id) &&
              Number(accepted?.id) < Number(dispatch?.id) && Number(dispatch?.id) < Number(start?.id) &&
              start?.id === selectedSuccessor?.id && Number(start?.id) < Number(ackId) &&
              Number(controlCommentId) < Number(selectedSuccessor?.id);
          }
        }
      }
    } catch { exact = null; }
  }
  if (uncertain || !exact || !consumerAckValid) {
    ledger[eventId] = { ...prior, state: "SUCCESSOR_DELIVERY_UNCERTAIN" };
    await saveLedger(file, ledger);
    return { state: "DELIVERY_UNCERTAIN" };
  }
  ledger[eventId] = {
    ...prior,
    state: "CONSUMED",
    successor_delivery_receipt_id: String(receiptId),
  };
  await saveLedger(file, ledger);
  return { state: "CONSUMED", receipt_id: String(receiptId) };
}
