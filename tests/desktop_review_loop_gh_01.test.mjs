import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecoveryReviewAuthority,
  validateRecoveryReadyReceipt,
} from '../src/desktop_review_loop_gh_01.mjs';
import { createReviewResultPublisher } from '../src/review_result_idempotency.mjs';

const BASE_SHA = 'a'.repeat(40);
const CANDIDATE_HEAD_SHA = 'b'.repeat(40);
const READY_RECEIPT_ID = 'READY-DESKTOP-REVIEW-LOOP-GH-01-G1-R2-bbbbbbbb';
const REVIEW_REQUEST_ID = 'DESKTOP-REVIEW-LOOP-GH-01-G1-R2-bbbbbbbb';
const REVIEW_SESSION_ID = 'WEBGPT-FRESH-I46-G1-R2-bbbbbbbb';

function validReady(overrides = {}) {
  return {
    card_id: 'DESKTOP-REVIEW-LOOP-GH-01',
    recovery_generation: 1,
    round: 1,
    task_id: 'TASK-A',
    repo: 'D22977/gpt-browser-bridge',
    exact_base_sha: BASE_SHA,
    candidate_head_sha: CANDIDATE_HEAD_SHA,
    changed_paths: ['src/desktop_review_loop_gh_01.mjs'],
    tests_run: ['npm test'],
    desktop_agent_identity: 'CODEX_DESKTOP_AGENT',
    manual_relay_count: 0,
    request_fresh_reviewer: true,
    review_generation: 1,
    review_request_id: REVIEW_REQUEST_ID,
    ready_receipt_id: READY_RECEIPT_ID,
    review_session_id: REVIEW_SESSION_ID,
    ...overrides,
  };
}

function expectedAuthority(overrides = {}) {
  return {
    card_id: 'DESKTOP-REVIEW-LOOP-GH-01',
    recovery_generation: 1,
    round: 1,
    task_id: 'TASK-A',
    repo: 'D22977/gpt-browser-bridge',
    exact_base_sha: BASE_SHA,
    candidate_head_sha: CANDIDATE_HEAD_SHA,
    review_generation: 1,
    review_request_id: REVIEW_REQUEST_ID,
    ready_receipt_id: READY_RECEIPT_ID,
    review_session_id: REVIEW_SESSION_ID,
    ...overrides,
  };
}

test('DESKTOP-REVIEW-LOOP-GH-01 accepts a valid exact-authority READY receipt', () => {
  const outcome = validateRecoveryReadyReceipt(validReady(), expectedAuthority());

  assert.deepEqual(outcome, { valid: true });
});

test('DESKTOP-REVIEW-LOOP-GH-01 preserves F001 by rejecting request_fresh_reviewer=false', () => {
  const outcome = validateRecoveryReadyReceipt(
    validReady({ request_fresh_reviewer: false }),
    expectedAuthority(),
  );

  assert.deepEqual(outcome, {
    valid: false,
    reason: 'F001_FRESH_REVIEWER_REQUIRED',
    field: 'request_fresh_reviewer',
  });
});

test('DESKTOP-REVIEW-LOOP-GH-01 rejects malformed READY gates', () => {
  for (const [field, value] of [
    ['card_id', 'OTHER'],
    ['task_id', ''],
    ['repo', 'other/repo'],
    ['exact_base_sha', 'not-a-sha'],
    ['candidate_head_sha', 'c'.repeat(39)],
    ['changed_paths', []],
    ['tests_run', []],
    ['desktop_agent_identity', 'OTHER_AGENT'],
    ['manual_relay_count', 1],
    ['recovery_generation', 0],
    ['round', 0],
    ['review_generation', 0],
    ['review_request_id', ''],
    ['ready_receipt_id', ''],
    ['review_session_id', ''],
  ]) {
    const outcome = validateRecoveryReadyReceipt(
      validReady({ [field]: value }),
      expectedAuthority(),
    );

    assert.equal(outcome.valid, false, field);
  }
  assert.equal(validateRecoveryReadyReceipt(null, expectedAuthority()).valid, false);
});

test('DESKTOP-REVIEW-LOOP-GH-01 rejects stale round/task/generation/base/head authority', () => {
  for (const [field, value] of [
    ['round', 2],
    ['task_id', 'TASK-B'],
    ['recovery_generation', 2],
    ['exact_base_sha', 'c'.repeat(40)],
    ['candidate_head_sha', 'd'.repeat(40)],
  ]) {
    const outcome = validateRecoveryReadyReceipt(
      validReady(),
      expectedAuthority({ [field]: value }),
    );

    assert.deepEqual(outcome, {
      valid: false,
      reason: 'AUTHORITY_MISMATCH',
      field,
    });
  }
});

