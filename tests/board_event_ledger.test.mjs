import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_EVENT_SCHEMA_VERSION,
  boardEventSchema,
  createEvent,
  canonicalEvent,
  serializeEvent,
  eventDigest,
  findIdempotencyConflict,
  projectEvents,
  fenceOlderEvents,
  classifyLease,
  buildHandoffEvent,
  reconcileProjection,
  publishEvent,
  reconcilePublication,
} from "../src/board_event_ledger.mjs";

const SEED = "0".repeat(40);

function baseEvent(overrides = {}) {
  return {
    schema_version: BOARD_EVENT_SCHEMA_VERSION,
    work_order_id: "GBB-TEST-01",
    event_id: "EVT-1",
    sequence: 1,
    generation: 1,
    predecessor_event_id: null,
    predecessor_commit: null,
    attempt_id: "ATT-1",
    idempotency_key: "IDEM-1",
    role: "Worker",
    transition: "CLAIM_AND_CLOCK_IN",
    state: "ACTIVE",
    authority: "#1/1",
    scope: "test scope",
    checkpoint: "CHECKPOINT-1",
    clock_in_utc: "2026-10-23T09:00:00+00:00",
    next_legal_action: "DO_THE_NEXT_THING",
    ...overrides,
  };
}

function createFakeGitHub({ head = SEED } = {}) {
  const state = { head, commits: new Map(), updates: [] };
  let counter = 0;
  return {
    state,
    async readRef(ref) {
      return state.head ? { ref, sha: state.head } : null;
    },
    async createCommit({ parent, message, event }) {
      counter += 1;
      const sha = counter.toString(16).padStart(40, "0");
      state.commits.set(sha, { parent, message, event });
      return { sha };
    },
    async updateRef({ ref, sha, expectedSha, force }) {
      state.updates.push({ ref, sha, expectedSha, force });
      if (force !== false) {
        throw Object.assign(new Error("force update is forbidden"), { code: "FORCE_FORBIDDEN" });
      }
      if (state.head !== expectedSha) {
        throw Object.assign(new Error("Update is not a fast forward"), {
          code: "STALE_HEAD",
          status: 422,
        });
      }
      const commit = state.commits.get(sha);
      if (!commit || commit.parent !== state.head) {
        throw Object.assign(new Error("Update is not a fast forward"), {
          code: "STALE_HEAD",
          status: 422,
        });
      }
      state.head = sha;
      return { ref, sha };
    },
  };
}

test("RED: board event ledger behavior is not yet implemented", () => {
  assert.equal(typeof createEvent, "function", "createEvent must be implemented before green");
});

test("schema accepts an identity-free event and applies nullable/array defaults", () => {
  const parsed = boardEventSchema.parse(baseEvent());
  assert.equal(parsed.executor_identity, undefined);
  assert.equal(parsed.predecessor_event_id, null);
  assert.equal(parsed.checkpoint_utc, null);
  assert.deepEqual(parsed.evidence, []);
  assert.deepEqual(parsed.fenced_event_ids, []);
  assert.equal(parsed.superseded_by_event_id, null);
});

test("schema keeps executor identity optional audit metadata", () => {
  const withIdentity = createEvent(baseEvent({ executor_identity: "audit-only-agent" }));
  assert.equal(withIdentity.executor_identity, "audit-only-agent");
  const withoutIdentity = createEvent(baseEvent());
  assert.equal("executor_identity" in withoutIdentity, false);
});

test("schema rejects missing idempotency key, bad role and bad timestamps", () => {
  assert.throws(() => boardEventSchema.parse(baseEvent({ idempotency_key: undefined })));
  assert.throws(() => boardEventSchema.parse(baseEvent({ role: "Admin" })));
  assert.throws(() => boardEventSchema.parse(baseEvent({ clock_in_utc: "not-a-time" })));
});

