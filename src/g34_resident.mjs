import { parseG34ReceiptFields, parseActiveControlAuthority } from "./g34_contract.mjs";
import { createSourceEvent, publishSourceEvent, beginSuccessorDelivery, recordSuccessorDelivery } from "./g34_source_event_publisher.mjs";

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

function receiptFields(receipt) {
  const id = String(receipt?.id ?? "");
  const urlMatch = typeof receipt?.url === "string"
    ? /^https:\/\/github\.com\/D22977\/gpt-browser-bridge\/issues\/88#issuecomment-(\d+)$/.exec(receipt.url)
    : null;
  if (!receipt || typeof receipt.body !== "string" || !/^[1-9][0-9]*$/.test(id) ||
      !urlMatch || urlMatch[1] !== id || receipt.user?.login !== "D22977") {
    throw new Error("exact #88 Control ACK metadata is required");
  }
  return { ...parseG34ReceiptFields(receipt), id, author: receipt.user.login, url: receipt.url, body: receipt.body };
}

export async function authorizeControlSuccessor({ event, authority, controlReceipt, github }) {
  const receipt = receiptFields(controlReceipt);
  if (typeof github?.getIssueComment !== "function" ||
      typeof github?.getCurrentAuthorityRecords !== "function") {
    throw new Error("exact current GitHub authority and Control acceptance rereads are required");
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
  if (liveAuthority.control_generation !== authority?.control_generation ||
      liveAuthority.active_control_id !== authority?.active_control_id) {
    throw new Error("current Control authority changed before successor authorization");
  }
  const reread = receiptFields(await github.getIssueComment(receipt.id));
  if (reread.id !== receipt.id || reread.url !== receipt.url || reread.body !== receipt.body ||
      reread.author !== receipt.author) throw new Error("Control acceptance exact reread mismatch");
  if (!event || !/^[1-9][0-9]*$/.test(String(event.comment_id ?? "")) ||
      !/^[1-9][0-9]*$/.test(String(event.source_issue_number ?? "")) ||
      !nonEmpty(event.source_repository_full_name) || typeof event.body !== "string") {
    throw new Error("exact delivered source-event identity is required");
  }
  const eventComment = await github.getIssueComment(String(event.comment_id));
  const eventUrl = new RegExp(
    `^https://github\\.com/${event.source_repository_full_name.replace("/", "\\/")}/issues/${event.source_issue_number}#issuecomment-${event.comment_id}$`,
  );
  if (!eventComment || String(eventComment.id) !== String(event.comment_id) ||
      !eventUrl.test(eventComment.url ?? "") || eventComment.body !== event.body ||
      eventComment.user?.login !== liveAuthority.publisher_login ||
      !event.body.includes(`event_id=${event.event_id}`) ||
      !event.body.includes(`source_comment_id=${event.source_comment_id}`) ||
      !event.body.includes(`source_body_sha256=${event.source_body_sha256}`)) {
    throw new Error("delivered source event exact reread mismatch");
  }
  const readLinkedReceipt = async (commentId) => {
    if (!/^[1-9][0-9]*$/.test(String(commentId ?? ""))) throw new Error("linked review/adjudication receipt ID is missing");
    const listed = await github.getIssueComment(String(commentId));
    const match = typeof listed?.url === "string"
      ? /^https:\/\/github\.com\/D22977\/gpt-browser-bridge\/issues\/(\d+)#issuecomment-(\d+)$/.exec(listed.url)
      : null;
    if (!match || match[2] !== String(commentId) || String(listed.id) !== String(commentId) ||
        listed.user?.login !== liveAuthority.publisher_login) {
      throw new Error("linked review/adjudication receipt metadata is not exact and authenticated");
    }
    const exact = await github.getIssueComment(String(commentId));
    if (!exact || String(exact.id) !== String(listed.id) || exact.url !== listed.url ||
        exact.body !== listed.body || exact.user?.login !== listed.user.login) {
      throw new Error("linked review/adjudication receipt exact reread mismatch");
    }
    return { ...parseG34ReceiptFields(exact), id: String(exact.id) };
  };
  const review = await readLinkedReceipt(receipt.independent_review_comment_id);
  const adjudication = await readLinkedReceipt(receipt.adjudication_comment_id);
  const currentControlPointers = liveAuthority.record_ids;
  if (
    !event || !authority || event.state !== "DELIVERED" ||
    authority.control_generation !== "034" ||
    !nonEmpty(authority.active_control_id) ||
    authority.active_control_id !== authority.control_conversation_id ||
    authority.publisher_login !== receipt.author ||
    receipt.marker !== "CONTROL_SUCCESSOR_ACCEPTANCE_V1" ||
    receipt.state !== "SUCCESSOR_ACCEPTED" ||
    receipt.recorded_by_role !== "ACTIVE_CONTROL" ||
    receipt.control_generation !== authority.control_generation ||
    receipt.active_control_id !== authority.active_control_id ||
    receipt.source_event_id !== event.event_id ||
    receipt.source_event_comment_id !== String(event.comment_id ?? "") ||
    receipt.worker_receipt_comment_id !== String(event.source_comment_id ?? "") ||
    receipt.current_switch_comment_id !== currentControlPointers?.switch_comment_id ||
    receipt.current_index43_comment_id !== currentControlPointers?.index43_comment_id ||
    receipt.current_index81_comment_id !== currentControlPointers?.index81_comment_id ||
    review.marker !== "GBB_G34_INDEPENDENT_REVIEW_RESULT_V1" ||
    review.decision !== "PASS" || review.state !== "REVIEW_TERMINAL" ||
    !/INDEPENDENT.*REVIEW/i.test(review.role ?? "") ||
    receipt.independent_review_decision !== review.decision ||
    adjudication.marker !== "ACTIVE_CONTROL_ADJUDICATION_V1" ||
    adjudication.state !== "ACCEPTED" ||
    adjudication.recorded_by_role !== "ACTIVE_CONTROL" ||
    adjudication.active_control_id !== liveAuthority.active_control_id ||
    adjudication.source_event_id !== event.event_id ||
    adjudication.review_comment_id !== review.id ||
    receipt.adjudication_state !== adjudication.state ||
    receipt.semantic_sequence !== "WORKER_RECEIPT_SOURCE_EVENT_ACTIVE_CONTROL_ADJUDICATION_INDEPENDENT_REVIEW_CURRENT_CONTROL_ACK" ||
    String(receipt.successor_count) !== "1"
  ) throw new Error("current authenticated Control acceptance does not satisfy the G34 semantic sequence and single-successor boundary");

  const successor = {
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
  if (!nonEmpty(branch) || !/^[0-9a-f]{40}$/.test(String(baseSha ?? "")) ||
      !/^[0-9a-f]{40}$/.test(String(headSha ?? ""))) {
    throw new Error("exact branch, base, and current head are required");
  }
  const activeAuthority = parseActiveControlAuthority(currentAuthority);
  const results = [];
  const readBack = new Map();
  for (const listedComment of sourceComments) {
    const sourceComment = await github.getIssueComment(String(listedComment?.id ?? ""));
    const identityUrl = sourceComment?.url;
    const exactIssue = typeof identityUrl === "string" &&
      new RegExp(`^https://github\\.com/${repositoryFullName.replace("/", "\\/")}/issues/${issueNumber}#issuecomment-${listedComment?.id}$`).test(identityUrl);
    if (!sourceComment || String(sourceComment.id) !== String(listedComment?.id) || !exactIssue ||
        sourceComment.body !== listedComment.body || sourceComment.user?.login !== listedComment.user?.login) {
      throw new Error("SOURCE_RECEIPT_READBACK_MISMATCH: exact upstream comment changed");
    }
    const fields = parseG34ReceiptFields(sourceComment);
    const eventKind = fields.marker === "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1"
      ? "WORKER_STARTED"
      : fields.marker === "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1" ? "WORKER_TERMINAL_RESULT" : null;
    if (!eventKind || !fields.state) throw new Error("unsupported G34 executor receipt");
    if (sourceComment.user?.login !== publisherAuthor ||
        fields.card_comment_id !== String(binding?.card_comment_id) ||
        fields.binding_comment_id !== String(binding?.binding_comment_id) ||
        fields.dispatch_comment_id !== String(binding?.dispatch_comment_id) ||
        fields.control_generation !== activeAuthority.control_generation ||
        fields.control_conversation_id !== activeAuthority.control_conversation_id ||
        fields.repository !== repositoryFullName ||
        fields.agent_name !== binding?.agent_name || fields.agent_session !== binding?.agent_session ||
        fields.pane !== binding?.pane || fields.terminal !== binding?.terminal || fields.cwd !== binding?.cwd ||
        fields.model !== binding?.model || fields.reasoning_effort !== binding?.reasoning_effort ||
        fields.state === undefined || fields.branch !== branch ||
        fields.branch !== binding?.branch || fields.base_sha !== baseSha ||
        fields.base_sha !== binding?.base_sha || fields.user_relay_count !== "0") {
      throw new Error("upstream executor receipt does not match accepted Worker claim and exact binding");
    }
    if (eventKind === "WORKER_STARTED" && fields.state !== "CONSUMED_STARTED") {
      throw new Error("Worker start receipt has an invalid state");
    }
    if (eventKind === "WORKER_STARTED" && fields.head_sha !== fields.base_sha) {
      throw new Error("Worker start receipt head must equal the exact clean base");
    }
    if (eventKind === "WORKER_TERMINAL_RESULT") {
      const startId = String(fields.worker_start_comment_id ?? "");
      const start = readBack.get(startId);
      if (!start || start.marker !== "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1" ||
          start.card_comment_id !== fields.card_comment_id ||
          start.binding_comment_id !== fields.binding_comment_id ||
          start.dispatch_comment_id !== fields.dispatch_comment_id ||
          start.agent_session !== fields.agent_session || start.branch !== fields.branch ||
          start.base_sha !== fields.base_sha) {
        throw new Error("terminal result lacks its exact matching Worker start receipt chain");
      }
      if (fields.head_sha !== headSha ||
          !(fields.state === "READY_FOR_FRESH_REVIEW" || /^BLOCKED_[A-Z0-9_]+$/.test(fields.state))) {
        throw new Error("Worker terminal receipt is not bound to the exact current head and a valid terminal state");
      }
    }
    readBack.set(String(sourceComment.id), fields);
    const event = createSourceEvent({
      sourceComment,
      sourceIssueNumber: issueNumber,
      sourceRepositoryFullName: repositoryFullName,
      eventKind,
      authority: activeAuthority,
      binding: eventKind === "WORKER_TERMINAL_RESULT"
        ? { ...binding, start_comment_id: fields.worker_start_comment_id }
        : binding,
      branch: fields.branch,
      baseSha: fields.base_sha,
      headSha: fields.head_sha,
      state: fields.state,
      ...(eventKind === "WORKER_TERMINAL_RESULT" ? { terminalCommentId: String(sourceComment.id) } : {}),
      expectedAuthor: publisherAuthor,
    });
    const publication = await publishSourceEvent({ event, issueNumber, runtimeRoot, github, repositoryFullName });
    results.push({ event: { ...event, comment_id: publication.comment_id }, publication });
  }
  return results;
}

export async function consumeDeliveredControlSuccessor({ event, authority, controlReceipt, runtimeRoot, github, deliver, reconcile }) {
  const successor = await authorizeControlSuccessor({ event, authority, controlReceipt, github });
  const opened = await beginSuccessorDelivery({
    eventId: event.event_id,
    sourceCommentId: event.source_comment_id,
    eventCommentId: event.comment_id,
    controlCommentId: controlReceipt.id,
    successorCommentId: successor.comment_id,
    runtimeRoot,
  });
  if (opened.state === "NO_OP") return { state: "NO_OP" };
  if (opened.state === "DELIVERY_UNCERTAIN") {
    if (typeof reconcile !== "function") return { state: "DELIVERY_UNCERTAIN", successor };
    let observed;
    try {
      observed = await reconcile({ eventId: event.event_id, successorCommentId: successor.comment_id });
    } catch {
      return { state: "DELIVERY_UNCERTAIN", successor };
    }
    if (observed?.state !== "DELIVERED" || !/^[1-9][0-9]*$/.test(String(observed.receipt_id ?? ""))) {
      return { state: "DELIVERY_UNCERTAIN", successor };
    }
    const saved = await recordSuccessorDelivery({ eventId: event.event_id, receiptId: observed.receipt_id, runtimeRoot });
    return { ...saved, successor };
  }
  if (typeof deliver !== "function") throw new Error("bound Worker transport is required");
  let result;
  try {
    result = await deliver(successor, { idempotencyKey: event.event_id });
  } catch {
    await recordSuccessorDelivery({ eventId: event.event_id, uncertain: true, runtimeRoot });
    return { state: "DELIVERY_UNCERTAIN", successor };
  }
  if (result?.state !== "DELIVERED" || !/^[1-9][0-9]*$/.test(String(result.receipt_id ?? ""))) {
    await recordSuccessorDelivery({ eventId: event.event_id, uncertain: true, runtimeRoot });
    return { state: "DELIVERY_UNCERTAIN", successor };
  }
  const saved = await recordSuccessorDelivery({ eventId: event.event_id, receiptId: result.receipt_id, runtimeRoot });
  return { ...saved, successor };
}

