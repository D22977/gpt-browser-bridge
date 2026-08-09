import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createReviewResultPublisher,
  reviewResultIdempotencyKey,
} from '../src/review_result_idempotency.mjs';

const AUTHORITY = {
  review_request_id: 'REVIEW-RESULT-IDEMPOTENCY-00-R1',
  review_generation: 1,
  card_id: 'REVIEW-RESULT-IDEMPOTENCY-00',
  source_ready_receipt_id: '5230622376',
  reviewed_head_sha: 'a'.repeat(40),
};

function makeResult(overrides = {}) {
  return {
    ...AUTHORITY,
    review_session_id: 'chatgpt-session-1',
    decision: 'PASS',
    findings: [],
    next_state: 'READY_FOR_46',
    ...overrides,
  };
}

function makeAdapter({ readback = true, delay_ms = 0 } = {}) {
  const records = new Map();
  const stats = { publish_attempts: 0, created: 0, readbacks: 0 };
  const adapter = {
    async publishIfAbsent({ idempotency_key, fingerprint, result }) {
      stats.publish_attempts += 1;
      if (delay_ms) {
        await new Promise((resolve) => setTimeout(resolve, delay_ms));
      }
      const existing = records.get(idempotency_key);
      if (existing) {
        return { created: false, pointer: existing.pointer };
      }
      const pointer = {
        receipt_id: `receipt-${records.size + 1}`,
        url: `https://github.example/receipt/${records.size + 1}`,
      };
      records.set(idempotency_key, { fingerprint, pointer, result });
      stats.created += 1;
      return { created: true, pointer };
    },
    async read({ idempotency_key }) {
      stats.readbacks += 1;
      if (!readback) return null;
      const record = records.get(idempotency_key);
      if (!record) return null;
      return {
        idempotency_key,
        fingerprint: record.fingerprint,
        pointer: record.pointer,
      };
    },
  };
  return { adapter, stats };
}

test('canonical key binds the card and review request', () => {
  assert.equal(
    reviewResultIdempotencyKey(AUTHORITY),
    'REVIEW-RESULT-IDEMPOTENCY-00::REVIEW-RESULT-IDEMPOTENCY-00-R1',
  );
});

test('first publication returns a machine-readable CREATED pointer', async () => {
  const { adapter, stats } = makeAdapter();
  const publisher = createReviewResultPublisher({ authority: AUTHORITY, adapter });

  const outcome = await publisher.publish(makeResult());

  assert.equal(outcome.ok, true);
  assert.equal(outcome.idempotency_disposition, 'CREATED');
  assert.equal(outcome.idempotency_key, reviewResultIdempotencyKey(AUTHORITY));
  assert.deepEqual(outcome.receipt_pointer, {
    receipt_id: 'receipt-1',
    url: 'https://github.example/receipt/1',
  });
  assert.equal(stats.created, 1);
  assert.equal(stats.readbacks, 1);
});

test('concurrent exact duplicates create once and reuse the durable pointer', async () => {
  const { adapter, stats } = makeAdapter({ delay_ms: 10 });
  const publisher = createReviewResultPublisher({ authority: AUTHORITY, adapter });
  const result = makeResult();

  const [first, second] = await Promise.all([
    publisher.publish(result),
    publisher.publish({
      next_state: result.next_state,
      findings: result.findings,
      decision: result.decision,
      review_session_id: result.review_session_id,
      reviewed_head_sha: result.reviewed_head_sha,
      source_ready_receipt_id: result.source_ready_receipt_id,
      card_id: result.card_id,
      review_generation: result.review_generation,
      review_request_id: result.review_request_id,
    }),
  ]);

  assert.deepEqual(
    [first.idempotency_disposition, second.idempotency_disposition].sort(),
    ['CREATED', 'REUSED'],
  );
  assert.deepEqual(first.receipt_pointer, second.receipt_pointer);
  assert.equal(stats.created, 1);
  assert.equal(stats.publish_attempts, 2);
});

test('same request conflicts on changed binding or payload without overwriting', async () => {
  const { adapter, stats } = makeAdapter();
  const publisher = createReviewResultPublisher({ authority: AUTHORITY, adapter });
  const first = await publisher.publish(makeResult());

  for (const conflictingResult of [
    makeResult({ review_session_id: 'chatgpt-session-2' }),
    makeResult({ decision: 'FIX_REQUIRED', findings: ['changed'] }),
  ]) {
    const outcome = await publisher.publish(conflictingResult);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.idempotency_disposition, 'CONFLICT');
    assert.equal(outcome.reason, 'CONFLICTING_REPLAY');
    assert.deepEqual(outcome.receipt_pointer, first.receipt_pointer);
  }

  assert.equal(stats.created, 1);
});

test('wrong or stale authority is rejected before durable publication', async () => {
  const { adapter, stats } = makeAdapter();
  const publisher = createReviewResultPublisher({ authority: AUTHORITY, adapter });

  for (const [field, value] of [
    ['review_request_id', 'different-request'],
    ['review_generation', 2],
    ['card_id', 'different-card'],
    ['source_ready_receipt_id', 'stale-ready'],
    ['reviewed_head_sha', 'c'.repeat(40)],
  ]) {
    const outcome = await publisher.publish(makeResult({ [field]: value }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.idempotency_disposition, 'REJECTED');
    assert.equal(outcome.reason, 'AUTHORITY_MISMATCH');
    assert.equal(outcome.field, field);
  }

  assert.equal(stats.publish_attempts, 0);
});

test('different review requests remain independent', async () => {
  const { adapter, stats } = makeAdapter();
  const secondAuthority = {
    ...AUTHORITY,
    review_request_id: 'REVIEW-RESULT-IDEMPOTENCY-00-R2',
    source_ready_receipt_id: '5230622377',
    review_session_id: undefined,
  };
  const firstPublisher = createReviewResultPublisher({ authority: AUTHORITY, adapter });
  const secondPublisher = createReviewResultPublisher({ authority: secondAuthority, adapter });

  const first = await firstPublisher.publish(makeResult());
  const second = await secondPublisher.publish(makeResult({
    review_request_id: secondAuthority.review_request_id,
    source_ready_receipt_id: secondAuthority.source_ready_receipt_id,
    review_session_id: 'chatgpt-session-2',
  }));

  assert.equal(first.idempotency_disposition, 'CREATED');
  assert.equal(second.idempotency_disposition, 'CREATED');
  assert.notEqual(first.idempotency_key, second.idempotency_key);
  assert.equal(stats.created, 2);
});

test('missing durable read-back fails closed with no success disposition', async () => {
  const { adapter, stats } = makeAdapter({ readback: false });
  const publisher = createReviewResultPublisher({ authority: AUTHORITY, adapter });

  const outcome = await publisher.publish(makeResult());

  assert.equal(outcome.ok, false);
  assert.equal(outcome.idempotency_disposition, 'BLOCKED');
  assert.equal(outcome.reason, 'READBACK_MISSING');
  assert.equal(stats.created, 1);
});