test("canonical serialization is deterministic regardless of key insertion order", () => {
  const a = baseEvent();
  const b = Object.fromEntries(Object.entries(baseEvent()).reverse());
  assert.equal(serializeEvent(a), serializeEvent(b));
  assert.equal(eventDigest(a), eventDigest(b));
  assert.deepEqual(Object.keys(canonicalEvent(a)).slice(0, 3), [
    "schema_version",
    "work_order_id",
    "event_id",
  ]);
});

test("first contender advances the shared head with a non-forced update", async () => {
  const github = createFakeGitHub();
  const event = baseEvent({ predecessor_commit: SEED });
  const result = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: SEED, event });

  assert.equal(result.outcome, "ACCEPTED");
  assert.equal(result.published, true);
  assert.equal(github.state.head, result.commit_sha);
  assert.equal(github.state.updates.length, 1);
  assert.equal(github.state.updates[0].force, false);
  assert.equal(github.state.updates[0].expectedSha, SEED);
});

test("two contenders share one parent: only the first advances, the stale one is rejected and reconciles without blind retry", async () => {
  const github = createFakeGitHub();
  const contenderA = baseEvent({
    event_id: "EVT-A",
    idempotency_key: "IDEM-A",
    sequence: 2,
    generation: 2,
    predecessor_event_id: "EVT-SEED",
    predecessor_commit: SEED,
  });
  const contenderB = baseEvent({
    event_id: "EVT-B",
    idempotency_key: "IDEM-B",
    sequence: 2,
    generation: 2,
    predecessor_event_id: "EVT-SEED",
    predecessor_commit: SEED,
  });

  const first = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: SEED, event: contenderA });
  assert.equal(first.outcome, "ACCEPTED");

  const stale = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: SEED, event: contenderB });
  assert.equal(stale.outcome, "STALE_HEAD");
  assert.equal(stale.published, false);
  assert.equal(stale.observed_head, first.commit_sha);
  assert.equal(github.state.head, first.commit_sha);
  assert.equal(github.state.updates.length, 1);
  assert.equal(stale.next_legal_action, "REREAD_CANONICAL_HEAD_AND_REBASE_NO_BLIND_RETRY");

  const rebased = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: first.commit_sha,
    event: { ...contenderB, predecessor_commit: first.commit_sha },
  });
  assert.equal(rebased.outcome, "ACCEPTED");
  assert.equal(github.state.updates.length, 2);
  assert.equal(github.state.head, rebased.commit_sha);
});

test("a write-time race is rejected as stale and reread from the competing head", async () => {
  const github = createFakeGitHub();
  const competitor = "f".repeat(40);
  const realUpdate = github.updateRef;
  let raced = false;
  github.updateRef = async (args) => {
    if (!raced) {
      raced = true;
      github.state.head = competitor;
    }
    return realUpdate(args);
  };

  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: SEED,
    event: baseEvent({ predecessor_commit: SEED }),
  });

  assert.equal(result.outcome, "STALE_HEAD");
  assert.equal(result.published, false);
  assert.equal(result.observed_head, competitor);
  assert.equal(github.state.head, competitor);
});

test("duplicate idempotency keys do not create a second accepted transition", async () => {
  const github = createFakeGitHub();
  const event = baseEvent({ predecessor_commit: SEED });
  const first = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: SEED, event });
  assert.equal(first.outcome, "ACCEPTED");
  const updatesAfterFirst = github.state.updates.length;

  const replay = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: first.head,
    event,
    history: [first.event],
  });

  assert.equal(replay.outcome, "DUPLICATE");
  assert.equal(replay.published, false);
  assert.equal(github.state.updates.length, updatesAfterFirst);
  assert.equal(github.state.head, first.head);

  const conflicted = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: first.head,
    event: { ...event, event_id: "EVT-OTHER", state: "DIFFERENT" },
    history: [first.event],
  });
  assert.equal(conflicted.outcome, "IDEMPOTENCY_CONFLICT");
  assert.equal(conflicted.published, false);
  assert.equal(github.state.head, first.head);
});

