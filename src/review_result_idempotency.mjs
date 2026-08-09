const BINDING_FIELDS = Object.freeze([
  'review_request_id',
  'review_generation',
  'card_id',
  'source_ready_receipt_id',
  'reviewed_head_sha',
  'review_session_id',
]);

const DECISIONS = new Set(['PASS', 'FIX_REQUIRED', 'BLOCKED']);
const SHA1 = /^[0-9a-f]{40}$/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAuthority(authority) {
  if (!isRecord(authority)) {
    throw new TypeError('authority must be an object');
  }
  for (const field of BINDING_FIELDS.slice(0, -1)) {
    if (field === 'review_generation') {
      if (!Number.isInteger(authority[field]) || authority[field] < 1) {
        throw new TypeError(`authority.${field} must be a positive integer`);
      }
      continue;
    }
    if (!isNonEmptyString(authority[field])) {
      throw new TypeError(`authority.${field} must be a non-empty string`);
    }
  }
  if (!SHA1.test(authority.reviewed_head_sha)) {
    throw new TypeError('authority.reviewed_head_sha must be a 40-character SHA');
  }
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateResult(result, authority) {
  if (!isRecord(result)) {
    return { reason: 'INVALID_RESULT', field: 'result' };
  }

  for (const field of BINDING_FIELDS) {
    if (field === 'review_generation') {
      if (!Number.isInteger(result[field]) || result[field] < 1) {
        return { reason: 'INVALID_RESULT', field };
      }
    } else if (!isNonEmptyString(result[field])) {
      return { reason: 'INVALID_RESULT', field };
    }
  }

  if (!SHA1.test(result.reviewed_head_sha)) {
    return { reason: 'INVALID_RESULT', field: 'reviewed_head_sha' };
  }
  if (!DECISIONS.has(result.decision)) {
    return { reason: 'INVALID_RESULT', field: 'decision' };
  }
  if (!Array.isArray(result.findings)) {
    return { reason: 'INVALID_RESULT', field: 'findings' };
  }

  for (const field of BINDING_FIELDS.slice(0, -1)) {
    if (result[field] !== authority[field]) {
      return { reason: 'AUTHORITY_MISMATCH', field };
    }
  }
  return null;
}

function blockedOutcome(idempotencyKey, reason, extra = {}) {
  return {
    ok: false,
    idempotency_disposition: 'BLOCKED',
    idempotency_key: idempotencyKey,
    reason,
    ...extra,
  };
}

/**
 * Build the stable logical identity used for Reviewer-result publication.
 * The separator prevents ambiguous concatenations while keeping the key readable.
 */
export function reviewResultIdempotencyKey({ card_id, review_request_id }) {
  if (!isNonEmptyString(card_id) || !isNonEmptyString(review_request_id)) {
    throw new TypeError('card_id and review_request_id must be non-empty strings');
  }
  return `${card_id}::${review_request_id}`;
}

/**
 * Create a serialized, fail-closed admission boundary for one READY authority.
 * The adapter must make publishIfAbsent atomic in its durable store and provide read-back.
 */
export function createReviewResultPublisher({ authority, adapter }) {
  validateAuthority(authority);
  if (!isRecord(adapter)
    || typeof adapter.publishIfAbsent !== 'function'
    || typeof adapter.read !== 'function') {
    throw new TypeError('adapter must provide publishIfAbsent and read functions');
  }

  let tail = Promise.resolve();

  async function publishOne(result) {
    let idempotencyKey;
    try {
      idempotencyKey = reviewResultIdempotencyKey(result);
    } catch {
      return blockedOutcome(undefined, 'INVALID_RESULT', { field: 'card_id' });
    }

    const validationError = validateResult(result, authority);
    if (validationError) {
      return {
        ok: false,
        idempotency_disposition: validationError.reason === 'AUTHORITY_MISMATCH'
          ? 'REJECTED'
          : 'BLOCKED',
        idempotency_key: idempotencyKey,
        ...validationError,
      };
    }

    let fingerprint;
    try {
      fingerprint = stableSerialize(result);
    } catch {
      return blockedOutcome(idempotencyKey, 'INVALID_RESULT', { field: 'result' });
    }

    let publication;
    try {
      publication = await adapter.publishIfAbsent({
        idempotency_key: idempotencyKey,
        fingerprint,
        result,
      });
    } catch {
      return blockedOutcome(idempotencyKey, 'PUBLISH_FAILED');
    }

    if (!isRecord(publication)
      || typeof publication.created !== 'boolean'
      || !isRecord(publication.pointer)) {
      return blockedOutcome(idempotencyKey, 'INVALID_PUBLISH_OUTCOME');
    }

    let readback;
    try {
      readback = await adapter.read({
        idempotency_key: idempotencyKey,
        pointer: publication.pointer,
      });
    } catch {
      return blockedOutcome(idempotencyKey, 'READBACK_FAILED');
    }

    if (!isRecord(readback)) {
      return blockedOutcome(idempotencyKey, 'READBACK_MISSING');
    }
    if (readback.idempotency_key !== idempotencyKey) {
      return blockedOutcome(idempotencyKey, 'READBACK_KEY_MISMATCH');
    }
    if (readback.fingerprint !== fingerprint) {
      return {
        ok: false,
        idempotency_disposition: 'CONFLICT',
        idempotency_key: idempotencyKey,
        reason: 'CONFLICTING_REPLAY',
        receipt_pointer: readback.pointer ?? publication.pointer,
      };
    }
    if (!isRecord(readback.pointer)) {
      return blockedOutcome(idempotencyKey, 'READBACK_POINTER_MISSING');
    }

    return {
      ok: true,
      idempotency_disposition: publication.created ? 'CREATED' : 'REUSED',
      idempotency_key: idempotencyKey,
      receipt_pointer: readback.pointer,
    };
  }

  return Object.freeze({
    publish(result) {
      const next = tail.then(() => publishOne(result));
      tail = next.catch(() => undefined);
      return next;
    },
  });
}
