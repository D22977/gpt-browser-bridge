// GitHub transport for the resident contract. This module has no import-time I/O.
import { createHash } from "node:crypto";
const TYPES = new Set([
  "LOCAL_CONTROL_RESIDENT_LEASE_V1", "LOCAL_CONTROL_RESIDENT_HEARTBEAT_V1",
  "LOCAL_CONTROL_WAKE_REQUEST_V1", "ACTIVE_CONTROL_WAKE_ACK_V1",
  "ACTIVE_CONTROL_SOURCE_DECISION_V1", "LOCAL_CONTROL_EXECUTOR_RELEASE_V1",
]);
const EVENTS = new Set(["TERMINAL", "CONTROL_NEEDED", "PROGRESS"]);
const AUTHORITY = { start: /^CURRENT_REHYDRATION_INDEX_V\d+$/, registry: /^CURRENT_REGISTRY_INDEX_V\d+$/, switch: "CONTROL_GENERATION_ATOMIC_SWITCH_V1" };
const REQUIRED = {
  LOCAL_CONTROL_RESIDENT_LEASE_V1: ["lease_id", "resident_instance_id", "control_generation", "active_control_conversation_id", "acquired_at", "expires_at", "watched_issue_set", "trigger_contract_hash", "idempotency_key", "readback_required"],
  LOCAL_CONTROL_RESIDENT_HEARTBEAT_V1: ["lease_id", "resident_instance_id", "control_generation", "trigger_contract_hash", "observed_at", "lease_expires_at", "last_processed_comment_id"],
  LOCAL_CONTROL_WAKE_REQUEST_V1: ["wake_request_id", "lease_id", "resident_instance_id", "source_repo", "source_issue", "source_comment_id", "source_event_type", "control_generation", "active_control_conversation_id", "trigger_contract_hash", "idempotency_key"],
  ACTIVE_CONTROL_WAKE_ACK_V1: ["wake_request_id", "source_comment_id", "control_generation", "active_control_conversation_id", "rehydrated_current_start_receipt", "rehydrated_current_registry_receipt", "rehydrated_active_switch_receipt", "ack_idempotency_key"],
  ACTIVE_CONTROL_SOURCE_DECISION_V1: ["wake_request_id", "source_comment_id", "control_generation", "active_control_conversation_id", "ack_comment_id", "named_executor", "decision_idempotency_key"],
  LOCAL_CONTROL_EXECUTOR_RELEASE_V1: ["release_id", "idempotency_key", "wake_request_id", "source_repo", "source_issue", "source_comment_id", "control_generation", "active_control_conversation_id", "ack_comment_id", "decision_comment_id", "named_executor", "readback_required"],
  GITHUB_SOURCE_EVENT_V1: ["source_repo", "source_issue", "source_comment_id", "source_event_type", "control_generation", "active_control_conversation_id"],
};
const ID_FIELDS = new Set(["github_comment_id", "source_comment_id", "ack_comment_id", "decision_comment_id", "last_processed_comment_id"]);

