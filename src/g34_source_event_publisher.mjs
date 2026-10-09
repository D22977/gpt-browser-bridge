import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { sourceEventSchema } from "./g34_contract.mjs";

const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const eventFields = [
  "marker", "event_id", "control_generation", "active_control_id", "control_conversation_id",
  "event_kind", "source_comment_id", "source_body_sha256", "card_comment_id",
  "binding_comment_id", "dispatch_comment_id", "agent_name", "agent_session", "pane",
  "terminal", "cwd", "model", "reasoning_effort", "state", "branch", "base_sha", "head_sha",
  "terminal_comment_id", "review_comment_id", "user_relay_count",
];

function eventBody(event) {
  return eventFields.filter((key) => event[key] !== undefined)
    .map((key) => `${key}=${event[key]}`).join("\n");
}

export function createSourceEvent({ sourceComment, sourceIssueNumber, sourceRepositoryFullName, eventKind, authority, binding, branch, baseSha, headSha, state, terminalCommentId, reviewCommentId, expectedAuthor }) {
  if (!sourceComment || !/^[1-9][0-9]*$/.test(String(sourceComment.id ?? "")) || typeof sourceComment.body !== "string") {
    throw new Error("source executor comment metadata is required");
  }
  if (!Number.isInteger(sourceIssueNumber) || sourceIssueNumber < 1 ||
      Number(sourceComment.issue_number) !== sourceIssueNumber ||
      sourceComment.issue_url !== `https://api.github.com/repos/${sourceRepositoryFullName}/issues/${sourceIssueNumber}`) {
    throw new Error("source executor comment is not bound to its exact GitHub issue");
  }
  if (typeof expectedAuthor !== "string" || !expectedAuthor.trim()) throw new Error("expected publisher GitHub author is required");
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
    ...(terminalCommentId ? { terminal_comment_id: String(terminalCommentId) } : {}),
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
          !["SEEN", "CLAIMED", "SEND_ATTEMPTED", "UNCERTAIN_SEND", "DELIVERED", "CONSUMED"].includes(entry.state) ||
          !/^[1-9][0-9]*$/.test(String(entry.source_comment_id ?? "")) ||
          (["DELIVERED", "CONSUMED"].includes(entry.state) && !/^[1-9][0-9]*$/.test(String(entry.comment_id ?? ""))) ||
          (entry.state === "CONSUMED" && !/^[1-9][0-9]*$/.test(String(entry.control_comment_id ?? "")))) {
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
    !exact || String(exact.id) !== String(metadata.id) || Number(exact.issue_number) !== issueNumber ||
    exact.issue_url !== `https://api.github.com/repos/${repositoryFullName}/issues/${issueNumber}` ||
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
      ledger[validated.event_id] = { ...prior, state: "DELIVERED", comment_id: String(exact.id) };
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
  let created;
  try {
    created = await github.createIssueComment(issueNumber, body);
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

export async function markSourceEventConsumed({ eventId, sourceCommentId, controlCommentId, runtimeRoot }) {
  const file = ledgerPathFor(runtimeRoot);
  const ledger = await readLedger(file);
  const prior = ledger[eventId];
  if (!prior || prior.source_comment_id !== String(sourceCommentId)) {
    throw new Error("cannot consume an unbound source event");
  }
  if (prior.state === "CONSUMED") return { state: "NO_OP" };
  if (prior.state !== "DELIVERED" || !/^[1-9][0-9]*$/.test(String(controlCommentId ?? ""))) {
    throw new Error("cannot consume an undelivered event or unbound Control ACK");
  }
  ledger[eventId] = { ...prior, state: "CONSUMED", control_comment_id: String(controlCommentId) };
  await saveLedger(file, ledger);
  return { state: "CONSUMED" };
}
