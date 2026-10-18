import { open, mkdir, readFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { githubCommentIdentity, g34Field, parseG34ReceiptFields, parseActiveControlAuthority } from "./g34_contract.mjs";
import {
  beginSuccessorDelivery, recordSuccessorDelivery, reconcileSuccessorDelivery,
  createSourceEvent, publishSourceEvent,
} from "./g34_source_event_publisher.mjs";

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const verifiedAuthorities = new WeakSet();
const verifiedControlAcceptances = new WeakSet();

function receiptFields(receipt) {
  const identity = githubCommentIdentity(receipt, "Control successor receipt");
  if (identity.issue_number !== 88) throw new Error("Control successor receipt must be an exact #88 GitHub comment GET");
  return { ...parseG34ReceiptFields(receipt), id: identity.id, author: receipt.user?.login };
}

export function authorizeControlSuccessor({ event, authority, controlReceipt }) {
  if (!verifiedAuthorities.has(authority) || !verifiedControlAcceptances.has(controlReceipt)) {
    throw new Error("successor authorization requires exact current authority and exact-read Control acceptance");
  }
  const receipt = receiptFields(controlReceipt);
  const expectedIds = authority?.source_comment_ids;
  const reviewId = String(receipt.review_comment_id ?? "");
  if (
    !event || !authority || event.state !== "DELIVERED" ||
    receipt.marker !== "GBB_G34_CONTROL_SUCCESSOR_ACCEPTANCE_V1" ||
    receipt.state !== "SUCCESSOR_ACCEPTED" ||
    receipt.recorded_by_role !== "ACTIVE_CONTROL" ||
    receipt.author !== authority.active_control_github_login ||
    receipt.control_generation !== "034" ||
    receipt.active_control_id !== authority.active_control_id ||
    receipt.control_conversation_id !== authority.control_conversation_id ||
    authority.control_generation !== "034" ||
    !nonEmpty(authority.active_control_id) ||
    authority.active_control_id !== authority.control_conversation_id ||
    receipt.source_event_id !== event.event_id ||
    receipt.source_comment_id !== String(event.source_comment_id) ||
    receipt.source_body_sha256 !== event.source_body_sha256 ||
    receipt.semantic_adjudication !== "ACCEPTED" ||
    receipt.current_authority_reread !== "MATCHED" ||
    receipt.current_switch_comment_id !== expectedIds?.switch ||
    receipt.current_start_index_comment_id !== expectedIds?.index43 ||
    receipt.current_registry_index_comment_id !== expectedIds?.index81 ||
    receipt.current_rehydration_ack_comment_id !== expectedIds?.rehydration_ack ||
    String(receipt.successor_count) !== "1"
  ) throw new Error("current authenticated Control has not accepted exactly one successor after semantic adjudication and exact reread");

  if (receipt.review_requirement === "REQUIRED") {
    if (receipt.review_decision !== "PASS" || !/^[1-9][0-9]*$/.test(reviewId) ||
        receipt.independent_review_exact_read !== "MATCHED" || !receipt.review_author ||
        receipt.review_card_id !== String(event.review_card_id ?? "") ||
        receipt.review_head_sha !== String(event.head_sha ?? "")) {
      throw new Error("required independent review is missing or not PASS");
    }
  } else if (receipt.review_requirement !== "NOT_REQUIRED" || receipt.review_decision !== "NOT_REQUIRED" || receipt.review_comment_id) {
    throw new Error("Control did not explicitly resolve the independent review requirement");
  }

  const successor = {
    comment_id: String(receipt.successor_comment_id ?? ""),
    issue_number: Number(receipt.successor_issue_number),
    agent_session: receipt.successor_agent_session,
    pane: receipt.successor_pane,
    terminal: receipt.successor_terminal,
    worker_author: receipt.successor_worker_author,
  };
  if (!/^[1-9][0-9]*$/.test(successor.comment_id) ||
      !Number.isSafeInteger(successor.issue_number) || successor.issue_number < 1 ||
      ![successor.agent_session, successor.pane, successor.terminal, successor.worker_author].every(nonEmpty)) {
    throw new Error("Control successor binding is incomplete");
  }
  return successor;
}

function exactCommentMetadata(comment) {
  return { id: String(comment?.id ?? ""), issue_number: githubCommentIdentity(comment, "exact GitHub comment GET").issue_number };
}

async function exactGetComment(github, id, issueNumber, label) {
  if (!/^[1-9][0-9]*$/.test(String(id ?? ""))) throw new Error(`${label} exact comment id is required`);
  const result = await github.getIssueComment(String(id));
  const identity = exactCommentMetadata(result);
  if (identity.id !== String(id) || identity.issue_number !== issueNumber) throw new Error(`${label} exact GET identity mismatch`);
  return result;
}

function latestComment(comments, issueNumber, markerPattern, label) {
  if (!Array.isArray(comments)) throw new Error(`${label} GitHub comment listing is invalid`);
  const matching = comments.filter((comment) => {
    const identity = githubCommentIdentity(comment, `${label} listed comment`);
    if (identity.issue_number !== issueNumber) throw new Error(`${label} listing contains another issue`);
    return typeof comment.body === "string" && markerPattern.test(parseG34ReceiptFields(comment).marker ?? "");
  });
  if (!matching.length) throw new Error(`${label} current GitHub pointer is missing`);
  return matching.reduce((latest, comment) => Number(comment.id) > Number(latest.id) ? comment : latest);
}

function requireSameListedRecord(listed, exact, label) {
  if (String(listed.id) !== String(exact.id) || listed.body !== exact.body ||
      listed.user?.login !== exact.user?.login || listed.issue_url !== exact.issue_url ||
      listed.url !== exact.url) throw new Error(`${label} exact GET differs from the current GitHub listing`);
}

function receiptValue(record, key) {
  const fields = parseG34ReceiptFields(record);
  return g34Field(fields, key, ["EXECUTOR_IDENTITY", "EXECUTOR_BINDING", "EXECUTOR", "TICKET", "CLAIM_CHAIN", "RESULT"]);
}

function hasReceiptLink(record, issueNumber, id, keys) {
  const body = String(record?.body ?? "");
  if (body.includes(`#${issueNumber}/${id}`)) return true;
  const names = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?:^|\\n)\\s*(?:${names})\\s*:\\s*(?:#${issueNumber}\\/)?${id}(?:\\s|$)`, "i").test(body);
}

async function readAcceptedWorkerChain({ github, binding, issueNumber, sourceComment, eventKind }) {
  const ids = ["card_comment_id", "binding_comment_id", "dispatch_comment_id", "claim_comment_id", "claim_acceptance_comment_id", "start_comment_id"];
  if (!binding || ids.some((key) => !/^[1-9][0-9]*$/.test(String(binding[key] ?? "")))) {
    throw new Error("SOURCE_RECEIPT_BINDING_MISMATCH: exact card, binding, dispatch, claim, acceptance, and start IDs are required");
  }
  const [card, bindingRecord, dispatch, claim, acceptance, start] = await Promise.all([
    exactGetComment(github, binding.card_comment_id, issueNumber, "Worker card"),
    exactGetComment(github, binding.binding_comment_id, issueNumber, "Worker binding"),
    exactGetComment(github, binding.dispatch_comment_id, issueNumber, "Worker dispatch"),
    exactGetComment(github, binding.claim_comment_id, issueNumber, "Worker claim"),
    exactGetComment(github, binding.claim_acceptance_comment_id, issueNumber, "Control claim acceptance"),
    exactGetComment(github, binding.start_comment_id, issueNumber, "Worker start"),
  ]);
  const cardFields = parseG34ReceiptFields(card);
  const bindingFields = parseG34ReceiptFields(bindingRecord);
  const dispatchFields = parseG34ReceiptFields(dispatch);
  const claimFields = parseG34ReceiptFields(claim);
  const acceptanceFields = parseG34ReceiptFields(acceptance);
  const startFields = parseG34ReceiptFields(start);
  if (!cardFields.marker || !/GBB_G34_.*V[0-9]+/.test(cardFields.marker) ||
      !bindingFields.marker?.includes("BINDING") ||
      !dispatchFields.marker?.includes("DISPATCH") ||
      !claimFields.marker?.includes("CLAIM_REQUEST") ||
      !acceptanceFields.marker?.includes("CLAIM_ACCEPTED") ||
      claimFields.state !== "CLAIM_REQUESTED" || acceptanceFields.state !== "CLAIM_ACCEPTED") {
    throw new Error("SOURCE_RECEIPT_BINDING_MISMATCH: exact Worker claim-chain markers/states are invalid");
  }
  if (!hasReceiptLink(bindingRecord, issueNumber, binding.card_comment_id, ["card_comment_id", "card", "card_id"]) ||
      !hasReceiptLink(dispatch, issueNumber, binding.binding_comment_id, ["binding_comment_id", "binding", "worker_binding", "accepted_target_binding"]) ||
      !hasReceiptLink(claim, issueNumber, binding.binding_comment_id, ["binding_comment_id", "binding", "identity_binding"]) ||
      !hasReceiptLink(claim, issueNumber, binding.dispatch_comment_id, ["dispatch_comment_id", "dispatch", "dispatch_request"]) ||
      !hasReceiptLink(acceptance, issueNumber, binding.claim_comment_id, ["claim_comment_id", "accepted_claim", "claim_request"]) ||
      !hasReceiptLink(acceptance, issueNumber, binding.binding_comment_id, ["binding_comment_id", "binding", "identity_binding"]) ||
      !hasReceiptLink(acceptance, issueNumber, binding.dispatch_comment_id, ["dispatch_comment_id", "dispatch", "dispatch_request"]) ||
      !hasReceiptLink(sourceComment, issueNumber, binding.claim_comment_id, ["claim_comment_id", "accepted_claim", "claim_request"]) ||
      !hasReceiptLink(sourceComment, issueNumber, binding.claim_acceptance_comment_id, ["claim_acceptance_comment_id", "claim_accepted_comment_id", "control_acceptance_comment_id", "control_acceptance"]) ||
      !hasReceiptLink(sourceComment, issueNumber, binding.binding_comment_id, ["binding_comment_id", "binding", "identity_binding"]) ||
      !hasReceiptLink(sourceComment, issueNumber, binding.dispatch_comment_id, ["dispatch_comment_id", "dispatch", "dispatch_request"]) ||
      !hasReceiptLink(sourceComment, issueNumber, binding.card_comment_id, ["card_comment_id", "card", "card_id"])) {
    throw new Error("SOURCE_RECEIPT_BINDING_MISMATCH: claim/start receipt chain links are incomplete");
  }
  if (claim.user?.login !== binding.worker_author || sourceComment.user?.login !== binding.worker_author) {
    throw new Error("SOURCE_RECEIPT_BINDING_MISMATCH: claim or executor receipt author is not the accepted Worker");
  }
  for (const key of ["attempt_id", "lease_id", "lease_generation", "agent_name", "agent_session", "pane", "terminal", "cwd", "branch", "base_sha", "head_sha"]) {
    const expected = binding[key];
    if (!nonEmpty(expected) || receiptValue(bindingRecord, key) !== expected || receiptValue(claim, key) !== expected || receiptValue(acceptance, key) !== expected) {
      throw new Error(`SOURCE_RECEIPT_BINDING_MISMATCH: accepted claim chain does not bind ${key}`);
    }
  }
  if (String(receiptValue(acceptance, "claim_comment_id") ?? binding.claim_comment_id) !== String(binding.claim_comment_id) ||
      receiptValue(acceptance, "state") !== "CLAIM_ACCEPTED") {
    throw new Error("SOURCE_RECEIPT_BINDING_MISMATCH: Control acceptance does not bind the exact claim");
  }
  const listedClaims = await github.listIssueComments(issueNumber);
  const accepted = listedClaims.filter((comment) => {
    const fields = parseG34ReceiptFields(comment);
    return fields.marker?.includes("CLAIM_ACCEPTED") && hasReceiptLink(comment, issueNumber, binding.card_comment_id, ["card_comment_id", "card", "card_id"]);
  });
  if (accepted.length !== 1 || String(accepted[0].id) !== String(binding.claim_acceptance_comment_id) ||
      !hasReceiptLink(accepted[0], issueNumber, binding.claim_comment_id, ["claim_comment_id", "accepted_claim", "claim_request"])) {
    throw new Error("SOURCE_RECEIPT_BINDING_MISMATCH: claim is not the unique accepted Worker claim");
  }
  if (eventKind === "WORKER_STARTED" && (start.id !== String(sourceComment.id) ||
      startFields.marker !== "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1" || receiptValue(start, "state") !== "CONSUMED_STARTED" ||
      receiptValue(start, "role") !== "Worker")) {
    throw new Error("SOURCE_RECEIPT_BINDING_MISMATCH: exact Worker start marker/state is invalid");
  }
  if (eventKind === "WORKER_TERMINAL_RESULT") {
    if (String(binding.terminal_comment_id ?? "") !== String(sourceComment.id)) {
      throw new Error("SOURCE_RECEIPT_BINDING_MISMATCH: terminal comment ID is not in the accepted Worker binding");
    }
    const startLink = receiptValue(sourceComment, "start_receipt_comment_id") ?? receiptValue(sourceComment, "consumed_started_comment_id");
    if (String(startLink ?? "") !== String(start.id) || startFields.marker !== "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1") {
      throw new Error("SOURCE_RECEIPT_BINDING_MISMATCH: terminal is not linked to the exact valid start receipt");
    }
  }
  return { card, bindingRecord, dispatch, claim, acceptance, start };
}

export async function readCurrentControlAuthority({ github, pointers }) {
  if (!pointers || !["index43", "index81", "switch", "rehydrationAck"].every((key) => /^[1-9][0-9]*$/.test(String(pointers[key] ?? "")))) {
    throw new Error("exact current #43/#81/#88 Control pointers are required");
  }
  if (typeof github?.listIssueComments !== "function") throw new Error("GitHub client is missing current issue comment listing");
  const [comments43, comments81, comments88] = await Promise.all([
    github.listIssueComments(43), github.listIssueComments(81), github.listIssueComments(88),
  ]);
  const listed = {
    index43: latestComment(comments43, 43, /^CURRENT_REHYDRATION_INDEX_V[0-9]+$/, "#43 current index"),
    index81: latestComment(comments81, 81, /^CURRENT_REGISTRY_INDEX_V[0-9]+$/, "#81 current index"),
    switch: latestComment(comments88, 88, /^CONTROL_GENERATION_(?:ATOMIC_SWITCH|SWITCH_[0-9]+_TO_[0-9]+)_V1$/, "#88 active switch"),
    rehydrationAck: latestComment(comments88, 88, /^ACTIVE_CONTROL_REHYDRATION_ACK_V1$/, "#88 active rehydration ACK"),
  };
  for (const key of Object.keys(listed)) {
    if (String(listed[key].id) !== String(pointers[key])) throw new Error(`stale current Control pointer: ${key}`);
  }
  const exactEntries = await Promise.all([
    exactGetComment(github, pointers.index43, 43, "#43 current index"),
    exactGetComment(github, pointers.index81, 81, "#81 current index"),
    exactGetComment(github, pointers.switch, 88, "#88 active switch"),
    exactGetComment(github, pointers.rehydrationAck, 88, "#88 active rehydration ACK"),
  ]);
  const [index43, index81, switchReceipt, rehydrationAck] = exactEntries;
  requireSameListedRecord(listed.index43, index43, "#43 current index");
  requireSameListedRecord(listed.index81, index81, "#81 current index");
  requireSameListedRecord(listed.switch, switchReceipt, "#88 active switch");
  requireSameListedRecord(listed.rehydrationAck, rehydrationAck, "#88 active rehydration ACK");
  const authority = parseActiveControlAuthority({ switchReceipt, index43, index81, rehydrationAck });
  verifiedAuthorities.add(authority);
  return authority;
}

async function exactDecision({ github, controlReceipt, authority, event }) {
  const listed = exactCommentMetadata(controlReceipt);
  if (listed.issue_number !== 88) throw new Error("Control acceptance must be a #88 comment");
  const exact = await exactGetComment(github, listed.id, 88, "Control acceptance");
  if (exact.body !== controlReceipt.body || exact.user?.login !== controlReceipt.user?.login) {
    throw new Error("Control acceptance exact reread differs from its listing");
  }
  const acceptanceListing = await github.listIssueComments(88);
  const matchingAcceptances = acceptanceListing.filter((comment) => {
    const fields = parseG34ReceiptFields(comment);
    return fields.marker === "GBB_G34_CONTROL_SUCCESSOR_ACCEPTANCE_V1" && fields.source_event_id === event.event_id;
  });
  if (matchingAcceptances.length !== 1 || String(matchingAcceptances[0].id) !== listed.id) {
    throw new Error("Control acceptance does not satisfy the single-successor boundary");
  }
  requireSameListedRecord(matchingAcceptances[0], exact, "Control acceptance");
  const fields = parseG34ReceiptFields(exact);
  if (fields.review_requirement === "REQUIRED") {
    const review = await exactGetComment(github, fields.review_comment_id, Number(fields.review_issue_number ?? 0), "independent review");
    if (review.user?.login !== fields.review_author || review.id !== fields.review_comment_id ||
        fields.review_decision !== "PASS" || !review.body.includes("decision: PASS") ||
        !review.body.includes(`head_sha: ${event.head_sha}`) ||
        !review.body.includes(`reviewer_binding: ${fields.review_binding_id}`) ||
        !review.body.includes(`reviewer_consumed_started: ${fields.review_start_id}`)) {
      throw new Error("independent review exact record does not support the Control PASS adjudication");
    }
  } else if (fields.review_requirement !== "NOT_REQUIRED" || fields.review_decision !== "NOT_REQUIRED") {
    throw new Error("Control did not resolve independent review requirement");
  }
  const source = await exactGetComment(github, event.source_comment_id, Number(event.source_issue_number), "source event");
  if (source.body == null || source.user?.login !== event.expected_source_author ||
      createHash("sha256").update(source.body, "utf8").digest("hex") !== event.source_body_sha256) {
    throw new Error("source event exact readback does not match its bound author/body hash");
  }
  verifiedControlAcceptances.add(exact);
  const decision = authorizeControlSuccessor({ event, authority, controlReceipt: exact });
  return { exact, decision, source };
}

export async function runG34ResidentCycle({
  sourceComments, currentAuthority, currentAuthorityPointers, binding, issueNumber, runtimeRoot, github,
  repositoryFullName = "D22977/gpt-browser-bridge", branch, baseSha, headSha, publisherAuthor,
}) {
  if (!Array.isArray(sourceComments)) throw new Error("exact source comments are required");
  if (typeof github?.getIssueComment !== "function") throw new Error("GitHub client is missing getIssueComment");
  if (!currentAuthorityPointers) throw new Error("current exact Control index pointers are required for a resident cycle");
  const activeAuthority = await readCurrentControlAuthority({ github, pointers: currentAuthorityPointers });
  const results = [];
  for (const listedComment of sourceComments) {
    const listedIdentity = githubCommentIdentity(listedComment, "listed upstream Worker comment");
    const sourceComment = await github.getIssueComment(listedIdentity.id);
    const exactIdentity = githubCommentIdentity(sourceComment, "exact upstream Worker comment");
    if (
      exactIdentity.id !== listedIdentity.id ||
      exactIdentity.issue_number !== issueNumber ||
      exactIdentity.issue_number !== listedIdentity.issue_number ||
      sourceComment.issue_url !== listedComment.issue_url ||
      sourceComment.body !== listedComment.body ||
      sourceComment.user?.login !== listedComment.user?.login
    ) throw new Error("SOURCE_RECEIPT_READBACK_MISMATCH: exact upstream comment changed");

    if (binding?.worker_author !== sourceComment.user?.login ||
        binding?.repository !== repositoryFullName || binding?.control_conversation_id !== activeAuthority.active_control_id) {
      throw new Error("SOURCE_RECEIPT_BINDING_MISMATCH: exact Worker start/card/binding chain is required");
    }
    const fields = parseG34ReceiptFields(sourceComment);
    const eventKind = fields.marker === "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1"
      ? "WORKER_STARTED"
      : fields.marker === "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1" ? "WORKER_TERMINAL_RESULT" : null;
    if (!eventKind || !receiptValue(sourceComment, "state")) throw new Error("unsupported G34 executor receipt");
    const chain = await readAcceptedWorkerChain({ github, binding, issueNumber, sourceComment, eventKind });
    if (chain.acceptance.user?.login !== activeAuthority.active_control_github_login) {
      throw new Error("SOURCE_RECEIPT_BINDING_MISMATCH: claim acceptance author is not the active Control");
    }
    for (const key of ["card_comment_id", "binding_comment_id", "dispatch_comment_id", "agent_name", "agent_session", "pane", "terminal", "cwd", "model", "reasoning_effort", "branch", "base_sha", "head_sha", "attempt_id", "lease_id", "lease_generation"]) {
      if (String(receiptValue(sourceComment, key) ?? "") !== String(binding[key] ?? "")) {
        throw new Error(`SOURCE_RECEIPT_BINDING_MISMATCH: ${key} differs from accepted Worker binding`);
      }
    }
    const event = createSourceEvent({
      sourceComment,
      sourceIssueNumber: issueNumber,
      sourceRepositoryFullName: repositoryFullName,
      eventKind,
      authority: activeAuthority,
      binding,
      branch: fields.branch,
      baseSha: fields.base_sha,
      headSha: fields.head_sha,
      state: receiptValue(sourceComment, "state"),
      ...(eventKind === "WORKER_TERMINAL_RESULT"
        ? { terminalCommentId: String(sourceComment.id), ...(receiptValue(sourceComment, "review_comment_id") ? { reviewCommentId: receiptValue(sourceComment, "review_comment_id") } : {}) }
        : {}),
      expectedAuthor: publisherAuthor,
    });
    const publication = await publishSourceEvent({ event, issueNumber, runtimeRoot, github, repositoryFullName });
    results.push({ event, publication });
  }
  return results;
}

export async function consumeDeliveredControlSuccessor({
  event, authority, controlReceipt, github, currentAuthorityPointers, runtimeRoot, deliver, reconcile,
}) {
  if (!github || !currentAuthorityPointers) throw new Error("GitHub exact-read client and current authority pointers are required");
  const exactAuthority = await readCurrentControlAuthority({ github, pointers: currentAuthorityPointers });
  const { exact: exactControlReceipt, decision: successor } = await exactDecision({ github, controlReceipt, authority: exactAuthority, event });
  if (typeof deliver !== "function") throw new Error("bound Worker transport is required");

  const begun = await beginSuccessorDelivery({
    eventId: event.event_id,
    sourceCommentId: event.source_comment_id,
    controlCommentId: String(exactControlReceipt.id),
    successor,
    runtimeRoot,
  });
  if (begun.state === "NO_OP") return { state: "NO_OP" };
  if (begun.state === "UNCERTAIN_DELIVERY") {
    if (typeof reconcile !== "function") return { state: "UNCERTAIN_DELIVERY", successor };
    const evidence = await reconcile(successor);
    const recovered = await reconcileSuccessorDelivery({
      eventId: event.event_id,
      sourceCommentId: event.source_comment_id,
      evidence,
      runtimeRoot,
    });
    return { ...recovered, successor };
  }

  let delivery;
  try {
    delivery = await deliver(successor);
  } catch {
    delivery = { state: "UNCERTAIN" };
  }
  const result = await recordSuccessorDelivery({
    eventId: event.event_id,
    sourceCommentId: event.source_comment_id,
    delivery,
    runtimeRoot,
  });
  if (result.state !== "SUCCESSOR_DELIVERED_AWAITING_RECEIPT") return { ...result, successor };
  if (!delivery.workerReceipt) return { state: "SUCCESSOR_DELIVERED_AWAITING_RECEIPT", successor };
  const workerReceipt = await exactGetComment(github, delivery.workerReceipt.id, successor.issue_number, "successor Worker consumption");
  return {
    ...await markSourceEventConsumed({
      eventId: event.event_id,
      sourceCommentId: event.source_comment_id,
      controlCommentId: String(exactControlReceipt.id),
      runtimeRoot,
      workerReceipt,
      expectedWorkerAuthor: successor.worker_author,
      successor,
      github,
    }), successor,
  };
}
