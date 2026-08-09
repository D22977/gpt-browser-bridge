const TRANSPORTS = new Set(["CONNECTOR", "CLI", "WEB"]);
const WEB_MODES = new Set(["REQUIRED", "OPTIONAL", "DISABLED"]);
const POINTER_DECISIONS = new Set(["PASS", "FIX_REQUIRED", "BLOCKED", "COMPLETE"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasAvailableResult(value) {
  return isRecord(value) && value.available === true;
}

function blocked(reason) {
  return { decision: "BLOCKED", reason };
}

function validReviewer(value) {
  return isRecord(value) && hasText(value.id) && hasText(value.family);
}

function validRoute(route) {
  return (
    isRecord(route) &&
    hasText(route.worker_family) &&
    validReviewer(route.primary_reviewer) &&
    validReviewer(route.secondary_reviewer) &&
    TRANSPORTS.has(route.primary_transport) &&
    TRANSPORTS.has(route.secondary_transport) &&
    WEB_MODES.has(route.web_external_review) &&
    typeof route.cross_family_required === "boolean"
  );
}

/**
 * Decide whether a declared reviewer route has satisfied all required gates.
 * The function is intentionally pure: it does not invoke transports or infer
 * results from browser/chat state.
 */
export function evaluateReviewRoute(route, results = {}) {
  if (!validRoute(route)) {
    return blocked("INVALID_ROUTE");
  }

  if (
    route.cross_family_required &&
    route.worker_family === route.secondary_reviewer.family
  ) {
    return blocked("CROSS_FAMILY_REQUIRED");
  }

  if (!hasAvailableResult(results.primary)) {
    return blocked("PRIMARY_RESULT_MISSING");
  }

  if (!hasAvailableResult(results.secondary)) {
    return blocked("SECONDARY_RESULT_MISSING");
  }

  if (
    route.web_external_review === "REQUIRED" &&
    !hasAvailableResult(results.web)
  ) {
    return blocked("WEB_RESULT_REQUIRED");
  }

  return { decision: "COMPLETE", reason: "REQUIRED_RESULTS_PRESENT" };
}

/**
 * Validate the minimal machine-readable pointer used for durable results.
 */
export function isValidDurableResultPointer(pointer) {
  if (!isRecord(pointer) || !hasText(pointer.repository)) {
    return false;
  }

  const hasCardOrIssue = hasText(pointer.card_id) || hasText(pointer.issue);
  const reviewer = pointer.reviewer;

  return (
    hasCardOrIssue &&
    validReviewer(reviewer) &&
    TRANSPORTS.has(reviewer.transport) &&
    hasText(pointer.receipt_id) &&
    POINTER_DECISIONS.has(pointer.decision)
  );
}
