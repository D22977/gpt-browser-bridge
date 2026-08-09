import {
  createReviewResultPublisher,
  reviewResultIdempotencyKey,
} from './review_result_idempotency.mjs';

const READY_CARD_ID = 'DESKTOP-REVIEW-LOOP-GH-01';
const READY_REPOSITORY = 'D22977/gpt-browser-bridge';
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const EXPECTED_AUTHORITY_FIELDS = Object.freeze([
  'card_id',
  'recovery_generation',
  'round',
  'task_id',
  'repo',
  'exact_base_sha',
  'candidate_head_sha',
  'review_generation',
  'review_request_id',
  'ready_receipt_id',
  'review_session_id',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function nonEmptyStringArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => isNonEmptyString(item));
}

function validPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function invalid(reason, field) {
  return { valid: false, reason, field };
}

function validateShape(receipt) {
  if (!isRecord(receipt)) return invalid('INVALID_READY_RECEIPT', 'receipt');
  if (receipt.card_id !== READY_CARD_ID) return invalid('WRONG_CARD', 'card_id');
  if (!validPositiveInteger(receipt.recovery_generation)) {
    return invalid('INVALID_RECOVERY_GENERATION', 'recovery_generation');
  }
  if (!validPositiveInteger(receipt.round)) return invalid('INVALID_ROUND', 'round');
  if (!isNonEmptyString(receipt.task_id)) return invalid('INVALID_TASK_ID', 'task_id');
  if (receipt.repo !== READY_REPOSITORY) return invalid('WRONG_REPOSITORY', 'repo');
  if (!SHA_PATTERN.test(receipt.exact_base_sha)) {
    return invalid('INVALID_BASE_SHA', 'exact_base_sha');
  }
  if (!SHA_PATTERN.test(receipt.candidate_head_sha)) {
    return invalid('INVALID_CANDIDATE_HEAD_SHA', 'candidate_head_sha');
  }
  if (!nonEmptyStringArray(receipt.changed_paths)) {
    return invalid('INVALID_CHANGED_PATHS', 'changed_paths');
  }
  if (!nonEmptyStringArray(receipt.tests_run)) {
    return invalid('INVALID_TEST_COMMANDS', 'tests_run');
  }
  if (receipt.desktop_agent_identity !== 'CODEX_DESKTOP_AGENT') {
    return invalid('WRONG_DESKTOP_IDENTITY', 'desktop_agent_identity');
  }
  if (receipt.manual_relay_count !== 0) {
    return invalid('MANUAL_RELAY_FORBIDDEN', 'manual_relay_count');
  }
  if (receipt.request_fresh_reviewer !== true) {
    return invalid('F001_FRESH_REVIEWER_REQUIRED', 'request_fresh_reviewer');
  }
  if (!validPositiveInteger(receipt.review_generation)) {
    return invalid('INVALID_REVIEW_GENERATION', 'review_generation');
  }
  if (!isNonEmptyString(receipt.review_request_id)) {
    return invalid('INVALID_REVIEW_REQUEST_ID', 'review_request_id');
  }
  if (!isNonEmptyString(receipt.ready_receipt_id)) {
    return invalid('INVALID_READY_RECEIPT_ID', 'ready_receipt_id');
  }
  if (!isNonEmptyString(receipt.review_session_id)) {
    return invalid('INVALID_REVIEW_SESSION_ID', 'review_session_id');
  }
  return null;
}

function validateExpectedAuthority(expectedAuthority) {
  if (!isRecord(expectedAuthority)) {
    return invalid('EXPECTED_AUTHORITY_REQUIRED', 'expectedAuthority');
  }
  for (const field of EXPECTED_AUTHORITY_FIELDS) {
    const value = expectedAuthority[field];
    if (field.includes('generation') || field === 'round') {
      if (!validPositiveInteger(value)) return invalid('INVALID_EXPECTED_AUTHORITY', field);
    } else if (field === 'exact_base_sha' || field === 'candidate_head_sha') {
      if (!SHA_PATTERN.test(value)) return invalid('INVALID_EXPECTED_AUTHORITY', field);
    } else if (!isNonEmptyString(value)) {
      return invalid('INVALID_EXPECTED_AUTHORITY', field);
    }
  }
  return null;
}

