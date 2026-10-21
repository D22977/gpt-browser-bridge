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
  const readLinkedReceipt = async (commentId, issueNumber) => {
    if (!/^[1-9][0-9]*$/.test(String(commentId ?? ""))) throw new Error("linked review/adjudication receipt ID is missing");
    const listed = await github.getIssueComment(String(commentId));
    const match = typeof listed?.url === "string"
      ? /^https:\/\/github\.com\/D22977\/gpt-browser-bridge\/issues\/(\d+)#issuecomment-(\d+)$/.exec(listed.url)
      : null;
    if (!match || Number(match[1]) !== issueNumber || match[2] !== String(commentId) || String(listed.id) !== String(commentId) ||
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
  const review = await readLinkedReceipt(receipt.independent_review_comment_id, Number(receipt.independent_review_card_issue_number));
  const reviewerBinding = await readLinkedReceipt(receipt.independent_reviewer_binding_comment_id, Number(receipt.independent_review_card_issue_number));
  const adjudication = await readLinkedReceipt(receipt.adjudication_comment_id, 211);
  if (typeof github.getIssue !== "function") throw new Error("exact independent review card read is required");
  const reviewCard = await github.getIssue(Number(receipt.independent_review_card_issue_number));
  const exactReviewCard = await github.getIssue(Number(receipt.independent_review_card_issue_number));
  const reviewCardFields = reviewCard ? parseG34ReceiptFields(reviewCard) : {};
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
    Number(receipt.independent_review_card_issue_number) < 1 || !reviewCard ||
    Number(reviewCard.number) !== Number(receipt.independent_review_card_issue_number) ||
    !exactReviewCard || Number(exactReviewCard.number) !== Number(reviewCard.number) ||
    exactReviewCard.state !== reviewCard.state || exactReviewCard.body !== reviewCard.body ||
    !String(reviewCard.body ?? "").startsWith("GBB_G34_FRESH_REVIEW_CARD_V1") ||
    reviewCardFields.reviewed_head_sha !== receipt.reviewed_head_sha ||
    reviewCardFields.reviewer_binding_comment_id !== reviewerBinding.id ||
    reviewCardFields.reviewer_identity !== reviewerBinding.reviewer_identity ||
    !/INDEPENDENT.*REVIEW/i.test(reviewCardFields.role ?? "") ||
    !nonEmpty(reviewCardFields.reviewer_executor_identity) ||
    reviewCardFields.reviewer_executor_identity !== reviewerBinding.executor_identity ||
    receipt.reviewed_head_sha !== event.head_sha ||
    review.marker !== "GBB_G34_INDEPENDENT_REVIEW_RESULT_V1" ||
    review.decision !== "PASS" || review.state !== "REVIEW_TERMINAL" ||
    !/INDEPENDENT.*REVIEW/i.test(review.role ?? "") ||
    review.review_card_issue_number !== String(reviewCard.number) ||
    review.reviewed_head_sha !== event.head_sha ||
    review.reviewer_binding_comment_id !== reviewerBinding.id ||
    review.executor_identity !== reviewerBinding.executor_identity ||
    reviewerBinding.reviewer_identity !== reviewerBinding.executor_identity ||
    reviewerBinding.marker !== "GBB_G34_INDEPENDENT_REVIEWER_BINDING_V1" ||
    reviewerBinding.card_issue_number !== String(reviewCard.number) ||
    !/INDEPENDENT.*REVIEW/i.test(reviewerBinding.role ?? "") ||
    reviewerBinding.reviewer_identity !== review.reviewer_identity ||
    reviewerBinding.reviewer_identity === event.agent_session || reviewerBinding.executor_identity === "D22977" ||
    !nonEmpty(reviewerBinding.reviewer_identity) || reviewerBinding.reviewer_identity === "D22977" ||
    !/^gpt-6-sol$/i.test(reviewerBinding.model ?? "") || reviewerBinding.reasoning_effort !== "high" ||
    receipt.independent_review_decision !== review.decision ||
    adjudication.marker !== "ACTIVE_CONTROL_ADJUDICATION_V1" ||
    adjudication.state !== "ACCEPTED" ||
    adjudication.recorded_by_role !== "ACTIVE_CONTROL" ||
    adjudication.active_control_id !== liveAuthority.active_control_id ||
    adjudication.source_event_id !== event.event_id ||
    adjudication.review_comment_id !== review.id ||
    adjudication.review_card_issue_number !== String(reviewCard.number) ||
    adjudication.reviewed_head_sha !== event.head_sha ||
    Number(event.comment_id) >= Number(review.id) || Number(review.id) >= Number(adjudication.id) ||
    Number(adjudication.id) >= Number(receipt.id) ||
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
  if (typeof github?.getIssueComment !== "function" || typeof github?.getIssue !== "function") throw new Error("GitHub client is missing exact issue/comment reads");
  if (!nonEmpty(branch) || !/^[0-9a-f]{40}$/.test(String(baseSha ?? "")) ||
      !/^[0-9a-f]{40}$/.test(String(headSha ?? ""))) {
    throw new Error("exact branch, base, and current head are required");
  }
  const card = await github.getIssue(issueNumber);
  const cardExact = await github.getIssue(issueNumber);
  if (!card || !cardExact || Number(card.number) !== issueNumber || Number(cardExact.number) !== issueNumber ||
      cardExact.body !== card.body || cardExact.state !== card.state || card.state !== "open" ||
      !String(card.body ?? "").startsWith("GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1")) {
    throw new Error("exact open G34 work-order card is required");
  }
  const activeAuthority = parseActiveControlAuthority(currentAuthority);
  const results = [];
  const readBack = new Map();
  const linkedCache = new Map();
  const readLinkedWorkerRecord = async (id) => {
    const key = String(id ?? "");
    if (!/^[1-9][0-9]*$/.test(key)) throw new Error("worker receipt chain link is missing");
    if (linkedCache.has(key)) return linkedCache.get(key);
    const first = await github.getIssueComment(key);
    const m = typeof first?.url === "string"
      ? new RegExp(`^https://github\\.com/${repositoryFullName.replace("/", "\\/")}/issues/${issueNumber}#issuecomment-(\\d+)$`).exec(first.url)
      : null;
    if (!first || String(first.id) !== key || m?.[1] !== key || first.user?.login !== "D22977") {
      throw new Error("worker receipt chain record metadata mismatch");
    }
    const exact = await github.getIssueComment(key);
    if (!exact || String(exact.id) !== key || exact.url !== first.url || exact.body !== first.body || exact.user?.login !== first.user.login) {
      throw new Error("worker receipt chain exact reread mismatch");
    }
    const fields = parseG34ReceiptFields(exact);
    linkedCache.set(key, fields);
    return fields;
  };
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
    const [claim, accepted, route, dispatch] = await Promise.all([
      readLinkedWorkerRecord(fields.claim_comment_id),
      readLinkedWorkerRecord(fields.acceptance_comment_id),
      readLinkedWorkerRecord(fields.binding_comment_id),
      readLinkedWorkerRecord(fields.dispatch_comment_id),
    ]);
    const routeBinding = route.candidate_binding;
    if (String(fields.card_comment_id) !== String(issueNumber) ||
        fields.claim_comment_id !== String(binding?.claim_comment_id) ||
        fields.acceptance_comment_id !== String(binding?.acceptance_comment_id) ||
        fields.binding_comment_id !== String(binding?.binding_comment_id) ||
        fields.dispatch_comment_id !== String(binding?.dispatch_comment_id) ||
        claim.marker !== "CLAIM_REQUESTED_V1" || claim.state !== "CLAIM_REQUESTED" ||
        accepted.marker !== "CLAIM_ACCEPTED_V1" || accepted.state !== "CLAIM_ACCEPTED" ||
        !String(accepted.accepted_claim ?? "").startsWith(`#${issueNumber}/${fields.claim_comment_id}`) ||
        claim.work_order !== `D22977/gpt-browser-bridge#${issueNumber}` ||
        accepted.work_order !== `D22977/gpt-browser-bridge#${issueNumber}` ||
        claim.role !== "Worker" || claim.model_effort !== `${binding?.model} / ${binding?.reasoning_effort}` ||
        accepted.branch !== branch || claim.branch !== branch ||
        route.marker !== "GBB_G036_211_CONTROL_ROUTE_AMENDMENT_V1" ||
        route.state !== "ONE_ALTERNATE_LOW_COST_WORKER_ROUTE_AUTHORIZED" ||
        routeBinding?.task_name !== binding?.agent_name || routeBinding?.role !== "Worker" ||
        routeBinding?.model_effort !== `${binding?.model} / ${binding?.reasoning_effort}` ||
        routeBinding?.runtime_surface !== fields.runtime_surface ||
        dispatch.marker !== "GBB_211_REVIEW_REMEDIATION_SHIFT_V1" ||
        dispatch.attempt_id !== fields.attempt_id || dispatch.lease_id !== fields.lease_id ||
        dispatch.branch !== branch || dispatch.exact_remote_base_sha !== baseSha ||
        fields.executor_identity !== `collaboration task ${routeBinding?.task_name}` ||
        fields.agent_name !== routeBinding?.task_name || fields.agent_session !== dispatch.attempt_id ||
        !String(claim.executor_identity ?? "").startsWith(`collaboration task ${routeBinding?.task_name}`) ||
        !String(accepted.executor_identity ?? "").startsWith(`collaboration task ${routeBinding?.task_name}`) ||
        !(Number(fields.claim_comment_id) < Number(fields.acceptance_comment_id) &&
          Number(fields.acceptance_comment_id) < Number(fields.dispatch_comment_id) &&
          Number(fields.dispatch_comment_id) < Number(sourceComment.id)) ||
        !String(dispatch.executor_identity ?? "").includes(routeBinding?.task_name ?? "!")) {
      throw new Error("upstream receipt is not bound to the exact card, accepted claim, Worker route, and dispatch records");
    }
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
    const saved = await recordSuccessorDelivery({
      eventId: event.event_id, receiptId: observed.receipt_id, event, controlCommentId: controlReceipt.id,
      successor, github, runtimeRoot,
    });
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
  const saved = await recordSuccessorDelivery({
    eventId: event.event_id, receiptId: result.receipt_id, event, controlCommentId: controlReceipt.id,
    successor, github, runtimeRoot,
  });
  return { ...saved, successor };
}
