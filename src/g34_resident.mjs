import { parseG34ReceiptFields, parseActiveControlAuthority } from "./g34_contract.mjs";
import { createSourceEvent, publishSourceEvent, markSourceEventConsumed } from "./g34_source_event_publisher.mjs";

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

function receiptFields(receipt) {
  if (!receipt || typeof receipt.body !== "string" || Number(receipt.issue_number) !== 88 ||
      receipt.issue_url !== "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/88" ||
      !/^[1-9][0-9]*$/.test(String(receipt.id ?? ""))) {
    throw new Error("exact #88 Control ACK metadata is required");
  }
  return { ...parseG34ReceiptFields(receipt), id: String(receipt.id) };
}

export function authorizeControlSuccessor({ event, authority, controlReceipt }) {
  const receipt = receiptFields(controlReceipt);
  if (
    !event || !authority || event.state !== "DELIVERED" ||
    authority.control_generation !== "034" ||
    !nonEmpty(authority.active_control_id) ||
    authority.active_control_id !== authority.control_conversation_id ||
    !receipt || !/^[1-9][0-9]*$/.test(String(receipt.id ?? "")) ||
    receipt.control_generation !== "034" ||
    receipt.active_control_id !== authority.active_control_id ||
    receipt.source_event_id !== event.event_id || String(receipt.successor_count) !== "1"
  ) throw new Error("Control has not authorized exactly one successor for this delivered G34 event");

  const successor = receipt.successor ?? {
    comment_id: receipt.successor_comment_id,
    agent_session: receipt.successor_agent_session,
    pane: receipt.successor_pane,
    terminal: receipt.successor_terminal,
  };
  if (!successor || !/^[1-9][0-9]*$/.test(String(successor.comment_id ?? "")) ||
      ![successor.agent_session, successor.pane, successor.terminal].every(nonEmpty)) {
    throw new Error("Control successor binding is incomplete");
  }
  return {
    comment_id: String(successor.comment_id),
    agent_session: successor.agent_session,
    pane: successor.pane,
    terminal: successor.terminal,
  };
}

export async function runG34ResidentCycle({ sourceComments, currentAuthority, binding, issueNumber, runtimeRoot, github, repositoryFullName = "D22977/gpt-browser-bridge", branch, baseSha, headSha, publisherAuthor }) {
  if (!Array.isArray(sourceComments)) throw new Error("exact source comments are required");
  if (typeof github?.getIssueComment !== "function") throw new Error("GitHub client is missing getIssueComment");
  const activeAuthority = parseActiveControlAuthority(currentAuthority);
  const results = [];
  for (const listedComment of sourceComments) {
    const sourceComment = await github.getIssueComment(String(listedComment?.id ?? ""));
    if (!sourceComment || String(sourceComment.id) !== String(listedComment?.id) ||
        Number(sourceComment.issue_number) !== issueNumber ||
        sourceComment.issue_url !== `https://api.github.com/repos/${repositoryFullName}/issues/${issueNumber}` ||
        sourceComment.body !== listedComment.body || sourceComment.user?.login !== listedComment.user?.login) {
      throw new Error("SOURCE_RECEIPT_READBACK_MISMATCH: exact upstream comment changed");
    }
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
      branch: fields.branch || branch,
      baseSha: fields.base_sha || baseSha,
      headSha: fields.head_sha || headSha || baseSha,
      state: fields.state,
      ...(eventKind === "WORKER_TERMINAL_RESULT" ? { terminalCommentId: String(sourceComment.id) } : {}),
      expectedAuthor: publisherAuthor,
    });
    const publication = await publishSourceEvent({ event, issueNumber, runtimeRoot, github, repositoryFullName });
    results.push({ event, publication });
  }
  return results;
}

export async function consumeDeliveredControlSuccessor({ event, authority, controlReceipt, runtimeRoot, deliver }) {
  const successor = authorizeControlSuccessor({ event, authority, controlReceipt });
  if (typeof deliver !== "function") throw new Error("bound Worker transport is required");
  const saved = await markSourceEventConsumed({
    eventId: event.event_id,
    sourceCommentId: event.source_comment_id,
    controlCommentId: controlReceipt.id,
    runtimeRoot,
  });
  if (saved.state === "NO_OP") return { state: "NO_OP" };
  await deliver(successor);
  return { state: "CONSUMED", successor };
}
