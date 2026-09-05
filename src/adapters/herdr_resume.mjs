// GPT_BROWSER_BRIDGE - bounded candidate capture and Herdr rebind helpers.
//
// Repair card: CONTROL-G9-G10-AUTO-CAPTURE-REBOOT-01 (Issue #123)
//
// These helpers deliberately keep the outside boundaries injectable. They
// never create a browser conversation, choose a successor, or persist a
// second authority state. A caller must supply the fresh browser/session
// observation and the fresh Herdr inventory for each operation.

import { extractConversationId, isChatgptConversationUrl } from "../contracts.mjs";

export const HERDR_SAFE_AGENT_STATES = Object.freeze(["idle", "done"]);
export const DEFAULT_HERDR_CWD = "C:\\WINDOWS\\system32";

function text(value) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function markerMatches(value, expected) {
  if (Array.isArray(value)) return value.some((entry) => markerMatches(entry, expected));
  return text(value).toLowerCase() === text(expected).toLowerCase();
}

function generationMatches(value, expected) {
  const wanted = text(expected).replace(/^generation/i, "").padStart(3, "0").toLowerCase();
  const actual = text(value).toLowerCase();
  return actual === wanted || actual === `generation${wanted}`;
}

function firstValue(record, keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null) return record[key];
  }
  return undefined;
}

function candidateUrl(record) {
  return firstValue(record, ["location_href", "locationHref", "observed_url", "observedUrl", "url", "href"]);
}

function candidateMarkersMatch(record, { projectMarker, generation }) {
  const project = firstValue(record, ["project_marker", "projectMarker", "project_id", "project"]);
  const generationMarker = firstValue(record, [
    "generation_marker",
    "generationMarker",
    "generation_id",
    "generation",
  ]);
  return markerMatches(project, projectMarker) && generationMatches(generationMarker, generation);
}

function candidateFromUrl(url, source) {
  const conversationId = extractConversationId(url);
  if (!conversationId || !isChatgptConversationUrl(url)) return null;
  return {
    conversation_id: conversationId,
    conversation_url: text(url),
    source,
  };
}

function candidateCaptureFailure(reason, detail = {}) {
  return { ok: false, reason, ...detail };
}

/**
 * Capture a newly created candidate from the page's own location.href.
 * Prompt prose, title, and sidebar labels are intentionally not accepted as
 * identity evidence.
 */
export function captureCreatedCandidate({
  locationHref,
  projectMarker,
  generation,
  observedProjectMarker,
  observedGenerationMarker,
  expectedId,
}) {
  if (!text(projectMarker)) return candidateCaptureFailure("CANDIDATE_PROJECT_MARKER_REQUIRED");
  if (!text(generation)) return candidateCaptureFailure("CANDIDATE_GENERATION_REQUIRED");
  const candidate = candidateFromUrl(locationHref, "location.href");
  if (!candidate) return candidateCaptureFailure("CANDIDATE_URL_INVALID");
  if (expectedId && candidate.conversation_id !== text(expectedId).toLowerCase()) {
    return candidateCaptureFailure("CANDIDATE_ID_MISMATCH", {
      observed_id: candidate.conversation_id,
      expected_id: text(expectedId).toLowerCase(),
    });
  }
  if (!markerMatches(observedProjectMarker, projectMarker)) {
    return candidateCaptureFailure("CANDIDATE_PROJECT_MARKER_MISMATCH");
  }
  if (!generationMatches(observedGenerationMarker, generation)) {
    return candidateCaptureFailure("CANDIDATE_GENERATION_MARKER_MISMATCH");
  }
  return { ok: true, candidate };
}

/**
 * Resolve an already-open candidate from a fresh tab/session enumeration.
 * The returned URL is the mechanically observed URL, never a URL copied from
 * a prompt or title. `allowedIds` can constrain an owner-supplied emergency
 * bootstrap, but it cannot create or substitute an identity.
 */
export function enumerateExistingCandidate(rows, {
  projectMarker,
  generation,
  allowedIds = [],
} = {}) {
  if (!text(projectMarker)) return candidateCaptureFailure("CANDIDATE_PROJECT_MARKER_REQUIRED");
  if (!text(generation)) return candidateCaptureFailure("CANDIDATE_GENERATION_REQUIRED");
  const allow = new Set(allowedIds.map((id) => text(id).toLowerCase()).filter(Boolean));
  const matches = (Array.isArray(rows) ? rows : []).filter((row) => {
    const url = candidateUrl(row);
    const id = url ? extractConversationId(url) : null;
    return Boolean(
      id &&
      isChatgptConversationUrl(url) &&
      candidateMarkersMatch(row, { projectMarker, generation }) &&
      (allow.size === 0 || allow.has(id))
    );
  });

  if (matches.length === 0) return candidateCaptureFailure("CANDIDATE_COUNT_ZERO");
  if (matches.length > 1) {
    return candidateCaptureFailure("CANDIDATE_COUNT_MULTIPLE", { count: matches.length });
  }

  const candidate = candidateFromUrl(candidateUrl(matches[0]), "mechanically_observed_location");
  return candidate
    ? { ok: true, candidate }
    : candidateCaptureFailure("CANDIDATE_URL_INVALID");
}

