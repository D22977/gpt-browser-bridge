import { parseG34ReceiptFields, parseActiveControlAuthority } from "./g34_contract.mjs";
import { createSourceEvent, publishSourceEvent, readSourceEventPublication, beginSuccessorDelivery, recordSuccessorDelivery } from "./g34_source_event_publisher.mjs";

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const executorTaskIdentity = (value) => {
  if (typeof value !== "string") return null;
  const match = /^collaboration task (\/[^\s;()]+)(?:\s*(?:\([^()\r\n]*\)|;[^\r\n]*))?$/.exec(value.trim());
  return match?.[1] ?? null;
};

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

export async function authorizeControlSuccessor({ event, publication, authority, controlReceipt, github }) {
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
  const reviewCardNumber = Number(receipt.independent_review_card_issue_number);
  const review = await readLinkedReceipt(receipt.independent_review_comment_id, reviewCardNumber);
  const adjudication = await readLinkedReceipt(receipt.adjudication_comment_id, 211);
  if (typeof github.getIssue !== "function") throw new Error("exact independent review card read is required");
  const reviewCard = await github.getIssue(Number(receipt.independent_review_card_issue_number));
  const exactReviewCard = await github.getIssue(Number(receipt.independent_review_card_issue_number));
  const reviewCardFields = reviewCard ? parseG34ReceiptFields(reviewCard) : {};
  const reviewerBinding = await readLinkedReceipt(reviewCardFields.reviewer_binding_comment_id, reviewCardNumber);
  const controlAssignment = await readLinkedReceipt(event.dispatch_comment_id, 211);
  const acceptedHead = receipt.reviewed_exact_head_sha ?? receipt.reviewed_head_sha;
  const reviewIdentity = review.reviewer_task_identity;
  const workerExecutorIdentity = event.executor_identity ?? `collaboration task ${event.agent_name}`;
  const controlIdentityIsWorker = reviewerBinding.control_task_identity === event.agent_name ||
    reviewerBinding.control_task_identity === event.agent_session ||
    reviewerBinding.control_task_identity === workerExecutorIdentity ||
    executorTaskIdentity(workerExecutorIdentity) === reviewerBinding.control_task_identity;
  const currentControlPointers = liveAuthority.record_ids;
  if (
    !event || !authority || publication?.state !== "DELIVERED" ||
    String(publication.comment_id ?? "") !== String(event.comment_id ?? "") ||
    String(publication.source_comment_id ?? "") !== String(event.source_comment_id ?? "") ||
    !/^[0-9a-f]{40}$/.test(String(event.tree_sha ?? "")) ||
    !event.body.includes(`tree_sha=${event.tree_sha}`) ||
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
    controlAssignment.marker !== "GBB_211_REVIEW_REMEDIATION_SHIFT_V1" ||
    controlAssignment.state !== "SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES" ||
    controlAssignment.recorded_by_role !== "LOCAL_CONTROL_TOWER" ||
    !nonEmpty(controlAssignment.control_task_identity) ||
    executorTaskIdentity(controlAssignment.executor_identity) !== event.agent_name ||
    controlAssignment.branch !== event.branch ||
    receipt.current_switch_comment_id !== currentControlPointers?.switch_comment_id ||
    receipt.current_index43_comment_id !== currentControlPointers?.index43_comment_id ||
    receipt.current_index81_comment_id !== currentControlPointers?.index81_comment_id ||
    Number(receipt.independent_review_card_issue_number) < 1 || !reviewCard ||
    Number(reviewCard.number) !== Number(receipt.independent_review_card_issue_number) ||
    !exactReviewCard || Number(exactReviewCard.number) !== Number(reviewCard.number) ||
    exactReviewCard.state !== reviewCard.state || exactReviewCard.body !== reviewCard.body ||
    !String(reviewCard.body ?? "").startsWith("GBB_G34_FRESH_REVIEW_REMEDIATION_WORK_ORDER_V1") ||
    reviewCardFields.candidate_repository !== "D22977/gpt-browser-bridge" ||
    reviewCardFields.candidate_branch !== event.branch ||
    reviewCardFields.candidate_exact_head_sha !== event.head_sha ||
    !/^[0-9a-f]{40}$/.test(String(reviewCardFields.candidate_tree_sha ?? "")) ||
    (event.tree_sha !== undefined && reviewCardFields.candidate_tree_sha !== event.tree_sha) ||
    acceptedHead !== event.head_sha ||
    review.marker !== "GBB_G34_FRESH_INDEPENDENT_REVIEW_RESULT_V1" ||
    review.decision !== "APPROVE" || review.state !== "REVIEW_TERMINAL" ||
    review.card !== `#${reviewCard.number}` ||
    review.reviewer_binding_comment_id !== reviewerBinding.id ||
    reviewerBinding.marker !== "GBB_G34_REVIEWER_BINDING_V1" ||
    reviewerBinding.state !== "REVIEWER_ASSIGNED" ||
    reviewerBinding.card_issue_number !== String(reviewCard.number) ||
    reviewerBinding.role !== "fresh independent GPT-6 Sol High read-only Reviewer" ||
    reviewerBinding.recorded_by_role !== "LOCAL_CONTROL_TOWER" ||
    reviewerBinding.model !== "gpt-6-sol" || reviewerBinding.reasoning_effort !== "high" ||
    !nonEmpty(reviewerBinding.reviewer_task_identity) ||
    !nonEmpty(reviewerBinding.control_task_identity) ||
    controlIdentityIsWorker ||
    reviewerBinding.worker_task_identity !== event.agent_name ||
    reviewerBinding.control_task_identity !== controlAssignment.control_task_identity ||
    reviewerBinding.reviewer_task_identity === reviewerBinding.control_task_identity ||
    reviewerBinding.reviewer_task_identity === event.agent_name ||
    reviewerBinding.reviewer_task_identity === event.agent_session ||
    reviewerBinding.reviewer_task_identity === workerExecutorIdentity ||
    executorTaskIdentity(workerExecutorIdentity) === reviewerBinding.reviewer_task_identity ||
    reviewerBinding.reviewer_task_identity === receipt.executor_identity ||
    review.reviewer_task_identity !== reviewerBinding.reviewer_task_identity ||
    reviewerBinding.candidate_repository !== "D22977/gpt-browser-bridge" ||
    reviewerBinding.candidate_branch !== event.branch ||
    reviewerBinding.candidate_exact_head_sha !== event.head_sha ||
    reviewerBinding.candidate_tree_sha !== reviewCardFields.candidate_tree_sha ||
    reviewCardFields.candidate_tree_sha !== event.tree_sha ||
    Number(reviewerBinding.id) >= Number(review.id) ||
    review.reviewed_repository !== "D22977/gpt-browser-bridge" ||
    review.reviewed_branch !== event.branch ||
    review.reviewed_exact_head !== event.head_sha ||
    review.reviewed_tree !== reviewCardFields.candidate_tree_sha ||
    !/^fresh independent GPT-6 Sol High read-only Reviewer$/i.test(review.role ?? "") ||
    !nonEmpty(reviewIdentity) || reviewIdentity === event.agent_name ||
    reviewIdentity === event.agent_session || reviewIdentity === receipt.executor_identity ||
    receipt.independent_review_decision !== review.decision ||
    adjudication.marker !== "ACTIVE_CONTROL_ADJUDICATION_V1" ||
    adjudication.state !== "ACCEPTED" ||
    adjudication.recorded_by_role !== "ACTIVE_CONTROL" ||
    adjudication.active_control_id !== liveAuthority.active_control_id ||
    adjudication.source_event_id !== event.event_id ||
    adjudication.source_event_comment_id !== String(event.comment_id) ||
    Number(event.comment_id) >= Number(adjudication.id) || Number(adjudication.id) >= Number(review.id) ||
    Number(adjudication.id) >= Number(receipt.id) ||
    receipt.adjudication_state !== adjudication.state ||
    receipt.semantic_sequence !== "WORKER_RECEIPT_SOURCE_EVENT_ACTIVE_CONTROL_ADJUDICATION_INDEPENDENT_REVIEW_CURRENT_CONTROL_ACK" ||
    String(receipt.successor_count) !== "1"
  ) throw new Error("current authenticated Control acceptance does not satisfy the G34 semantic sequence and single-successor boundary");

  const successor = {
    comment_id: receipt.successor_comment_id,
    agent_name: receipt.successor_agent_name,
    agent_session: receipt.successor_agent_session,
    pane: receipt.successor_pane,
    terminal: receipt.successor_terminal,
  };
  if (!successor || !/^[1-9][0-9]*$/.test(String(successor.comment_id ?? "")) ||
      ![successor.agent_name, successor.agent_session, successor.pane, successor.terminal].every(nonEmpty)) {
    throw new Error("Control successor binding is incomplete");
  }
  return {
    comment_id: String(successor.comment_id),
    agent_name: successor.agent_name,
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
    const fields = { ...parseG34ReceiptFields(exact), id: String(exact.id) };
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
    const fields = { ...parseG34ReceiptFields(sourceComment), id: String(sourceComment.id) };
    const eventKind = fields.marker === "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1"
      ? "WORKER_STARTED"
      : fields.marker === "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1" ? "WORKER_TERMINAL_RESULT" : null;
    if (!eventKind || !fields.state) throw new Error("unsupported G34 executor receipt");
    const workerStart = eventKind === "WORKER_STARTED"
      ? fields
      : await readLinkedWorkerRecord(fields.worker_start_comment_id);
    const [claim, accepted, route, dispatch] = await Promise.all([
      readLinkedWorkerRecord(fields.claim_comment_id ?? workerStart.claim_comment_id),
      readLinkedWorkerRecord(fields.acceptance_comment_id ?? workerStart.acceptance_comment_id),
      readLinkedWorkerRecord(fields.binding_comment_id ?? workerStart.binding_comment_id),
      readLinkedWorkerRecord(fields.dispatch_comment_id ?? workerStart.dispatch_comment_id),
    ]);
    const routeBinding = route.candidate_binding;
    const sameWorkerLink = (key) => fields[key] === workerStart[key];
    const acceptedWorkOrder = `D22977/gpt-browser-bridge#${issueNumber} / GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1`;
    const chainChecks = {
      start_marker: workerStart.marker === "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1",
      start_state: workerStart.state === "CONSUMED_STARTED",
      card: workerStart.card_comment_id === String(issueNumber),
      claim_link: workerStart.claim_comment_id === String(claim.id),
      acceptance_link: workerStart.acceptance_comment_id === String(accepted.id),
      route_link: workerStart.binding_comment_id === String(route.id),
      dispatch_link: workerStart.dispatch_comment_id === String(dispatch.id),
      claim_record: claim.marker === "CLAIM_REQUESTED_V1" && claim.state === "CLAIM_REQUESTED",
      accepted_record: accepted.marker === "CLAIM_ACCEPTED_V1" && accepted.state === "CLAIM_ACCEPTED",
      accepted_claim: String(accepted.accepted_claim ?? "").startsWith(`#${issueNumber}/${claim.id}`),
      claim_work_order: claim.work_order === `D22977/gpt-browser-bridge#${issueNumber}`,
      acceptance_work_order: accepted.work_order === acceptedWorkOrder,
      claim_tuple: claim.role === "Worker" && claim.model_effort === routeBinding?.model_effort,
      claim_branch: accepted.branch === workerStart.branch && claim.branch === workerStart.branch,
      route: route.marker === "GBB_G036_211_CONTROL_ROUTE_AMENDMENT_V1" && route.state === "ONE_ALTERNATE_LOW_COST_WORKER_ROUTE_AUTHORIZED",
      route_binding: routeBinding?.task_name === workerStart.agent_name && routeBinding?.role === "Worker" &&
        routeBinding?.model_effort === `${workerStart.model} / ${workerStart.reasoning_effort}` &&
        routeBinding?.runtime_surface === workerStart.runtime_surface,
      dispatch: dispatch.marker === "GBB_211_REVIEW_REMEDIATION_SHIFT_V1" &&
        dispatch.attempt_id === workerStart.attempt_id && dispatch.lease_id === workerStart.lease_id &&
        dispatch.branch === workerStart.branch && dispatch.exact_remote_base_sha === workerStart.base_sha,
      executor: workerStart.executor_identity === `collaboration task ${routeBinding?.task_name}` &&
        workerStart.agent_session === dispatch.attempt_id &&
        executorTaskIdentity(claim.executor_identity) === routeBinding?.task_name &&
        executorTaskIdentity(accepted.executor_identity) === routeBinding?.task_name &&
        executorTaskIdentity(dispatch.executor_identity) === routeBinding?.task_name,
      chronology: Number(route.id) < Number(claim.id) && Number(claim.id) < Number(accepted.id) &&
        Number(accepted.id) < Number(dispatch.id) && Number(dispatch.id) < Number(workerStart.id),
      assigned_base: workerStart.branch === branch && workerStart.base_sha === baseSha && workerStart.head_sha === workerStart.base_sha,
    };
    const invalidChain = Object.keys(chainChecks).filter((key) => !chainChecks[key]);
    if (invalidChain.length) throw new Error(`upstream Worker chain invalid: ${invalidChain.join(",")}`);
    const terminalMismatches = [["claim_comment_id", String(claim.id)], ["acceptance_comment_id", String(accepted.id)],
          ["binding_comment_id", String(route.id)], ["dispatch_comment_id", String(dispatch.id)],
          ["executor_identity", workerStart.executor_identity], ["lease_id", workerStart.lease_id],
          ["attempt_id", workerStart.attempt_id], ["branch", workerStart.branch],
          ["base_sha", workerStart.base_sha], ["card_comment_id", String(issueNumber)]]
          .filter(([key, value]) => fields[key] !== undefined && fields[key] !== value).map(([key]) => key);
    if (eventKind === "WORKER_TERMINAL_RESULT" &&
        (terminalMismatches.length > 0 ||
         fields.worker_start_comment_id !== workerStart.id)) {
      throw new Error(`terminal result does not bind to its exact G13/G14 start receipt: ${terminalMismatches.join(",")}`);
    }
    if (!(Number(route.id) < Number(claim.id) && Number(claim.id) < Number(accepted.id) &&
          Number(accepted.id) < Number(dispatch.id) && Number(dispatch.id) < Number(workerStart.id) &&
          (eventKind === "WORKER_STARTED"
            ? String(workerStart.id) === String(sourceComment.id)
            : Number(workerStart.id) < Number(sourceComment.id)))) {
      throw new Error("Worker receipt chain chronology is invalid");
    }
    if (String(workerStart.card_comment_id) !== String(issueNumber) ||
        claim.marker !== "CLAIM_REQUESTED_V1" || claim.state !== "CLAIM_REQUESTED" ||
        accepted.marker !== "CLAIM_ACCEPTED_V1" || accepted.state !== "CLAIM_ACCEPTED") {
      throw new Error("Worker claim and acceptance records are invalid");
    }
    const workerBinding = {
      card_comment_id: String(issueNumber),
      claim_comment_id: String(claim.id),
      acceptance_comment_id: String(accepted.id),
      binding_comment_id: String(route.id),
      dispatch_comment_id: String(dispatch.id),
      agent_name: workerStart.agent_name,
      agent_session: workerStart.agent_session,
      pane: workerStart.pane,
      terminal: workerStart.terminal,
      cwd: workerStart.cwd,
      model: workerStart.model,
      reasoning_effort: workerStart.reasoning_effort,
      runtime_surface: workerStart.runtime_surface,
      executor_identity: workerStart.executor_identity,
      branch: workerStart.branch,
      base_sha: workerStart.base_sha,
      lease_id: workerStart.lease_id,
      attempt_id: workerStart.attempt_id,
      start_comment_id: String(workerStart.id),
    };
    if (sourceComment.user?.login !== publisherAuthor ||
        (eventKind === "WORKER_STARTED" && (fields.claim_comment_id !== String(claim.id) ||
          fields.acceptance_comment_id !== String(accepted.id) || fields.binding_comment_id !== String(route.id) ||
          fields.dispatch_comment_id !== String(dispatch.id))) ||
        (eventKind === "WORKER_TERMINAL_RESULT" && [["claim_comment_id", String(claim.id)],
          ["acceptance_comment_id", String(accepted.id)], ["binding_comment_id", String(route.id)],
          ["dispatch_comment_id", String(dispatch.id)]].some(([key, value]) => fields[key] !== undefined && fields[key] !== value)) ||
        (fields.control_generation !== undefined && fields.control_generation !== activeAuthority.control_generation) ||
        (fields.control_conversation_id !== undefined && fields.control_conversation_id !== activeAuthority.control_conversation_id) ||
        fields.state === undefined || fields.branch !== workerBinding.branch ||
        (fields.base_sha !== undefined && fields.base_sha !== workerBinding.base_sha) ||
        (fields.executor_identity !== undefined && fields.executor_identity !== workerBinding.executor_identity) ||
        (eventKind === "WORKER_STARTED" ? fields.user_relay_count !== "0" :
          (fields.user_relay_count !== undefined && fields.user_relay_count !== "0")) ||
        (fields.agent_name !== undefined && fields.agent_name !== workerBinding.agent_name) ||
        (fields.agent_session !== undefined && fields.agent_session !== workerBinding.agent_session) ||
        (fields.pane !== undefined && fields.pane !== workerBinding.pane) ||
        (fields.terminal !== undefined && fields.terminal !== workerBinding.terminal) ||
        (fields.cwd !== undefined && fields.cwd !== workerBinding.cwd) ||
        (fields.model !== undefined && fields.model !== workerBinding.model) ||
        (fields.reasoning_effort !== undefined && fields.reasoning_effort !== workerBinding.reasoning_effort) ||
        (fields.repository !== undefined && fields.repository !== repositoryFullName)) {
      throw new Error("executor receipt does not match its exact Worker start and upstream chain");
    }
    if (eventKind === "WORKER_STARTED" && fields.state !== "CONSUMED_STARTED") {
      throw new Error("Worker start receipt has an invalid state");
    }
    if (eventKind === "WORKER_STARTED" && fields.head_sha !== fields.base_sha) {
      throw new Error("Worker start receipt head must equal the exact clean base");
    }
    if (eventKind === "WORKER_TERMINAL_RESULT") {
      const startId = String(fields.worker_start_comment_id ?? "");
      if (startId !== workerBinding.start_comment_id) {
        throw new Error("terminal result lacks its exact matching Worker start receipt chain");
      }
      const terminalHead = fields.head_sha ?? fields.remote_commit ?? fields.local_tested_commit;
      if (terminalHead !== headSha ||
          !(fields.state === "READY_FOR_FRESH_REVIEW" || /^BLOCKED_[A-Z0-9_]+$/.test(fields.state))) {
        throw new Error("Worker terminal receipt is not bound to the exact current head and a valid terminal state");
      }
    }
    const event = createSourceEvent({
      sourceComment,
      sourceIssueNumber: issueNumber,
      sourceRepositoryFullName: repositoryFullName,
      eventKind,
      authority: activeAuthority,
      binding: workerBinding,
      branch: fields.branch,
      baseSha: fields.base_sha ?? workerBinding.base_sha,
      headSha: fields.head_sha ?? fields.remote_commit ?? fields.local_tested_commit,
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
  const publication = await readSourceEventPublication({
    eventId: event.event_id,
    sourceCommentId: event.source_comment_id,
    eventCommentId: event.comment_id,
    runtimeRoot,
  });
  const successor = await authorizeControlSuccessor({ event, publication, authority, controlReceipt, github });
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
