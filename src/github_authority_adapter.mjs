// A finite GitHub reader for the resident contract. This module has no import-time I/O.
const TYPES = new Set([
  "LOCAL_CONTROL_RESIDENT_LEASE_V1", "LOCAL_CONTROL_RESIDENT_HEARTBEAT_V1",
  "LOCAL_CONTROL_WAKE_REQUEST_V1", "ACTIVE_CONTROL_WAKE_ACK_V1",
  "ACTIVE_CONTROL_SOURCE_DECISION_V1", "LOCAL_CONTROL_EXECUTOR_RELEASE_V1",
]);
const EVENTS = new Set(["TERMINAL", "CONTROL_NEEDED", "PROGRESS"]);
const AUTHORITY = { start: /^CURRENT_REHYDRATION_INDEX_V\d+$/, registry: /^CURRENT_REGISTRY_INDEX_V\d+$/, switch: "CONTROL_GENERATION_ATOMIC_SWITCH_V1" };
const SUPPORTED_ISSUES = [43, 81, 88, 162];
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

export function createGitHubAuthorityAdapter({ token, repository = "D22977/gpt-browser-bridge", fetchImpl = globalThis.fetch, publisher, triggerContractHash, now } = {}) {
  if (!/^[^/]+\/[^/]+$/.test(repository) || typeof fetchImpl !== "function" || typeof triggerContractHash !== "string" || !triggerContractHash || typeof now !== "string" || !Number.isFinite(Date.parse(now))) stop("MALFORMED_ADAPTER_CONFIG");
  const root = `https://api.github.com/repos/${repository}`;
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  async function request(url) {
    let response;
    try { response = await fetchImpl(url, { headers, redirect: "error" }); }
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
      if (relations.has("last") && relations.get("last") < page) stop("INCOMPLETE_GITHUB_PAGINATION");
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
  async function readAuthority() {
    const [starts, registries, switches] = await Promise.all([allComments(43), allComments(81), allComments(88)]);
    const select = (rows, pattern) => rows.filter(c => pattern.test(c.body?.split(/\r?\n/, 1)[0] || "")).at(-1);
    const start = select(starts, AUTHORITY.start), registry = select(registries, AUTHORITY.registry), active = select(switches, /^CONTROL_GENERATION_ATOMIC_SWITCH_V1$/);
    if (!start || !registry || !active) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    for (const [row, issue] of [[start, 43], [registry, 81], [active, 88]]) {
      if (issueOf(row).repo !== repository || issueOf(row).issue !== issue || !row.body.includes(`repository: ${repository}`)) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
      const fetched = await exactComment(row.id);
      if (fetched.body !== row.body || decimal(fetched.id) !== decimal(row.id) || issueOf(fetched).issue !== issue) stop("AUTHORITY_READBACK_MISMATCH");
    }
    if (pointer(registry.body, "source_current_start", 43) !== decimal(start.id)) stop("AUTHORITY_POINTER_MISMATCH");
    const generation = /^current_active_generation: (\d+)$/m.exec(active.body)?.[1];
    const identity = /^active_control_conversation_id: (\S+)$/m.exec(active.body)?.[1];
    const startGeneration = /^control_generation: (\d+) ACTIVE_REHYDRATED$/m.exec(start.body)?.[1];
    const registryGeneration = /^control_generation: (\d+) ACTIVE_REHYDRATED$/m.exec(registry.body)?.[1];
    if (!generation || !identity || generation !== startGeneration || generation !== registryGeneration || !active.body.includes("single_active_control: true")) stop("AUTHORITY_CONFLICT_OR_MALFORMED");
    const routes = [...start.body.matchAll(/^webgpt_route: Issue #88 comment ([1-9]\d*) \/ generation(\d+)$/gm)];
    if (routes.length !== 1 || routes[0][1] !== decimal(active.id) || routes[0][2] !== generation) stop("AUTHORITY_POINTER_MISMATCH");
    const route = routes[0];
    const routeComment = await exactComment(route[1]);
    if (issueOf(routeComment).issue !== 88 || routeComment.body !== active.body || !routeComment.body.startsWith(`${AUTHORITY.switch}\n`) || !routeComment.body.includes(`repository: ${repository}`) || !routeComment.body.includes(`current_active_generation: ${generation}`) || !routeComment.body.includes(`active_control_conversation_id: ${identity}`)) stop("AUTHORITY_POINTER_MISMATCH");
    return { control_generation: generation, active_control_conversation_id: identity, current_start_receipt: `43:${start.id}`, current_registry_receipt: `81:${registry.id}`, active_switch_receipt: `88:${active.id}`, switch_conflict: false };
  }
  async function snapshot() {
    const authority = await readAuthority();
    const rows = (await Promise.all(SUPPORTED_ISSUES.map(allComments))).flatMap((comments, index) => comments.map(c => receipt(c, repository, SUPPORTED_ISSUES[index])).filter(Boolean));
    const leases = rows.filter(r => r.type === "LOCAL_CONTROL_RESIDENT_LEASE_V1" && r.control_generation === authority.control_generation && r.trigger_contract_hash === triggerContractHash && Date.parse(r.expires_at) > Date.parse(now));
    for (const lease of leases) {
      if (!Number.isFinite(Date.parse(lease.acquired_at)) || !Number.isFinite(Date.parse(lease.expires_at))) stop("MALFORMED_RECOGNIZED_RECEIPT");
      for (const watched of lease.watched_issue_set) {
        const match = /^([^#]+)#([1-9]\d*)$/.exec(watched);
        if (!match || match[1] !== repository || !SUPPORTED_ISSUES.includes(Number(match[2]))) stop("UNSUPPORTED_WATCHED_ISSUE_SET");
      }
    }
    return rows;
  }
  async function listReceipts() {
    const rows = await snapshot();
    return rows.filter(r => r.type !== "GITHUB_SOURCE_EVENT_V1");
  }
  async function getReceipt(id) {
    const row = await exactComment(id);
    const parsed = receipt(row, repository, issueOf(row).issue);
    if (!parsed) stop("UNRECOGNIZED_EXACT_RECEIPT");
    return parsed;
  }
  async function listSourceEvents() {
    return (await snapshot()).filter(r => r.type === "GITHUB_SOURCE_EVENT_V1");
  }
  async function publishReceipt(value) {
    if (typeof publisher !== "function") stop("LIVE_RECEIPT_PUBLICATION_NOT_AUTHORIZED");
    return publisher(value);
  }
  return { readAuthority, listReceipts, getReceipt, listSourceEvents, publishReceipt };
}
