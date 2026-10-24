import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { parseG34ReceiptFields, parseActiveControlAuthority, sourceEventSchema } from "./g34_contract.mjs";

const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");
function receiptValues(receipt, key) {
  const values = [];
  const visit = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value[key] !== undefined) values.push(value[key]);
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(receipt);
  return values;
}
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

export function sourceEventPayloadBody(event) {
  const payload = Object.fromEntries(eventFields
    .filter((key) => event?.[key] !== undefined)
    .map((key) => [key, event[key]]));
  return eventBody(sourceEventSchema.parse(payload));
}

export async function readCurrentControlAuthority(github, expectedAuthority, phase) {
  if (typeof github?.getIssueComment !== "function" ||
      typeof github?.getCurrentAuthorityRecords !== "function") {
    throw new Error("exact current GitHub Control authority reads are required");
  }
  const liveRecords = await github.getCurrentAuthorityRecords();
  const live = {};
  for (const key of ["switchReceipt", "index43", "index81", "rehydrationAck"]) {
    const pointer = liveRecords?.[key];
    if (!pointer || !/^[1-9][0-9]*$/.test(String(pointer.id ?? ""))) {
      throw new Error("current Control authority pointer set is incomplete");
    }
    const exactPointer = await github.getIssueComment(String(pointer.id));
    if (!exactPointer || String(exactPointer.id) !== String(pointer.id) ||
        exactPointer.url !== pointer.url || exactPointer.body !== pointer.body ||
        exactPointer.user?.login !== pointer.user?.login) {
      throw new Error("current Control authority exact reread mismatch");
    }
    live[key] = exactPointer;
  }
  const liveAuthority = parseActiveControlAuthority(live);
  const expectedRecords = expectedAuthority?.source_records ?? expectedAuthority;
  const expected = parseActiveControlAuthority(expectedRecords);
  const pointerKeys = ["switch_comment_id", "index43_comment_id", "index81_comment_id", "rehydration_ack_comment_id"];
  if (liveAuthority.control_generation !== expected.control_generation ||
      liveAuthority.active_control_id !== expected.active_control_id ||
      pointerKeys.some((key) => liveAuthority.record_ids[key] !== expected.record_ids[key])) {
    throw new Error(`current Control authority changed before ${phase}`);
  }
  return liveAuthority;
}