test('DESKTOP-REVIEW-LOOP-GH-01 binds #45 publication authority to the exact READY head', () => {
  const outcome = buildRecoveryReviewAuthority({
    readyReceipt: validReady(),
    expectedAuthority: expectedAuthority(),
    reviewSessionId: REVIEW_SESSION_ID,
  });

  assert.equal(outcome.valid, true);
  assert.equal(
    outcome.idempotency_key,
    'DESKTOP-REVIEW-LOOP-GH-01::DESKTOP-REVIEW-LOOP-GH-01-G1-R2-bbbbbbbb',
  );
  assert.deepEqual(outcome.authority, {
    review_request_id: REVIEW_REQUEST_ID,
    review_generation: 1,
    card_id: 'DESKTOP-REVIEW-LOOP-GH-01',
    source_ready_receipt_id: READY_RECEIPT_ID,
    reviewed_head_sha: CANDIDATE_HEAD_SHA,
    review_session_id: REVIEW_SESSION_ID,
  });
});

test('DESKTOP-REVIEW-LOOP-GH-01 validates the durable GitHub READY field shape', () => {
  const durableReadyReceipt = {
    card_id: 'DESKTOP-REVIEW-LOOP-GH-01',
    task_id: 'TASK-A',
    recovery_generation: 1,
    review_generation: 2,
    round: 2,
    repo: 'D22977/gpt-browser-bridge',
    exact_base_sha: BASE_SHA,
    candidate_head_sha: CANDIDATE_HEAD_SHA,
    changed_paths: [
      'src/desktop_review_loop_gh_01.mjs',
      'tests/desktop_review_loop_gh_01.test.mjs',
    ],
    tests_run: [
      'node --check src/desktop_review_loop_gh_01.mjs',
      'node --check tests/desktop_review_loop_gh_01.test.mjs',
      'node --test tests/desktop_review_loop_gh_01.test.mjs',
      'npm test',
      'git diff --check',
    ],
    desktop_agent_identity: 'CODEX_DESKTOP_AGENT',
    manual_relay_count: 0,
    request_fresh_reviewer: true,
    review_request_id: REVIEW_REQUEST_ID,
    ready_receipt_id: READY_RECEIPT_ID,
    review_session_id: REVIEW_SESSION_ID,
  };
  const authority = expectedAuthority({
    round: 2,
    review_generation: 2,
  });
  const outcome = validateRecoveryReadyReceipt(durableReadyReceipt, authority);

  assert.deepEqual(outcome, { valid: true });
});

test('DESKTOP-REVIEW-LOOP-GH-01 rejects a stale or mismatched fresh review session', () => {
  const outcome = buildRecoveryReviewAuthority({
    readyReceipt: validReady({ review_session_id: 'stale-session' }),
    expectedAuthority: expectedAuthority(),
    reviewSessionId: REVIEW_SESSION_ID,
  });

  assert.deepEqual(outcome, {
    valid: false,
    reason: 'AUTHORITY_MISMATCH',
    field: 'review_session_id',
  });
});

test('DESKTOP-REVIEW-LOOP-GH-01 fails closed when the fresh session identity is missing', () => {
  const outcome = buildRecoveryReviewAuthority({
    readyReceipt: validReady(),
    expectedAuthority: expectedAuthority(),
    reviewSessionId: '',
  });

  assert.deepEqual(outcome, {
    valid: false,
    reason: 'FRESH_REVIEW_SESSION_REQUIRED',
    field: 'review_session_id',
  });
});

test('DESKTOP-REVIEW-LOOP-GH-01 uses #45 duplicate-safe publication for replay', async () => {
  const authority = buildRecoveryReviewAuthority({
    readyReceipt: validReady(),
    expectedAuthority: expectedAuthority(),
    reviewSessionId: REVIEW_SESSION_ID,
  }).authority;
  const records = new Map();
  let created = 0;
  const adapter = {
    async publishIfAbsent({ idempotency_key, fingerprint }) {
      const existing = records.get(idempotency_key);
      if (existing) return { created: false, pointer: existing.pointer };
      const pointer = { receipt_id: 'gh01-receipt-1' };
      records.set(idempotency_key, { fingerprint, pointer });
      created += 1;
      return { created: true, pointer };
    },
    async read({ idempotency_key }) {
      const record = records.get(idempotency_key);
      return record
        ? { idempotency_key, fingerprint: record.fingerprint, pointer: record.pointer }
        : null;
    },
  };
  const publisher = createReviewResultPublisher({ authority, adapter });
  const result = {
    ...authority,
    decision: 'PASS',
    findings: [],
    next_state: 'READY_FOR_NEXT_TASK',
  };

  const [first, replay] = await Promise.all([
    publisher.publish(result),
    publisher.publish(result),
  ]);

  assert.deepEqual(
    [first.idempotency_disposition, replay.idempotency_disposition].sort(),
    ['CREATED', 'REUSED'],
  );
  assert.deepEqual(first.receipt_pointer, replay.receipt_pointer);
  assert.equal(created, 1);
});