function stop(code) { throw new Error(code); }
function decimal(value) {
  const string = String(value);
  if (!/^[1-9]\d*$/.test(string)) stop("MALFORMED_COMMENT_ID");
  return string;
}
function pointer(body, key, issue) {
  const matches = [...body.matchAll(new RegExp(`^${key}: Issue #${issue} comment ([1-9]\\d*)`, "gm"))];
  if (matches.length !== 1) stop("AUTHORITY_POINTER_MISMATCH");
  return matches[0][1];
}
function fields(body) {
  const output = {};
  for (const line of body.split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const match = /^([a-z][a-z0-9_]*): (.+)$/.exec(line);
    if (!match) stop("MALFORMED_RECOGNIZED_RECEIPT");
    if (Object.hasOwn(output, match[1])) stop("MALFORMED_RECOGNIZED_RECEIPT");
    let value = match[2];
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (match[1] === "source_issue") {
      if (!/^[1-9]\d*$/.test(value)) stop("MALFORMED_RECOGNIZED_RECEIPT");
      value = Number(value);
      if (!Number.isSafeInteger(value)) stop("MALFORMED_RECOGNIZED_RECEIPT");
    }
    else if (value.startsWith("[") || value.startsWith("{")) {
      try { value = JSON.parse(value); } catch { stop("MALFORMED_RECOGNIZED_RECEIPT"); }
    }
    output[match[1]] = value;
  }
  return output;
}
function validateFields(type, parsed) {
  const required = REQUIRED[type];
  const allowed = new Set([...required, "type", "github_comment_id", ...(type === "GITHUB_SOURCE_EVENT_V1" ? ["named_executor"] : [])]);
  if (required.some(key => !Object.hasOwn(parsed, key)) || Object.keys(parsed).some(key => !allowed.has(key))) stop("MALFORMED_RECOGNIZED_RECEIPT");
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "source_issue") {
      if (!Number.isSafeInteger(value) || value <= 0) stop("MALFORMED_RECOGNIZED_RECEIPT");
    } else if (key === "watched_issue_set") {
      if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== "string" || !item)) stop("MALFORMED_RECOGNIZED_RECEIPT");
    } else if (key === "readback_required") {
      if (value !== true) stop("MALFORMED_RECOGNIZED_RECEIPT");
    } else if (typeof value !== "string" || !value.trim()) stop("MALFORMED_RECOGNIZED_RECEIPT");
    if (ID_FIELDS.has(key)) decimal(value);
    if (["acquired_at", "expires_at", "observed_at", "lease_expires_at"].includes(key) && !Number.isFinite(Date.parse(value))) stop("MALFORMED_RECOGNIZED_RECEIPT");
  }
  if (type === "GITHUB_SOURCE_EVENT_V1" && !EVENTS.has(parsed.source_event_type)) stop("MALFORMED_SOURCE_EVENT");
  if (type === "GITHUB_SOURCE_EVENT_V1" && ["TERMINAL", "CONTROL_NEEDED"].includes(parsed.source_event_type) && !parsed.named_executor) stop("MALFORMED_SOURCE_EVENT");
}
function issueOf(comment) {
  const match = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(comment.issue_url || "");
  if (!match) stop("GITHUB_COMMENT_PROVENANCE_MISSING");
  return { repo: match[1], issue: Number(match[2]) };
}
function receipt(comment, expectedRepo, expectedIssue) {
  const origin = issueOf(comment);
  if (origin.repo !== expectedRepo || origin.issue !== expectedIssue) stop("GITHUB_COMMENT_PROVENANCE_MISMATCH");
  const id = decimal(comment.id);
  const body = comment.body;
  if (typeof body !== "string") stop("MALFORMED_GITHUB_COMMENT");
  const type = body.split(/\r?\n/, 1)[0].trim();
  if (!TYPES.has(type) && type !== "GITHUB_SOURCE_EVENT_V1") return null;
  const parsed = fields(body);
  validateFields(type, parsed);
  if (parsed.type && parsed.type !== type) stop("MALFORMED_RECOGNIZED_RECEIPT");
  if (parsed.github_comment_id && decimal(parsed.github_comment_id) !== id) stop("GITHUB_COMMENT_PROVENANCE_MISMATCH");
  if (type === "GITHUB_SOURCE_EVENT_V1") {
    if (!EVENTS.has(parsed.source_event_type) || parsed.source_repo !== expectedRepo || Number(parsed.source_issue) !== expectedIssue || decimal(parsed.source_comment_id) !== id || !parsed.control_generation || !parsed.active_control_conversation_id || ((parsed.source_event_type === "TERMINAL" || parsed.source_event_type === "CONTROL_NEEDED") && !parsed.named_executor)) stop("MALFORMED_SOURCE_EVENT");
    return { ...parsed, type, source_issue: expectedIssue, source_comment_id: id, github_comment_id: id };
  }
  if (parsed.source_repo && (parsed.source_repo !== expectedRepo || !Number.isSafeInteger(parsed.source_issue) || parsed.source_issue <= 0)) stop("MALFORMED_RECOGNIZED_RECEIPT");
  return { ...parsed, type, github_comment_id: id };
}