test("findIdempotencyConflict distinguishes exact replay from conflicting reuse", () => {
  const prior = createEvent(baseEvent());
  assert.equal(findIdempotencyConflict([prior], baseEvent()).kind, "DUPLICATE");
  assert.equal(
    findIdempotencyConflict([prior], baseEvent({ event_id: "EVT-2" })).kind,
    "IDEMPOTENCY_CONFLICT"
  );
  assert.equal(findIdempotencyConflict([prior], baseEvent({ idempotency_key: "IDEM-2", event_id: "EVT-2" })), null);
});

test("new accepted events fence older generations", () => {
  const older = createEvent(baseEvent({ event_id: "EVT-1", idempotency_key: "IDEM-1", generation: 1, sequence: 1 }));
  const newer = createEvent(
    baseEvent({
      event_id: "EVT-2",
      idempotency_key: "IDEM-2",
      generation: 2,
      sequence: 2,
      predecessor_event_id: "EVT-1",
    })
  );

  const projection = projectEvents([older, newer]);
  assert.equal(projection.active.length, 1);
  assert.equal(projection.active[0].event_id, "EVT-2");
  assert.deepEqual(projection.fenced_event_ids, ["EVT-1"]);
  assert.deepEqual(projection.duplicate_idempotency_event_ids, []);
  assert.deepEqual(fenceOlderEvents(newer, [older]), ["EVT-1"]);
});

test("projectEvents reports duplicate idempotency keys in corrupt history", () => {
  const first = createEvent(baseEvent({ event_id: "EVT-1", generation: 1, sequence: 1 }));
  const dup = createEvent(baseEvent({ event_id: "EVT-2", generation: 2, sequence: 2 }));
  const projection = projectEvents([first, dup]);
  assert.deepEqual(projection.duplicate_idempotency_event_ids, ["EVT-2"]);
});

test("lease expiry is observable and handoff keeps the same work order and checkpoint", () => {
  const claim = createEvent(
    baseEvent({
      lease_expires_utc: "2026-10-23T09:10:00+00:00",
      clock_in_utc: "2026-10-23T09:00:00+00:00",
    })
  );

  assert.equal(classifyLease(claim, "2026-10-23T09:05:00+00:00").state, "ACTIVE");
  const expired = classifyLease(claim, "2026-10-23T09:10:00+00:00");
  assert.equal(expired.state, "EXPIRED");
  assert.equal(expired.active, false);

  const handoff = buildHandoffEvent(claim, {
    event_id: "EVT-HANDOFF",
    attempt_id: "ATT-2",
    idempotency_key: "IDEM-HANDOFF",
    handoff_utc: "2026-10-23T09:11:00+00:00",
    clock_in_utc: "2026-10-23T09:12:00+00:00",
    lease_expires_utc: "2026-10-23T09:30:00+00:00",
  });

  assert.equal(handoff.work_order_id, claim.work_order_id);
  assert.equal(handoff.checkpoint, claim.checkpoint);
  assert.equal(handoff.generation, claim.generation + 1);
  assert.equal(handoff.sequence, claim.sequence + 1);
  assert.equal(handoff.predecessor_event_id, claim.event_id);
  assert.equal(classifyLease(handoff, "2026-10-23T09:15:00+00:00").state, "HANDED_OFF");
});