/**
 * Validate one GH-01 READY receipt against the exact authority currently allowed.
 * A receipt without an expected tuple is never accepted.
 */
export function validateRecoveryReadyReceipt(receipt, expectedAuthority) {
  const shapeError = validateShape(receipt);
  if (shapeError) return shapeError;

  const expectedError = validateExpectedAuthority(expectedAuthority);
  if (expectedError) return expectedError;

  for (const field of EXPECTED_AUTHORITY_FIELDS) {
    if (receipt[field] !== expectedAuthority[field]) {
      return invalid('AUTHORITY_MISMATCH', field);
    }
  }
  return { valid: true };
}

/**
 * Convert a verified READY receipt into the exact authority tuple consumed by #45.
 */
export function buildRecoveryReviewAuthority({
  readyReceipt,
  expectedAuthority,
  reviewSessionId,
}) {
  const validation = validateRecoveryReadyReceipt(readyReceipt, expectedAuthority);
  if (!validation.valid) return validation;
  if (!isNonEmptyString(reviewSessionId)) {
    return invalid('FRESH_REVIEW_SESSION_REQUIRED', 'review_session_id');
  }
  if (reviewSessionId !== readyReceipt.review_session_id) {
    return invalid('AUTHORITY_MISMATCH', 'review_session_id');
  }

  return {
    valid: true,
    idempotency_key: reviewResultIdempotencyKey({
      card_id: readyReceipt.card_id,
      review_request_id: readyReceipt.review_request_id,
    }),
    authority: {
      review_request_id: readyReceipt.review_request_id,
      review_generation: readyReceipt.review_generation,
      card_id: readyReceipt.card_id,
      source_ready_receipt_id: readyReceipt.ready_receipt_id,
      reviewed_head_sha: readyReceipt.candidate_head_sha,
      review_session_id: reviewSessionId,
    },
  };
}

function publicationAdmissionError(result, authority) {
  if (!isRecord(result)) {
    return {
      ok: false,
      idempotency_disposition: 'BLOCKED',
      reason: 'INVALID_RESULT',
      field: 'result',
    };
  }
  if (result.review_session_id !== authority.review_session_id) {
    let idempotencyKey;
    try {
      idempotencyKey = reviewResultIdempotencyKey(result);
    } catch {
      return {
        ok: false,
        idempotency_disposition: 'BLOCKED',
        reason: 'INVALID_RESULT',
        field: 'card_id',
      };
    }
    return {
      ok: false,
      idempotency_disposition: 'REJECTED',
      idempotency_key: idempotencyKey,
      reason: 'AUTHORITY_MISMATCH',
      field: 'review_session_id',
    };
  }
  return null;
}

/**
 * Bind the durable READY/session tuple before delegating Reviewer publication to #45.
 * The explicit session admission closes #45's legacy comparison gap before first create.
 */
export function createRecoveryReviewPublisher({
  readyReceipt,
  expectedAuthority,
  reviewSessionId,
  adapter,
}) {
  const bound = buildRecoveryReviewAuthority({
    readyReceipt,
    expectedAuthority,
    reviewSessionId,
  });
  if (!bound.valid) return bound;

  const publisher = createReviewResultPublisher({
    authority: bound.authority,
    adapter,
  });

  return {
    valid: true,
    idempotency_key: bound.idempotency_key,
    authority: bound.authority,
    publish(result) {
      const admissionError = publicationAdmissionError(result, bound.authority);
      if (admissionError) return Promise.resolve(admissionError);
      return publisher.publish(result);
    },
  };
}