export function createGitHubAuthorityAdapter({
  token,
  repository = "D22977/gpt-browser-bridge",
  authorityIssueNumbers = { control: 88, registry: 43, switch: 81 },
  sourceIssueNumber = 162,
  fetchImpl = globalThis.fetch,
  publisher,
} = {}) {
  if (typeof token !== "string" || !token.trim()) stop("GITHUB_AUTH_REQUIRED");
  if (!/^[^/]+\/[^/]+$/.test(repository) || typeof fetchImpl !== "function"
    || !authorityIssueNumbers || ![authorityIssueNumbers.control, authorityIssueNumbers.registry, authorityIssueNumbers.switch, sourceIssueNumber].every((issue) => Number.isSafeInteger(issue) && issue > 0)) stop("MALFORMED_ADAPTER_CONFIG");
  const root = `https://api.github.com/repos/${repository}`;
  const supportedIssues = [...new Set([authorityIssueNumbers.registry, authorityIssueNumbers.switch, authorityIssueNumbers.control, sourceIssueNumber])];
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}` };
  async function request(url, options = {}) {
    let response;
    try { response = await fetchImpl(url, { ...options, headers: { ...headers, ...options.headers }, redirect: "error" }); }
    catch { stop("GITHUB_API_UNAVAILABLE"); }
    if (!response?.ok) stop(response?.status === 401 || response?.status === 403 ? "GITHUB_AUTH_OR_RATE_LIMIT" : "GITHUB_API_UNAVAILABLE");
    let data;
    try { data = await response.json(); } catch { stop("MALFORMED_GITHUB_RESPONSE"); }
    return { data, link: response.headers.get("link") };
  }
  async function allComments(issue) {
    if (!Number.isSafeInteger(issue) || issue <= 0) stop("MALFORMED_ISSUE");
    const rows = [], seen = new Set();
    let page = 1;
    let next = `${root}/issues/${issue}/comments?per_page=100&page=1`;
    while (next) {
      if (seen.has(next) || next !== `${root}/issues/${issue}/comments?per_page=100&page=${page}`) stop("INCOMPLETE_GITHUB_PAGINATION");
      seen.add(next);
      const { data, link } = await request(next);
      if (!Array.isArray(data)) stop("MALFORMED_GITHUB_RESPONSE");
      rows.push(...data);
      const relations = new Map();
      if (link !== null) {
        if (typeof link !== "string" || !link.trim()) stop("INCOMPLETE_GITHUB_PAGINATION");
        for (const part of link.split(/,\s*/)) {
          const match = /^<([^<>]+)>;\s*rel="(next|prev|first|last)"$/.exec(part);
          if (!match || relations.has(match[2])) stop("INCOMPLETE_GITHUB_PAGINATION");
          let url;
          try { url = new URL(match[1]); } catch { stop("INCOMPLETE_GITHUB_PAGINATION"); }
          if (url.origin !== "https://api.github.com" || url.pathname !== `/repos/${repository}/issues/${issue}/comments` || url.searchParams.size !== 2 || url.searchParams.get("per_page") !== "100" || !/^[1-9]\d*$/.test(url.searchParams.get("page") || "")) stop("INCOMPLETE_GITHUB_PAGINATION");
          relations.set(match[2], Number(url.searchParams.get("page")));
        }
      }
      if (relations.has("next") && (relations.get("next") !== page + 1 || data.length !== 100)) stop("INCOMPLETE_GITHUB_PAGINATION");
      if (relations.has("prev") && (page <= 1 || relations.get("prev") !== page - 1)) stop("INCOMPLETE_GITHUB_PAGINATION");
      if (relations.has("first") && relations.get("first") !== 1) stop("INCOMPLETE_GITHUB_PAGINATION");
      if (relations.has("last") && (relations.get("last") < page || (relations.has("next") && relations.get("last") < relations.get("next")) || (!relations.has("next") && relations.get("last") !== page))) stop("INCOMPLETE_GITHUB_PAGINATION");
      if (!relations.has("next") && data.length === 100 && relations.get("last") !== page) stop("INCOMPLETE_GITHUB_PAGINATION");
      next = relations.has("next") ? `${root}/issues/${issue}/comments?per_page=100&page=${++page}` : null;
    }
    const ids = new Set();
    for (const row of rows) {
      const id = decimal(row.id);
      if (ids.has(id)) stop("DUPLICATE_GITHUB_COMMENT");
      ids.add(id);
      if (issueOf(row).repo !== repository || issueOf(row).issue !== issue) stop("GITHUB_COMMENT_PROVENANCE_MISMATCH");
    }
    return rows;
  }
  async function exactComment(id) {
    const { data } = await request(`${root}/issues/comments/${decimal(id)}`);
    if (decimal(data?.id) !== decimal(id) || issueOf(data).repo !== repository) stop("RECEIPT_READBACK_MISMATCH");
    return data;
  }
  async function exactIssueComment(id, issue, body) {
    const fetched = await exactComment(id);
    if (issueOf(fetched).issue !== issue || fetched.body !== body) stop("RECEIPT_READBACK_MISMATCH");
    return fetched;
  }
  function admissions(comment) {
    const lines = [...comment.body.matchAll(/^producer_admission_comment_ids: (.+)$/gm)];
    if (lines.length > 1) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    if (!lines.length) return [];
    let ids;
    try { ids = JSON.parse(lines[0][1]); } catch { stop("AUTHORITY_CONFLICT_OR_MALFORMED"); }
    if (!Array.isArray(ids)) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    return ids.map(decimal);
  }

  function closedFields(body, allowedNames, requiredNames) {
    const values = {};
    for (const line of body.split(/\r?\n/)) {
      const match = /^([A-Za-z][A-Za-z0-9_]*): (.+)$/.exec(line);
      if (!match) {
        if (line.includes(":")) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
        continue;
      }
      if (!allowedNames.has(match[1]) || Object.hasOwn(values, match[1])) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
      values[match[1]] = match[2];
    }
    if (requiredNames.some((name) => !Object.hasOwn(values, name))) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    return values;
  }

  function sectionedPointer(value, issue, suffix = "") {
    const match = new RegExp(`^#${issue}/([1-9]\\d*)${suffix}$`).exec(value);
    if (!match) stop("AUTHORITY_POINTER_MISMATCH");
    return decimal(match[1]);
  }

  function sectionedHeader(comment, type, issue) {
    const origin = issueOf(comment);
    if (origin.repo !== repository || origin.issue !== issue || typeof comment.body !== "string"
      || comment.body.split(/\r?\n/, 1)[0] !== type) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    return comment.body;
  }

  function uniqueSection(body, name, precedingName, followingName) {
    const headings = [...body.matchAll(/^([A-Z][A-Z0-9_]*)$/gm)];
    const named = (value) => headings.filter((heading) => heading[1] === value);
    const previous = precedingName ? named(precedingName) : [];
    const current = named(name), next = named(followingName);
    if (current.length !== 1 || next.length !== 1 || current[0].index >= next[0].index
      || (precedingName && (previous.length !== 1 || previous[0].index >= current[0].index))
      || (!precedingName && headings[0] !== current[0])) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    const nextHeading = headings.find((heading) => heading.index > current[0].index);
    if (nextHeading !== next[0]) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    return body.slice(current[0].index + current[0][0].length, next[0].index);
  }

  function validGeneration(value) {
    if (!/^[0-9]{3}$/.test(value) || value === "000") stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    return value;
  }

  function currentGeneration(value) {
    const match = /^([0-9]{3}) ACTIVE$/.exec(value);
    if (!match) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    return validGeneration(match[1]);
  }

  function validConversationId(value) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    return value;
  }

  function validConversationUrl(identity, value) {
    validConversationId(identity);
    let url;
    try { url = new URL(value); } catch { stop("AUTHORITY_CONFLICT_OR_MALFORMED"); }
    if (url.origin !== "https://chatgpt.com" || !url.pathname.endsWith(`/c/${identity}`) || url.search || url.hash) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
  }

  async function sectionedAuthority(start, registry) {
    const startIssue = authorityIssueNumbers.registry;
    const registryIssue = authorityIssueNumbers.switch;
    const controlIssue = authorityIssueNumbers.control;
    const startReadback = await exactIssueComment(start.id, startIssue, start.body);
    const registryReadback = await exactIssueComment(registry.id, registryIssue, registry.body);
    const startBody = sectionedHeader(startReadback, "CURRENT_REHYDRATION_INDEX_V243", startIssue);
    const registryBody = sectionedHeader(registryReadback, "CURRENT_REGISTRY_INDEX_V139", registryIssue);
    const startFields = closedFields(startBody, new Set([
      "state", "recorded_by_role", "repository", "control_generation", "supersedes", "active_control_ack",
      "inventory_return", "active_repair_card", "owner_continuation", "operational_goal_complete",
      "startup_skill_memory_reads", "old_inventory_terminal", "old_scope_evidence", "old_event",
      "source_checkout_identity", "matching_process_state", "matching_scheduled_task_state", "activation_target",
      "user_relay_count", "readback_required", "idempotency_key",
    ]), ["state", "recorded_by_role", "repository", "control_generation", "active_control_ack"]);
    const registryFields = closedFields(registryBody, new Set([
      "state", "recorded_by_role", "repository", "control_generation", "supersedes", "current_start",
      "active_control_id", "active_control_ack", "GitHub_sole_durable_semantic_authority", "owner_continuation",
      "restoration_goal_complete", "current_repair_card", "prior_inventory_terminal", "scope_evidence",
      "old_inventory_event", "executor_required", "source_checkout_identity", "matching_process_state",
      "matching_scheduled_task_state", "activation_target", "runtime_activation", "generation033_lease",
      "matching_fresh_heartbeat", "watcher_running", "monitoring_claimed", "merge_release_deploy_workflow_dispatch",
      "next_action", "user_relay_count", "readback_required", "idempotency_key",
    ]), ["state", "recorded_by_role", "repository", "control_generation", "current_start", "active_control_id", "active_control_ack"]);
    if (startFields.repository !== repository || registryFields.repository !== repository) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    const generation = currentGeneration(startFields.control_generation);
    if (generation !== currentGeneration(registryFields.control_generation)) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    const startAckId = sectionedPointer(startFields.active_control_ack, controlIssue);
    const registryAckId = sectionedPointer(registryFields.active_control_ack, controlIssue);
    if (startAckId !== registryAckId) stop("AUTHORITY_POINTER_MISMATCH");
    const currentStart = new RegExp(`^#${startIssue}/([1-9]\\d*) V243 exact GET matched$`).exec(registryFields.current_start);
    if (!currentStart || decimal(currentStart[1]) !== decimal(startReadback.id)) stop("AUTHORITY_POINTER_MISMATCH");

    const ack = await exactComment(startAckId);
    const ackBody = sectionedHeader(ack, "ACTIVE_CONTROL_REHYDRATION_ACK_V1", controlIssue);
    const ackFields = closedFields(ackBody, new Set([
      "state", "recorded_by_role", "repository", "generation", "display_name", "conversation_id", "conversation_url",
      "request", "atomic_switch", "current_start", "current_registry", "current_handoff", "binding",
      "sole_active_control_generation", "sole_active_control_identity_match", "generation031", "generation032",
      "state_pointer_consistency", "preserved_inventory_card", "preserved_worker_start", "preserved_worker_terminal",
      "preserved_scope_evidence", "preserved_return_request", "prior_inventory_event_replay", "fresh_review",
      "semantic_adjudication_performed", "successor_authorized_or_dispatched", "review_performed",
      "runtime_activation_performed", "generation033_lease", "matching_fresh_heartbeat", "watcher_running",
      "monitoring_claimed", "idempotency_key", "user_relay_count", "readback_required",
    ]), ["state", "repository", "generation", "conversation_id", "conversation_url", "atomic_switch", "sole_active_control_generation", "sole_active_control_identity_match"]);
    if (ackFields.repository !== repository || ackFields.state !== "ACTIVE_REHYDRATED_ACKNOWLEDGED"
      || ackFields.generation !== generation || ackFields.sole_active_control_generation !== generation
      || ackFields.sole_active_control_identity_match !== "true") stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    sectionedPointer(ackFields.current_start, startIssue, " V[1-9]\\d* exact GET matched");
    sectionedPointer(ackFields.current_registry, registryIssue, " V[1-9]\\d* exact GET matched");
    if (registryFields.active_control_id !== ackFields.conversation_id) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    validConversationUrl(ackFields.conversation_id, ackFields.conversation_url);
    const switchId = sectionedPointer(ackFields.atomic_switch, controlIssue, " exact GET matched");

    const active = await exactComment(switchId);
    const activeBody = sectionedHeader(active, "CONTROL_GENERATION_ATOMIC_SWITCH_V1", controlIssue);
    const oldHeading = /^OLD_CONTROL$/gm;
    const oldMatches = [...activeBody.matchAll(oldHeading)];
    if (oldMatches.length !== 1) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    const topFields = closedFields(activeBody.slice(0, oldMatches[0].index), new Set([
      "state", "recorded_by_role", "repository", "rotation_id", "idempotency_key", "source_previous_active_switch",
      "source_route_correction", "source_rotation", "candidate_binding", "candidate_generation_ACK",
      "candidate_continuity_ACK", "candidate_route_PASS", "independent_Local_Transport_R3",
      "current_start_before_switch", "current_registry_before_switch", "current_handoff_before_switch",
    ]), ["state", "recorded_by_role", "repository", "rotation_id", "idempotency_key"]);
    if (topFields.repository !== repository) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    const oldControl = uniqueSection(activeBody.slice(activeBody.indexOf("\n") + 1), "OLD_CONTROL", null, "NEW_CONTROL");
    const oldFields = closedFields(oldControl, new Set([
      "generation", "status_before", "status_after", "conversation_id", "conversation_url",
    ]), ["generation", "status_after", "conversation_id", "conversation_url"]);
    const oldGeneration = validGeneration(oldFields.generation);
    const oldIdentity = validConversationId(oldFields.conversation_id);
    if (oldGeneration === generation || oldFields.status_after !== "RETIRED") stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    validConversationUrl(oldIdentity, oldFields.conversation_url);
    const newControl = uniqueSection(activeBody, "NEW_CONTROL", "OLD_CONTROL", "PRESERVED_WORK");
    const controlFields = closedFields(newControl, new Set([
      "generation", "display_name", "status_before", "status_after", "conversation_id", "conversation_url", "single_active_control", "generation032",
    ]), ["generation", "display_name", "status_before", "status_after", "conversation_id", "conversation_url", "single_active_control"]);
    if (controlFields.generation !== generation || controlFields.status_after !== "ACTIVE"
      || controlFields.conversation_id !== ackFields.conversation_id || controlFields.conversation_url !== ackFields.conversation_url
      || controlFields.single_active_control !== "true") stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    if (oldIdentity.toLowerCase() === controlFields.conversation_id.toLowerCase() || oldFields.conversation_url === controlFields.conversation_url) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    validConversationUrl(controlFields.conversation_id, controlFields.conversation_url);
    return { start: startReadback, registry: registryReadback, active, control_generation: generation, active_control_conversation_id: ackFields.conversation_id };
  }

  async function currentAuthorityComments() {
    const [starts, registries, switches] = await Promise.all([
      allComments(authorityIssueNumbers.registry),
      allComments(authorityIssueNumbers.switch),
      allComments(authorityIssueNumbers.control),
    ]);
    const select = (rows, pattern) => rows.filter(c => pattern.test(c.body?.split(/\r?\n/, 1)[0] || "")).at(-1);
    const start = select(starts, AUTHORITY.start), registry = select(registries, AUTHORITY.registry);
    if (!start || !registry) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    const startHeader = start.body?.split(/\r?\n/, 1)[0];
    const registryHeader = registry.body?.split(/\r?\n/, 1)[0];
    if (startHeader === "CURRENT_REHYDRATION_INDEX_V243" || registryHeader === "CURRENT_REGISTRY_INDEX_V139") {
      if (startHeader !== "CURRENT_REHYDRATION_INDEX_V243" || registryHeader !== "CURRENT_REGISTRY_INDEX_V139") stop("AUTHORITY_CONFLICT_OR_MALFORMED");
      return sectionedAuthority(start, registry);
    }
    const active = select(switches, /^CONTROL_GENERATION_ATOMIC_SWITCH_V1$/);
    if (!active) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    for (const [row, issue] of [[start, authorityIssueNumbers.registry], [registry, authorityIssueNumbers.switch], [active, authorityIssueNumbers.control]]) {
      if (issueOf(row).repo !== repository || issueOf(row).issue !== issue || !row.body.includes(`repository: ${repository}`)) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
      const fetched = await exactIssueComment(row.id, issue, row.body);
      if (decimal(fetched.id) !== decimal(row.id)) stop("AUTHORITY_READBACK_MISMATCH");
    }
    if (pointer(registry.body, "source_current_start", authorityIssueNumbers.registry) !== decimal(start.id)) stop("AUTHORITY_POINTER_MISMATCH");
    const generation = /^current_active_generation: (\d+)$/m.exec(active.body)?.[1];
    const identity = /^active_control_conversation_id: (\S+)$/m.exec(active.body)?.[1];
    const startGeneration = /^control_generation: (\d+) ACTIVE_REHYDRATED$/m.exec(start.body)?.[1];
    const registryGeneration = /^control_generation: (\d+) ACTIVE_REHYDRATED$/m.exec(registry.body)?.[1];
    if (!generation || !identity || generation !== startGeneration || generation !== registryGeneration || !active.body.includes("single_active_control: true")) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    const routes = [...start.body.matchAll(new RegExp(`^webgpt_route: Issue #${authorityIssueNumbers.control} comment ([1-9]\\d*) \/ generation(\\d+)$`, "gm"))];
    if (routes.length !== 1 || routes[0][1] !== decimal(active.id) || routes[0][2] !== generation) stop("AUTHORITY_POINTER_MISMATCH");
    const route = routes[0];
    const routeComment = await exactComment(route[1]);
    if (issueOf(routeComment).issue !== authorityIssueNumbers.control || routeComment.body !== active.body || !routeComment.body.startsWith(`${AUTHORITY.switch}\n`) || !routeComment.body.includes(`repository: ${repository}`) || !routeComment.body.includes(`current_active_generation: ${generation}`) || !routeComment.body.includes(`active_control_conversation_id: ${identity}`)) stop("AUTHORITY_POINTER_MISMATCH");
    return { start, registry, active, control_generation: generation, active_control_conversation_id: identity };
  }
  async function readAuthoritySnapshot() {
    const current = await currentAuthorityComments();
    const item = (comment) => ({
      github_comment_id: decimal(comment.id),
      control_generation: current.control_generation,
      active_control_conversation_id: current.active_control_conversation_id,
      producer_admission_comment_ids: admissions(comment),
      switch_conflict: false,
    });
    return { control: item(current.start), registry: item(current.registry), switch: item(current.active) };
  }
  async function snapshot() {
    const issueRows = await Promise.all(supportedIssues.map((issue) => allComments(issue)));
    return issueRows.flatMap((comments, index) => comments.map((comment) => receipt(comment, repository, supportedIssues[index])).filter(Boolean));
  }
  async function listReceipts() {
    const rows = await snapshot();
    return rows.filter(r => r.type !== "GITHUB_SOURCE_EVENT_V1");
  }
  async function getReceipt(id) {
    const row = await exactComment(id);
    const issue = issueOf(row).issue;
    if (!supportedIssues.includes(issue)) stop("UNSUPPORTED_ISSUE");
    const parsed = receipt(row, repository, issue);
    if (!parsed) stop("UNRECOGNIZED_EXACT_RECEIPT");
    return parsed;
  }
  async function readHeartbeat(lease) {
    const heartbeats = (await snapshot()).filter((item) => item.type === "LOCAL_CONTROL_RESIDENT_HEARTBEAT_V1"
      && (!lease || item.lease_id === lease.lease_id));
    heartbeats.sort((left, right) => BigInt(left.github_comment_id) < BigInt(right.github_comment_id) ? -1 : 1);
    return heartbeats.at(-1) ?? null;
  }
  async function listSourceEvents() {
    return (await snapshot()).filter(r => r.type === "GITHUB_SOURCE_EVENT_V1");
  }
  function receiptBody(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !TYPES.has(value.type)) stop("MALFORMED_RECOGNIZED_RECEIPT");
    validateFields(value.type, value);
    const fields = Object.keys(value).filter((key) => key !== "type" && key !== "github_comment_id").sort();
    return [value.type, ...fields.map((key) => `${key}: ${Array.isArray(value[key]) || (value[key] && typeof value[key] === "object") ? JSON.stringify(value[key]) : value[key]}`)].join("\n");
  }
  async function createComment(issue, body) {
    let result;
    if (typeof publisher === "function") result = await publisher({ repository, issue, body });
    else result = (await request(`${root}/issues/${issue}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) })).data;
    return decimal(typeof result === "object" ? result?.id : result);
  }
  async function publishReceipt(value) {
    const body = receiptBody(value);
    const issue = value.source_issue ?? sourceIssueNumber;
    if (!Number.isSafeInteger(issue) || !supportedIssues.includes(issue) || (value.source_repo && value.source_repo !== repository)) stop("UNSUPPORTED_ISSUE");
    const id = await createComment(issue, body);
    const row = await exactIssueComment(id, issue, body);
    if (!receipt(row, repository, issue)) stop("RECEIPT_READBACK_MISMATCH");
    return id;
  }
  async function sendPointer(pointerValue) {
    if (!pointerValue || pointerValue.source_repo !== repository || pointerValue.source_issue !== sourceIssueNumber) stop("MALFORMED_POINTER_REQUEST");
    const sourceCommentId = decimal(pointerValue.source_comment_id);
    const wakeRequestCommentId = decimal(pointerValue.wake_request_comment_id);
    const idempotencyKey = createHash("sha256").update(`${repository}#${sourceIssueNumber}:${sourceCommentId}:${wakeRequestCommentId}`).digest("hex");
    const body = [
      "GBB_LOCAL_CONTROL_POINTER_DELIVERY_REQUEST_V1",
      `source_repo: ${repository}`,
      `source_issue: ${sourceIssueNumber}`,
      `source_comment_id: ${sourceCommentId}`,
      `wake_request_comment_id: ${wakeRequestCommentId}`,
      `idempotency_key: ${idempotencyKey}`,
    ].join("\n");
    const matches = (await allComments(sourceIssueNumber)).filter((comment) => comment.body?.startsWith("GBB_LOCAL_CONTROL_POINTER_DELIVERY_REQUEST_V1\n")
      && new RegExp(`^idempotency_key: ${idempotencyKey}$`, "m").test(comment.body));
    if (matches.length > 1 || (matches.length === 1 && matches[0].body !== body)) stop("POINTER_REQUEST_CONFLICT");
    const id = matches.length ? decimal(matches[0].id) : await createComment(sourceIssueNumber, body);
    await exactIssueComment(id, sourceIssueNumber, body);
    return { github_comment_id: id, idempotency_key: idempotencyKey };
  }
  return { readAuthoritySnapshot, listReceipts, readHeartbeat, getReceipt, listSourceEvents, publishReceipt, sendPointer };
}