test("projection lag cannot authorize stale work", () => {
  const canonical = { head: "a".repeat(40), generation: 5, next_legal_action: "CONTINUE" };

  assert.equal(reconcileProjection({ canonical, projection: { ...canonical } }).can_authorize, true);

  const lagging = reconcileProjection({
    canonical,
    projection: { head: "b".repeat(40), generation: 4 },
  });
  assert.equal(lagging.state, "LAGGING");
  assert.equal(lagging.can_authorize, false);
  assert.equal(lagging.next_legal_action, "READ_CANONICAL_LEDGER_BEFORE_ANY_STALE_WORK");

  const diverged = reconcileProjection({
    canonical,
    projection: { head: "c".repeat(40), generation: 6 },
  });
  assert.equal(diverged.state, "DIVERGED");
  assert.equal(diverged.can_authorize, false);

  const forked = reconcileProjection({
    canonical,
    projection: { head: "d".repeat(40), generation: 5 },
  });
  assert.equal(forked.state, "FORKED");
  assert.equal(forked.can_authorize, false);

  const missing = reconcileProjection({ canonical, projection: null });
  assert.equal(missing.state, "MISSING_PROJECTION");
  assert.equal(missing.can_authorize, false);
});

test("uncertain delivery that did apply reconciles as published and never republishes", async () => {
  const github = createFakeGitHub();
  github.updateRef = async ({ sha }) => {
    github.state.updates.push({ sha });
    github.state.head = sha;
    throw Object.assign(new Error("socket hang up"), { code: "EIO" });
  };

  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: SEED,
    event: baseEvent({ predecessor_commit: SEED }),
  });
  assert.equal(result.outcome, "PUBLICATION_UNCERTAIN");
  assert.equal(result.published, false);

  const reconciled = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: result.attempted_commit_sha,
    expectedHead: SEED,
  });
  assert.equal(reconciled.outcome, "PUBLISHED");
  assert.equal(reconciled.accepted, true);
  assert.equal(reconciled.head, result.attempted_commit_sha);
  assert.equal(github.state.head, result.attempted_commit_sha);
  assert.equal(github.state.updates.length, 1);
});

test("uncertain delivery that did not apply reconciles as not published", async () => {
  const github = createFakeGitHub();
  github.updateRef = async ({ sha }) => {
    github.state.updates.push({ sha });
    throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  };

  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: SEED,
    event: baseEvent({ predecessor_commit: SEED }),
  });
  assert.equal(result.outcome, "PUBLICATION_UNCERTAIN");

  const reconciled = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: result.attempted_commit_sha,
    expectedHead: SEED,
  });
  assert.equal(reconciled.outcome, "NOT_PUBLISHED");
  assert.equal(reconciled.accepted, false);
  assert.equal(github.state.head, SEED);
  assert.equal(github.state.updates.length, 1);
});

test("worker identity is not an admission predicate", async () => {
  const eventWithIdentity = baseEvent({
    event_id: "EVT-ID-A",
    idempotency_key: "IDEM-ID-A",
    predecessor_commit: SEED,
    executor_identity: "optional-agent-a",
  });
  const eventWithoutIdentity = baseEvent({
    event_id: "EVT-ID-B",
    idempotency_key: "IDEM-ID-B",
    predecessor_commit: SEED,
    executor_identity: "optional-agent-b",
  });

  const githubA = createFakeGitHub();
  const githubB = createFakeGitHub();
  const a = await publishEvent({ github: githubA, ref: "refs/heads/proof", expectedHead: SEED, event: eventWithIdentity });
  const b = await publishEvent({ github: githubB, ref: "refs/heads/proof", expectedHead: SEED, event: eventWithoutIdentity });

  assert.equal(a.outcome, "ACCEPTED");
  assert.equal(b.outcome, "ACCEPTED");
  assert.equal(githubA.state.head, a.commit_sha);
  assert.equal(githubB.state.head, b.commit_sha);
  assert.match(a.commit_sha, /^[0-9a-f]{40}$/);
  assert.match(b.commit_sha, /^[0-9a-f]{40}$/);
});

test("publishEvent rejects an adapter missing the required operations", async () => {
  await assert.rejects(
    () => publishEvent({ github: { readRef: async () => null }, ref: "r", expectedHead: null, event: baseEvent() }),
    /readRef, createCommit and updateRef/
  );
});
