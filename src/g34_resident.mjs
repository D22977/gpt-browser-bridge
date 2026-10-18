import { open, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { githubCommentIdentity, parseG34ReceiptFields, parseActiveControlAuthority } from "./g34_contract.mjs";
import {
  beginSuccessorDelivery, recordSuccessorDelivery, reconcileSuccessorDelivery,
  createSourceEvent, publishSourceEvent,
} from "./g34_source_event_publisher.mjs";

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

function receiptFields(receipt) {
  const identity = githubCommentIdentity(receipt, "Control successor receipt");
  if (identity.issue_number !== 88) throw new Error("Control successor receipt must be an exact #88 GitHub comment GET");
  return { ...parseG34ReceiptFields(receipt), id: identity.id, author: receipt.user?.login };
}

export function authorizeControlSuccessor({ event, authority, controlReceipt }) {
  const receipt = receiptFields(controlReceipt);
  const expectedIds = authority?.source_comment_ids;
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
    if (receipt.review_decision !== "PASS" || !/^[1-9][0-9]*$/.test(String(receipt.review_comment_id ?? ""))) {
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
  };
  if (!/^[1-9][0-9]*$/.test(successor.comment_id) ||
      !Number.isSafeInteger(successor.issue_number) || successor.issue_number < 1 ||
      ![successor.agent_session, successor.pane, successor.terminal].every(nonEmpty)) {
    throw new Error("Control successor binding is incomplete");
  }
  return successor;
}

export async function runG34ResidentCycle({
  sourceComments, currentAuthority, binding, issueNumber, runtimeRoot, github,
  repositoryFullName = "D22977/gpt-browser-bridge", branch, baseSha, headSha, publisherAuthor,
}) {
  if (!Array.isArray(sourceComments)) throw new Error("exact source comments are required");
  if (typeof github?.getIssueComment !== "function") throw new Error("GitHub client is missing getIssueComment");
  const activeAuthority = parseActiveControlAuthority(currentAuthority);
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

    const fields = parseG34ReceiptFields(sourceComment);
    const eventKind = fields.marker === "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1"
      ? "WORKER_STARTED"
      : fields.marker === "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1" ? "WORKER_TERMINAL_RESULT" : null;
    if (!eventKind || !fields.state) throw new Error("unsupported G34 executor receipt");
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
      state: fields.state,
      ...(eventKind === "WORKER_TERMINAL_RESULT"
        ? { terminalCommentId: String(sourceComment.id), ...(fields.review_comment_id ? { reviewCommentId: fields.review_comment_id } : {}) }
        : {}),
      expectedAuthor: publisherAuthor,
    });
    const publication = await publishSourceEvent({ event, issueNumber, runtimeRoot, github, repositoryFullName });
    results.push({ event, publication });
  }
  return results;
}

export async function consumeDeliveredControlSuccessor({
  event, authority, controlReceipt, runtimeRoot, deliver, reconcile,
}) {
  const successor = authorizeControlSuccessor({ event, authority, controlReceipt });
  if (typeof deliver !== "function") throw new Error("bound Worker transport is required");

  const begun = await beginSuccessorDelivery({
    eventId: event.event_id,
    sourceCommentId: event.source_comment_id,
    controlCommentId: String(controlReceipt.id),
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
      evidence: { ...evidence, control_comment_id: String(controlReceipt.id), ...successor },
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
  return { ...result, successor };
}
