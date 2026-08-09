const READY_CARD_ID = "DESKTOP-REVIEW-LOOP-GH-00";
const READY_REPOSITORY = "D22977/gpt-browser-bridge";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(
    (item) => typeof item === "string" && item.length > 0
  );
}

export function validateReadyReceipt(receipt) {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    return false;
  }

  return receipt.card_id === READY_CARD_ID
    && Number.isInteger(receipt.round)
    && receipt.round > 0
    && typeof receipt.task_id === "string"
    && receipt.task_id.length > 0
    && receipt.repo === READY_REPOSITORY
    && SHA_PATTERN.test(receipt.exact_base_sha)
    && SHA_PATTERN.test(receipt.candidate_head_sha)
    && nonEmptyStringArray(receipt.changed_paths)
    && nonEmptyStringArray(receipt.tests_run)
    && receipt.desktop_agent_identity === "CODEX_DESKTOP_AGENT"
    && receipt.manual_relay_count === 0;
}