async function validateSourceEventAuthority(github, currentAuthority, event, expectedAuthor, phase) {
  const liveAuthority = await readCurrentControlAuthority(github, currentAuthority, phase);
  if (event.control_generation !== liveAuthority.control_generation ||
      event.active_control_id !== liveAuthority.active_control_id ||
      event.control_conversation_id !== liveAuthority.control_conversation_id ||
      expectedAuthor !== liveAuthority.publisher_login) {
    throw new Error("source event identity does not match live Control authority");
  }
  return liveAuthority;
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
  const declaredHeads = ["head_sha", "remote_commit", "local_tested_commit"]
    .flatMap((key) => receiptValues(receipt, key));
  const receiptHead = declaredHeads[0];
  const consistentHeads = declaredHeads.every((value) => value === receiptHead);
  const receiptTreeKeys = eventKind === "WORKER_STARTED"
    ? ["base_tree_sha", "tree_sha"]
    : ["tree_sha", "remote_api_tree", "remote_tree", "local_tested_tree"];
  const declaredTrees = receiptTreeKeys.flatMap((key) => receiptValues(receipt, key));
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
  const commonReceiptMatches = expectedMarker && exactTree && consistentHeads && receipt.marker === expectedMarker &&
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

const LEDGER_MUTEX_WAIT_MS = 15_000;

async function acquireLedgerMutex(runtimeRoot) {
  if (process.platform !== "win32") throw new Error("G34 ledger requires the Windows abandoned-mutex lock provider");
  const mutexSuffix = sha256Hex(path.resolve(runtimeRoot).toLocaleLowerCase("en-US"));
  const mutexName = `Global\\GBB-G34-${mutexSuffix}`;
  const quotedName = mutexName.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $name='${quotedName}'; $mutex=[System.Threading.Mutex]::new($false,$name); $held=$false; try { try { $held=$mutex.WaitOne(${LEDGER_MUTEX_WAIT_MS}) } catch [System.Threading.AbandonedMutexException] { $held=$true }; if (-not $held) { [Console]::Out.WriteLine('GBB_LOCK_TIMEOUT'); [Console]::Out.Flush(); exit 2 }; [Console]::Out.WriteLine('GBB_LOCK_ACQUIRED'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }`;
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let acquired = false;
  let releaseStarted = false;
  let closed;
  let resolveClosed;
  const closeSignal = new Promise((resolve) => { resolveClosed = resolve; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  let timer;
  const acquire = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, release) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { lines.close(); child.kill(); reject(error); } else resolve(release);
    };
    lines.on("line", (line) => {
      if (line === "GBB_LOCK_ACQUIRED") {
        acquired = true;
        finish(null, async () => {
          if (closed) return closed;
          releaseStarted = true;
          child.stdin.end("release\n");
          const timer = setTimeout(() => { if (!closed) child.kill(); }, 3000);
          const result = await closeSignal;
          clearTimeout(timer);
          lines.close();
          return result;
        });
      } else if (line === "GBB_LOCK_TIMEOUT") {
        finish(new Error("timed out waiting for exclusive G34 Windows mutex"));
      }
    });
    child.once("error", (error) => finish(new Error(`cannot start G34 mutex provider: ${error.message}`)));
    child.once("close", (code) => {
      closed = { code };
      resolveClosed(closed);
      if (acquired && !releaseStarted) process.exit(70);
      if (!settled) finish(new Error(`G34 mutex provider exited before acquisition (${code}): ${stderr.trim()}`));
    });
    timer = setTimeout(() => {
      child.kill();
      finish(new Error("timed out starting G34 Windows mutex provider"));
    }, LEDGER_MUTEX_WAIT_MS + 10_000);
  });
  return acquire;
}

async function withLedgerLock(runtimeRoot, operation) {
  const file = ledgerPathFor(runtimeRoot);
  const release = await acquireLedgerMutex(runtimeRoot);
  try {
    return await operation(file);
  } finally {
    await release();
  }
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

async function publishSourceEventUnlocked({ event, issueNumber, runtimeRoot, github, currentAuthority, repositoryFullName = "D22977/gpt-browser-bridge" }) {
  const { body, expected_author: expectedAuthor, source_issue_number: sourceIssueNumber, source_repository_full_name: sourceRepositoryFullName, ...fields } = event ?? {};
  const validated = sourceEventSchema.parse(fields);
  if (typeof body !== "string" || body !== sourceEventPayloadBody(event) || body !== eventBody(validated) || !expectedAuthor ||
      sourceIssueNumber !== issueNumber || sourceRepositoryFullName !== repositoryFullName) {
    throw new Error("source event body and expected author are required");
  }
  if (!currentAuthority) throw new Error("exact current Control authority snapshot is required");
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
      await validateSourceEventAuthority(github, currentAuthority, validated, expectedAuthor, "source-event delivery reconciliation");
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
    await validateSourceEventAuthority(github, currentAuthority, validated, expectedAuthor, "source-event duplicate reconciliation");
    return { state: "NO_OP", comment_id: String(exact.id) };
  }

  if (prior?.state === "SUCCESSOR_SEND_ATTEMPTED" || prior?.state === "SUCCESSOR_DELIVERY_UNCERTAIN") {
    const exact = await findMatch({ ...validated, body, expected_author: expectedAuthor }, issueNumber, repositoryFullName, github);
    if (!exact || String(exact.id) !== String(prior.comment_id)) {
      throw new Error("UNCERTAIN_SUCCESSOR_DELIVERY: source event must retain its pending successor state");
    }
    await validateSourceEventAuthority(github, currentAuthority, validated, expectedAuthor, "source-event successor reconciliation");
    return { state: "DELIVERY_UNCERTAIN", comment_id: String(exact.id) };
  }

  const existing = await findMatch({ ...validated, body, expected_author: expectedAuthor }, issueNumber, repositoryFullName, github);
  if (existing) {
    await validateSourceEventAuthority(github, currentAuthority, validated, expectedAuthor, "source-event deduplication");
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
  await validateSourceEventAuthority(github, currentAuthority, validated, expectedAuthor, "source-event GitHub create");
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

export async function publishSourceEvent(args) {
  const { event, issueNumber, github, repositoryFullName = "D22977/gpt-browser-bridge" } = args ?? {};
  const { expected_author: expectedAuthor, source_issue_number: sourceIssueNumber,
    source_repository_full_name: sourceRepositoryFullName } = event ?? {};
  const validated = sourceEventSchema.parse(Object.fromEntries(eventFields
    .filter((key) => event?.[key] !== undefined)
    .map((key) => [key, event[key]])));
  const deterministicEventId = sha256Hex(JSON.stringify([
    validated.control_generation, validated.event_kind, validated.source_comment_id,
  ]));
  if (validated.event_id !== deterministicEventId) throw new Error("source event has a non-deterministic event id");
  if (sourceIssueNumber !== issueNumber || sourceRepositoryFullName !== repositoryFullName ||
      !expectedAuthor || typeof github?.getIssueComment !== "function") {
    throw new Error("exact upstream source comment metadata is required");
  }
  if (!args.currentAuthority) throw new Error("exact current Control authority snapshot is required");
  return withLedgerLock(args.runtimeRoot, async () => {
    const exactSource = await github.getIssueComment(validated.source_comment_id);
    if (!exactSource || String(exactSource.id) !== validated.source_comment_id ||
        commentIssueNumber(exactSource, repositoryFullName) !== sourceIssueNumber ||
        exactSource.user?.login !== expectedAuthor || typeof exactSource.body !== "string" ||
        sha256Hex(exactSource.body) !== validated.source_body_sha256) {
      throw new Error("exact upstream source comment does not match the event identity, issue, repository, author, or body hash");
    }
    const liveAuthority = await readCurrentControlAuthority(github, args.currentAuthority, "source-event reconstruction");
    if (expectedAuthor !== liveAuthority.publisher_login) {
      throw new Error("source event publisher does not match the exact current Control publisher");
    }
    const receipt = parseG34ReceiptFields(exactSource);
    const legacyG22Start = receipt.marker === "GBB_G036_211_WORKER_CONSUMED_STARTED_V1";
    const legacyG22Terminal = receipt.marker === "GBB_G34_WORKER_TERMINAL_RESULT_V1";
    const eventKind = legacyG22Start || receipt.marker === "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1"
      ? "WORKER_STARTED"
      : legacyG22Terminal || receipt.marker === "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1" ? "WORKER_TERMINAL_RESULT" : null;
    if (legacyG22Start || legacyG22Terminal) {
      const reconstructed = await reconstructLegacyG22Event({
        event, receipt, exactSource, github, issueNumber, repositoryFullName, liveAuthority,
        eventKind, isLegacyStart: legacyG22Start,
      });
      if (reconstructed.body !== event.body) throw new Error("source event does not match exact Worker source receipt");
      return publishSourceEventUnlocked(args);
    }
    if (!eventKind || (eventKind === "WORKER_STARTED" && receipt.state !== "CONSUMED_STARTED") ||
        (eventKind === "WORKER_TERMINAL_RESULT" &&
          !(receipt.state === "READY_FOR_FRESH_REVIEW" || /^BLOCKED_[A-Z0-9_]+$/.test(receipt.state ?? "")))) {
      throw new Error("exact source comment is not an allowed Worker start or terminal receipt");
    }
    let bindingReceipt = receipt;
    const receiptHead = receipt.head_sha ?? receipt.remote_commit ?? receipt.local_tested_commit;
    let startComment;
    if (eventKind === "WORKER_TERMINAL_RESULT") {
      const startId = String(receipt.worker_start_comment_id ?? "");
      if (!/^[1-9][0-9]*$/.test(startId) || startId === validated.source_comment_id) {
        throw new Error("terminal source event lacks a distinct exact Worker start receipt");
      }
      startComment = await github.getIssueComment(startId);
      if (!startComment || String(startComment.id) !== startId ||
          commentIssueNumber(startComment, repositoryFullName) !== sourceIssueNumber ||
          startComment.user?.login !== liveAuthority.publisher_login || typeof startComment.body !== "string") {
        throw new Error("terminal source event Worker start is not an exact comment from the active publisher on the same issue");
      }
      bindingReceipt = parseG34ReceiptFields(startComment);
      if (bindingReceipt.marker !== "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1" ||
          bindingReceipt.state !== "CONSUMED_STARTED" || bindingReceipt.branch !== receipt.branch ||
          bindingReceipt.base_sha !== receipt.base_sha) {
        throw new Error("terminal source event does not match its exact Worker start branch or base");
      }
      for (const key of ["card_comment_id", "claim_comment_id", "acceptance_comment_id", "binding_comment_id",
        "dispatch_comment_id", "agent_name", "agent_session", "pane", "terminal", "cwd", "model",
        "reasoning_effort", "executor_identity", "lease_id", "attempt_id"]) {
        if (receipt[key] !== undefined && receipt[key] !== bindingReceipt[key]) {
          throw new Error(`terminal source event ${key} does not match its exact Worker start`);
        }
      }
    }
    if (typeof github.getCommit !== "function") throw new Error("exact Worker base and candidate commit metadata is required");
    const [baseCommit, headCommit] = await Promise.all([
      github.getCommit(receipt.base_sha), github.getCommit(receiptHead),
    ]);
    if (String(baseCommit?.sha) !== receipt.base_sha ||
        String(headCommit?.sha) !== receiptHead ||
        !/^[0-9a-f]{40}$/.test(String(baseCommit?.tree?.sha ?? "")) ||
        !/^[0-9a-f]{40}$/.test(String(headCommit?.tree?.sha ?? ""))) {
      throw new Error("exact Worker commit or tree metadata does not match GitHub");
    }
    const assertTreeAliases = (sourceReceipt, keys, exactTree, label) => {
      const aliases = keys.flatMap((key) => receiptValues(sourceReceipt, key));
      if (!aliases.length || aliases.some((tree) => tree !== exactTree)) {
        throw new Error(`exact Worker ${label} tree metadata does not match every source receipt alias`);
      }
    };
    if (eventKind === "WORKER_STARTED") {
      assertTreeAliases(receipt, ["base_tree_sha", "tree_sha"], String(baseCommit.tree.sha), "base");
      assertTreeAliases(receipt, ["base_tree_sha", "tree_sha"], String(headCommit.tree.sha), "candidate");
    } else {
      assertTreeAliases(bindingReceipt, ["base_tree_sha", "tree_sha"], String(baseCommit.tree.sha), "base");
      assertTreeAliases(receipt, ["tree_sha", "remote_tree", "remote_api_tree", "local_tested_tree"], String(headCommit.tree.sha), "candidate");
      const declaredParents = ["remote_parent", "commit_parent", "parent_sha"]
        .flatMap((key) => receiptValues(receipt, key));
      const exactHeadParents = Array.isArray(headCommit.parents)
        ? headCommit.parents.map((parent) => String(parent?.sha ?? ""))
        : [];
      if (exactHeadParents.length !== 1 || !/^[0-9a-f]{40}$/.test(exactHeadParents[0]) ||
          new Set(exactHeadParents).size !== exactHeadParents.length ||
          declaredParents.some((parent) => parent !== exactHeadParents[0])) {
        throw new Error("exact Worker terminal parent metadata is malformed, ambiguous, or does not match its source receipt");
      }
      let ancestorSha = exactHeadParents[0];
      const seenAncestors = new Set([receiptHead]);
      const maxAncestorReads = 64;
      let ancestorReads = 0;
      while (ancestorSha !== receipt.base_sha) {
        if (seenAncestors.has(ancestorSha) || ancestorReads >= maxAncestorReads) {
          throw new Error("exact Worker terminal ancestry is cyclic, unrelated, or exceeds the bounded lookup");
        }
        seenAncestors.add(ancestorSha);
        const ancestorCommit = await github.getCommit(ancestorSha);
        ancestorReads++;
        if (String(ancestorCommit?.sha) !== ancestorSha ||
            !Array.isArray(ancestorCommit?.parents) || ancestorCommit.parents.length !== 1) {
          throw new Error("exact Worker terminal ancestry has malformed or ambiguous parent metadata");
        }
        const parentSha = String(ancestorCommit.parents[0]?.sha ?? "");
        if (!/^[0-9a-f]{40}$/.test(parentSha)) {
          throw new Error("exact Worker terminal ancestry has malformed parent metadata");
        }
        ancestorSha = parentSha;
      }
    }
    const binding = {
      card_comment_id: bindingReceipt.card_comment_id,
      claim_comment_id: bindingReceipt.claim_comment_id,
      acceptance_comment_id: bindingReceipt.acceptance_comment_id,
      binding_comment_id: bindingReceipt.binding_comment_id,
      dispatch_comment_id: bindingReceipt.dispatch_comment_id,
      executor_identity: bindingReceipt.executor_identity,
      agent_name: bindingReceipt.agent_name,
      agent_session: bindingReceipt.agent_session,
      pane: bindingReceipt.pane,
      terminal: bindingReceipt.terminal,
      cwd: bindingReceipt.cwd,
      model: bindingReceipt.model,
      reasoning_effort: bindingReceipt.reasoning_effort,
      lease_id: bindingReceipt.lease_id,
      attempt_id: bindingReceipt.attempt_id,
      ...(startComment ? { start_comment_id: String(startComment.id) } : {}),
    };
    const reconstructed = createSourceEvent({
      sourceComment: exactSource,
      canonicalReceipt: receipt,
      sourceIssueNumber,
      sourceRepositoryFullName,
      eventKind,
      authority: liveAuthority,
      binding,
      branch: receipt.branch,
      baseSha: receipt.base_sha,
      headSha: receiptHead,
      state: receipt.state,
      ...(eventKind === "WORKER_TERMINAL_RESULT" ? { terminalCommentId: String(exactSource.id) } : {}),
      expectedAuthor: liveAuthority.publisher_login,
    });
    if (reconstructed.body !== event.body || reconstructed.expected_author !== expectedAuthor) {
      throw new Error("source event does not match exact Worker source receipt");
    }
    return publishSourceEventUnlocked(args);
  });
}

async function reconstructLegacyG22Event({ event, receipt, exactSource, github, issueNumber, repositoryFullName, liveAuthority, eventKind, isLegacyStart }) {
  const readLinked = async (id, label) => {
    const comment = await github.getIssueComment(String(id));
    if (!comment || String(comment.id) !== String(id) ||
        commentIssueNumber(comment, repositoryFullName) !== issueNumber ||
        comment.user?.login !== liveAuthority.publisher_login || typeof comment.body !== "string") {
      throw new Error(`G22 ${label} is not an exact comment from the active publisher on the source issue`);
    }
    return { comment, fields: parseG34ReceiptFields(comment) };
  };
  const readPointer = (value, exactRead = true) => {
    const match = new RegExp(`^#${issueNumber}/([1-9][0-9]*)${exactRead ? " exact-read" : ""}$`).exec(String(value ?? ""));
    if (!match) throw new Error("G22 Worker start has a malformed exact chain pointer");
    return match[1];
  };
  const startId = isLegacyStart ? String(exactSource.id) : String(event.worker_start_comment_id ?? "");
  if (!/^[1-9][0-9]*$/.test(startId)) throw new Error("G22 terminal source event lacks its exact Worker start pointer");
  const startRecord = isLegacyStart ? { comment: exactSource, fields: receipt } : await readLinked(startId, "Worker start");
  const start = startRecord.fields;
  if (String(startRecord.comment.id) !== startId || start.marker !== "GBB_G036_211_WORKER_CONSUMED_STARTED_V1" ||
      start.state !== "CONSUMED_STARTED" || start.role !== "Worker" || start.repository !== repositoryFullName ||
      start.generation !== "22") throw new Error("G22 Worker start receipt identity or state is invalid");
  const routeId = readPointer(start.route_authority, false);
  const claimId = readPointer(start.claim_requested, true);
  const acceptanceId = readPointer(start.claim_accepted, true);
  const [routeRecord, claimRecord, acceptanceRecord] = await Promise.all([
    readLinked(routeId, "route authority"), readLinked(claimId, "claim"), readLinked(acceptanceId, "acceptance"),
  ]);
  const route = routeRecord.fields;
  const claim = claimRecord.fields;
  const accepted = acceptanceRecord.fields;
  const nextShift = route.new_shift;
  const task = start.task_identity;
  const attempt = start.attempt_id;
  const lease = start.lease_id;
  const branch = nextShift?.branch;
  const base = nextShift?.assigned_base_sha;
  const baseTree = nextShift?.assigned_base_tree;
  const chainChecks = [
    ["route marker", route.marker === "GBB_G036_211_CONTROL_ROUTE_AMENDMENT_G22_V1"],
    ["route state", route.state === "ONE_FRESH_COLLABORATION_GPT6_LUNA_LOW_WORKER_ROUTE_AUTHORIZED"],
    ["route role", route.recorded_by_role === "ACTIVE_CONTROL"],
    ["route repository", route.repository === repositoryFullName],
    ["route work order", route.work_order === `#${issueNumber} / GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1`],
    ["route active Control", /^generation 036 \/ conversation [0-9a-f-]{36}$/i.test(route.active_control ?? "")],
    ["route task", nextShift?.executor_task_identity === task],
    ["route Worker role", nextShift?.role === "Worker"],
    ["route lease", nextShift?.lease_id === lease],
    ["route attempt", nextShift?.attempt_id === attempt],
    ["route model", nextShift?.model_effort === "gpt-6-luna / low"],
    ["claim marker", claim.marker === "GBB_G036_211_WORKER_CLAIM_REQUESTED_V1"],
    ["claim state", claim.state === "CLAIM_REQUESTED"],
    ["claim generation", claim.generation === "22"],
    ["claim role", claim.role === "Worker"],
    ["claim repository", claim.repository === repositoryFullName],
    ["claim task", claim.task_identity === task],
    ["claim attempt", claim.attempt_id === attempt],
    ["claim lease", claim.lease_id === lease],
    ["claim branch", claim.branch === branch],
    ["claim base", claim.assigned_base_sha === base],
    ["claim tree", claim.assigned_base_tree === baseTree],
    ["claim route", claim.route_authority === `#${issueNumber}/${routeId}`],
    ["acceptance marker", accepted.marker === "GBB_G036_211_WORKER_CLAIM_ACCEPTED_V1"],
    ["acceptance state", accepted.state === "CLAIM_ACCEPTED"],
    ["acceptance generation", accepted.control_generation === "036"],
    ["acceptance repository", accepted.repository === repositoryFullName],
    ["acceptance role", accepted.role === "Worker"],
    ["acceptance task", accepted.worker_task_identity === task],
    ["acceptance attempt", accepted.attempt_id === attempt],
    ["acceptance lease", accepted.lease_id === lease],
    ["acceptance branch", accepted.branch === branch],
    ["acceptance base", accepted.assigned_base_sha === base],
    ["acceptance tree", accepted.assigned_base_tree === baseTree],
    ["acceptance claim", accepted.claim_request === `#${issueNumber}/${claimId} exact-read`],
    ["acceptance route", accepted.route_authority === `#${issueNumber}/${routeId} exact-read`],
    ["start task", start.task_identity === task],
    ["start lease", start.lease_id === lease],
    ["start attempt", start.attempt_id === attempt],
    ["start branch", start.branch === branch],
    ["start base", start.base_sha === base],
    ["start tree", start.base_tree === baseTree],
  ];
  const failedChecks = chainChecks.filter(([, passed]) => !passed).map(([name]) => name);
  if (failedChecks.length) throw new Error(`G22 exact Worker route, claim, acceptance, or start chain does not match: ${failedChecks.join(", ")}`);
  const state = isLegacyStart ? "CONSUMED_STARTED" : receipt.state;
  const head = isLegacyStart ? base : receipt.candidate_exact_head_sha;
  const tree = isLegacyStart ? baseTree : receipt.candidate_tree_sha;
  if (!isLegacyStart && (receipt.generation !== "22" || receipt.task_identity !== task ||
      receipt.lease_id !== lease || receipt.candidate_repository !== repositoryFullName ||
      receipt.candidate_branch !== branch || receipt.candidate_base_sha !== base || receipt.commit_parent !== base ||
      !(state === "READY_FOR_FRESH_REVIEW" || /^BLOCKED_[A-Z0-9_]+$/.test(state ?? "")) ||
      String(event.worker_start_comment_id) !== startId)) {
    throw new Error("G22 terminal receipt does not match the exact authenticated Worker start chain");
  }
  const explicitAliases = [
    ["worker_start_comment_id", startId], ["attempt_id", attempt], ["lease_id", lease],
    ["base_sha", base], ["base_tree_sha", baseTree], ["head_sha", head], ["tree_sha", tree],
    ["branch", branch], ["candidate_base_sha", base], ["candidate_branch", branch],
    ["candidate_exact_head_sha", head], ["candidate_tree_sha", tree], ["remote_commit", head],
    ["remote_parent", base], ["commit_parent", base], ["parent_sha", base],
    ["local_tested_commit", head], ["remote_tree", tree], ["remote_api_tree", tree], ["local_tested_tree", tree],
  ];
  const conflictingAliases = explicitAliases
    .filter(([key, expected]) => receiptValues(receipt, key).some((value) => value !== expected))
    .map(([key]) => key);
  if (conflictingAliases.length) throw new Error(`G22 terminal explicit aliases conflict with the verified chain: ${conflictingAliases.join(",")}`);
  if (isLegacyStart || eventKind === "WORKER_TERMINAL_RESULT") {
    if (typeof github.getCommit !== "function") throw new Error("exact G22 candidate commit and tree read is required");
    const baseCommit = await github.getCommit(base);
    if (String(baseCommit?.sha) !== base || String(baseCommit?.tree?.sha) !== baseTree) {
      throw new Error("G22 base commit metadata is not exact");
    }
    if (!isLegacyStart) {
      const headCommit = await github.getCommit(head);
      const parents = Array.isArray(headCommit?.parents) ? headCommit.parents.map((parent) => parent.sha) : [];
      if (String(headCommit?.sha) !== head || String(headCommit?.tree?.sha) !== tree ||
          parents.length !== 1 || parents[0] !== base) throw new Error("G22 candidate commit metadata is not exact");
    }
  }
  const canonical = sourceEventSchema.parse({
    marker: "GITHUB_SOURCE_EVENT_V1",
    event_id: sha256Hex(JSON.stringify([liveAuthority.control_generation, eventKind, String(exactSource.id)])),
    control_generation: liveAuthority.control_generation,
    active_control_id: liveAuthority.active_control_id,
    control_conversation_id: liveAuthority.control_conversation_id,
    event_kind: eventKind,
    source_comment_id: String(exactSource.id),
    source_body_sha256: sha256Hex(exactSource.body),
    card_comment_id: String(issueNumber),
    claim_comment_id: claimId,
    acceptance_comment_id: acceptanceId,
    binding_comment_id: routeId,
    dispatch_comment_id: routeId,
    agent_name: task,
    agent_session: attempt,
    pane: "collaboration-managed",
    terminal: "collaboration-managed",
    cwd: start.intended_fresh_worktree_path,
    model: "gpt-6-luna",
    reasoning_effort: "low",
    state,
    branch,
    base_sha: base,
    head_sha: head,
    tree_sha: tree,
    ...(isLegacyStart ? {} : { terminal_comment_id: String(exactSource.id), worker_start_comment_id: startId }),
    user_relay_count: 0,
  });
  return { body: sourceEventPayloadBody(canonical) };
}

async function markSourceEventConsumedUnlocked({ eventId, sourceCommentId, controlCommentId, runtimeRoot }) {
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

export async function markSourceEventConsumed(args) {
  return withLedgerLock(args.runtimeRoot, () => markSourceEventConsumedUnlocked(args));
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

async function beginSuccessorDeliveryUnlocked({ eventId, sourceCommentId, eventCommentId, controlCommentId, successorCommentId, deliver, runtimeRoot }) {
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

export async function beginSuccessorDelivery(args) {
  return withLedgerLock(args.runtimeRoot, () => beginSuccessorDeliveryUnlocked(args));
}

async function recordSuccessorDeliveryUnlocked({ eventId, receiptId, event, controlCommentId, successor, github, uncertain, runtimeRoot }) {
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

export async function recordSuccessorDelivery(args) {
  return withLedgerLock(args.runtimeRoot, () => recordSuccessorDeliveryUnlocked(args));
}