function herdrAgents(inventory) {
  if (Array.isArray(inventory)) return inventory;
  if (Array.isArray(inventory?.result?.agents)) return inventory.result.agents;
  if (Array.isArray(inventory?.agents)) return inventory.agents;
  return [];
}

function agentSession(agent) {
  const value = agent?.agent_session ?? agent?.agentSession ?? agent?.session;
  if (value && typeof value === "object") return text(value.value ?? value.id);
  return text(value);
}

function agentPane(agent) {
  return text(agent?.pane_id ?? agent?.paneId ?? agent?.pane);
}

function isSafeGenericCodex(agent, { cwd = DEFAULT_HERDR_CWD } = {}) {
  const label = [agent?.name, agent?.title, agent?.role].map(text).join(" ");
  return text(agent?.agent).toLowerCase() === "codex" &&
    HERDR_SAFE_AGENT_STATES.includes(text(agent?.agent_status ?? agent?.status).toLowerCase()) &&
    text(agent?.cwd).toLowerCase() === text(cwd).toLowerCase() &&
    !/(?:review|reviewer|mep|control|pr\d+)/i.test(label) &&
    Boolean(agentPane(agent)) &&
    Boolean(agentSession(agent));
}

function staleBindingDiffers(target, historicalBinding) {
  if (!historicalBinding) return false;
  const oldPane = text(historicalBinding.pane_id ?? historicalBinding.paneId ?? historicalBinding.pane);
  const oldSessionValue = historicalBinding.agent_session ?? historicalBinding.agentSession ?? historicalBinding.session;
  const oldSession = oldSessionValue && typeof oldSessionValue === "object"
    ? text(oldSessionValue.value ?? oldSessionValue.id)
    : text(oldSessionValue);
  return (oldPane && oldPane !== target.pane_id) || (oldSession && oldSession !== target.agent_session);
}

/**
 * Select exactly one eligible target from a fresh Herdr inventory.
 * Historical pane/session values are diagnostic only and never select a row.
 */
export function resolveFreshHerdrTarget(inventory, options = {}) {
  const eligible = herdrAgents(inventory).filter((agent) => isSafeGenericCodex(agent, options));
  if (eligible.length === 0) return candidateCaptureFailure("HERDR_TARGET_COUNT_ZERO");
  if (eligible.length > 1) {
    return candidateCaptureFailure("HERDR_TARGET_COUNT_MULTIPLE", { count: eligible.length });
  }

  const row = eligible[0];
  const target = {
    ...row,
    pane_id: agentPane(row),
    agent_session: agentSession(row),
  };
  return {
    ok: true,
    target,
    stale_binding_ignored: staleBindingDiffers(target, options.historicalBinding),
  };
}

/**
 * Classify a persisted one-shot send state without performing a retry. The
 * state is only an observation supplied by the caller; this helper creates no
 * local authority or persistence of its own.
 */
export function classifyHerdrSendState(state) {
  switch (text(state).toUpperCase()) {
    case "SENT":
      return { decision: "NO_OP_DUPLICATE", second_prompt_sent: false };
    case "SENDING":
      return { decision: "UNCERTAIN_SEND_NO_BLIND_RETRY", second_prompt_sent: false };
    case "ABSENT":
      return { decision: "NEW_SEND_ALLOWED", second_prompt_sent: false };
    default:
      return { decision: "CONTROL_REQUIRED_UNKNOWN_STATE", second_prompt_sent: false };
  }
}

/**
 * Re-enumerate and bind a target for one physical send. The caller supplies
 * the actual prompt boundary; this helper does not cache pane/session state.
 */
export async function sendToFreshHerdrTarget({
  listAgents,
  prompt,
  text: promptText,
  targetOptions = {},
  historicalBinding,
}) {
  if (typeof listAgents !== "function") return candidateCaptureFailure("HERDR_AGENT_LIST_UNAVAILABLE");
  if (typeof prompt !== "function") return candidateCaptureFailure("HERDR_PROMPT_UNAVAILABLE");

  let inventory;
  try {
    inventory = await listAgents();
  } catch (error) {
    return candidateCaptureFailure("HERDR_AGENT_LIST_FAILED", { error: error?.message ?? String(error) });
  }
  const resolved = resolveFreshHerdrTarget(inventory, { ...targetOptions, historicalBinding });
  if (!resolved.ok) return resolved;

  try {
    const delivery = await prompt(resolved.target, promptText);
    return { ok: true, target: resolved.target, delivery, stale_binding_ignored: resolved.stale_binding_ignored };
  } catch (error) {
    return candidateCaptureFailure("UNCERTAIN_SEND_NO_BLIND_RETRY", {
      target: resolved.target,
      error: error?.message ?? String(error),
    });
  }
}
