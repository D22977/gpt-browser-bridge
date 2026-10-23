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
    async readCommit(sha) {
      const commit = state.commits.get(sha);
      if (!commit) return null;
      return {
        sha,
        parent: commit.parent,
        parents: commit.parent ? [{ sha: commit.parent }] : [],
        event: commit.event,
      };
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
  const seedEvent = createEvent(
    baseEvent({
      event_id: "EVT-SEED",
      idempotency_key: "IDEM-SEED",
      sequence: 1,
      generation: 1,
      predecessor_event_id: null,
      predecessor_commit: null,
    })
  );
  const seed = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: SEED, event: seedEvent });
  assert.equal(seed.outcome, "ACCEPTED");

  const contenderA = baseEvent({
    event_id: "EVT-A",
    idempotency_key: "IDEM-A",
    sequence: 2,
    generation: 2,
    predecessor_event_id: "EVT-SEED",
    predecessor_commit: seed.commit_sha,
  });
  const contenderB = baseEvent({
    event_id: "EVT-B",
    idempotency_key: "IDEM-B",
    sequence: 2,
    generation: 2,
    predecessor_event_id: "EVT-SEED",
    predecessor_commit: seed.commit_sha,
  });

  const first = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: seed.commit_sha, event: contenderA, history: [seed.event] });
  assert.equal(first.outcome, "ACCEPTED");

  const stale = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: seed.commit_sha, event: contenderB, history: [seed.event] });
  assert.equal(stale.outcome, "STALE_HEAD");
  assert.equal(stale.published, false);
  assert.equal(stale.observed_head, first.commit_sha);
  assert.equal(github.state.head, first.commit_sha);
  assert.equal(github.state.updates.length, 2);
  assert.equal(stale.next_legal_action, "REREAD_CANONICAL_HEAD_AND_REBASE_NO_BLIND_RETRY");

  const rebased = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: first.commit_sha,
    event: { ...contenderB, predecessor_commit: first.commit_sha },
    history: [first.event],
  });
  assert.notEqual(rebased.outcome, "ACCEPTED");
  assert.equal(rebased.published, false);
  assert.equal(github.state.updates.length, 2);
  assert.equal(github.state.head, first.commit_sha);
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
  assert.deepEqual(projection.duplicate_idempotency_event_ids, ["EVT-1", "EVT-2"]);
});

test("lease expiry is observable and handoff keeps the same work order and checkpoint", async () => {
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

  const headSha = "a".repeat(40);
  const github = createCommitBoundGitHub(headSha, claim);
  let handoff;
  await assert.doesNotReject(async () => {
    handoff = await buildHandoffEvent(
      claim,
      {
      event_id: "EVT-HANDOFF",
      attempt_id: "ATT-2",
      idempotency_key: "IDEM-HANDOFF",
      predecessor_commit: headSha,
      handoff_utc: "2026-10-23T09:11:00+00:00",
      clock_in_utc: "2026-10-23T09:12:00+00:00",
      lease_expires_utc: "2026-10-23T09:30:00+00:00",
      },
      { github, ref: "refs/heads/proof", expectedHead: headSha, history: [claim] }
    );
  });

  assert.equal(handoff.work_order_id, claim.work_order_id);
  assert.equal(handoff.checkpoint, claim.checkpoint);
  assert.equal(handoff.generation, claim.generation + 1);
  assert.equal(handoff.sequence, claim.sequence + 1);
  assert.equal(handoff.predecessor_event_id, claim.event_id);
  assert.equal(handoff.predecessor_commit, headSha);
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
    event: baseEvent({ predecessor_commit: SEED }),
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

test("REGRESSION finding1: omitted or stale canonical history cannot publish a successor", async () => {
  const github = createFakeGitHub();
  const first = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: SEED,
    event: baseEvent({ event_id: "EVT-A", idempotency_key: "IDEM-A", predecessor_commit: SEED }),
  });
  assert.equal(first.outcome, "ACCEPTED");

  const omittedHistory = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: first.commit_sha,
    event: baseEvent({
      event_id: "EVT-B",
      idempotency_key: "IDEM-B",
      sequence: 2,
      generation: 2,
      predecessor_event_id: first.event.event_id,
      predecessor_commit: first.commit_sha,
    }),
  });
  assert.equal(omittedHistory.published, false);

  const stalePredecessor = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: first.commit_sha,
    event: baseEvent({
      event_id: "EVT-C",
      idempotency_key: "IDEM-C",
      sequence: 2,
      generation: 2,
      predecessor_event_id: "EVT-SEED",
      predecessor_commit: first.commit_sha,
    }),
    history: [first.event],
  });
  assert.equal(stalePredecessor.published, false);
});

test("REGRESSION finding2: reconcilePublication preserves IDEMPOTENCY_CONFLICT as not accepted", async () => {
  const github = createFakeGitHub();
  const event = baseEvent({ predecessor_commit: SEED });
  const first = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: SEED, event });
  assert.equal(first.outcome, "ACCEPTED");

  const conflictedEvent = { ...event, event_id: "EVT-OTHER", state: "DIFFERENT" };
  const reconciled = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: "f".repeat(40),
    expectedHead: first.commit_sha,
    history: [first.event],
    event: conflictedEvent,
  });
  assert.equal(reconciled.outcome, "IDEMPOTENCY_CONFLICT");
  assert.equal(reconciled.accepted, false);
});

test("REGRESSION finding3: projectEvents quarantines every member of an idempotency conflict", () => {
  const first = createEvent(baseEvent({ event_id: "EVT-1", idempotency_key: "IDEM-1", generation: 1, sequence: 1 }));
  const invalid = createEvent(
    baseEvent({ event_id: "EVT-2", idempotency_key: "IDEM-1", generation: 99, sequence: 99 })
  );
  const projection = projectEvents([first, invalid]);
  assert.equal(projection.active.length, 0);
  assert.ok(projection.quarantined_event_ids.includes("EVT-1"));
  assert.ok(projection.quarantined_event_ids.includes("EVT-2"));
});

test("REGRESSION finding4: buildHandoffEvent requires predecessor commit provenance", async () => {
  const prior = createEvent(baseEvent({ predecessor_commit: null }));
  const headSha = "a".repeat(40);
  const github = createCommitBoundGitHub(headSha, prior);
  await assert.rejects(
    () =>
      buildHandoffEvent(prior, {
        event_id: "EVT-HANDOFF",
        attempt_id: "ATT-2",
        idempotency_key: "IDEM-HANDOFF",
        clock_in_utc: "2026-10-23T09:12:00+00:00",
      }),
    /predecessor_commit/
  );
  let handoff;
  await assert.doesNotReject(async () => {
    handoff = await buildHandoffEvent(
      prior,
      {
      event_id: "EVT-HANDOFF",
      attempt_id: "ATT-2",
      idempotency_key: "IDEM-HANDOFF",
      predecessor_commit: headSha,
      clock_in_utc: "2026-10-23T09:12:00+00:00",
      },
      { github, ref: "refs/heads/proof", expectedHead: headSha, history: [prior] }
    );
  });
  assert.equal(handoff.predecessor_commit, headSha);
});

function createCommitBoundGitHub(headSha, headEvent) {
  const state = { head: headSha, commits: new Map(), updates: [] };
  state.commits.set(headSha, { sha: headSha, parent: SEED, message: "head", event: headEvent });
  let counter = 0;
  return {
    state,
    async readRef(ref) {
      return { ref, sha: state.head };
    },
    async readCommit(sha) {
      const c = state.commits.get(sha);
      if (!c) return null;
      return { sha: c.sha, parent: c.parent, parents: c.parent ? [{ sha: c.parent }] : [], event: c.event };
    },
    async createCommit({ parent, message, event }) {
      counter += 1;
      const sha = (1000 + counter).toString(16).padStart(40, "0");
      state.commits.set(sha, { sha, parent, message, event });
      return { sha };
    },
    async updateRef({ ref, sha, expectedSha, force }) {
      state.updates.push({ ref, sha, expectedSha, force });
      if (force !== false) {
        throw Object.assign(new Error("force update is forbidden"), { code: "FORCE_FORBIDDEN" });
      }
      if (state.head !== expectedSha) {
        throw Object.assign(new Error("Update is not a fast forward"), { code: "STALE_HEAD", status: 422 });
      }
      const commit = state.commits.get(sha);
      if (!commit || commit.parent !== state.head) {
        throw Object.assign(new Error("Update is not a fast forward"), { code: "STALE_HEAD", status: 422 });
      }
      state.head = sha;
      return { ref, sha };
    },
  };
}

test("REGRESSION review1: forged caller history that does not match the ref commit is rejected", async () => {
  const headSha = "a".repeat(40);
  const headEvent = createEvent(baseEvent({ event_id: "EVT-HEAD", idempotency_key: "IDEM-HEAD", sequence: 1, generation: 1, predecessor_commit: null, predecessor_event_id: null }));
  const github = createCommitBoundGitHub(headSha, headEvent);

  const forgedPrior = createEvent(baseEvent({ event_id: "EVT-OLD", idempotency_key: "IDEM-OLD", sequence: 1, generation: 1, predecessor_event_id: null, predecessor_commit: null }));
  const candidate = baseEvent({
    event_id: "EVT-NEW",
    idempotency_key: "IDEM-NEW",
    sequence: 2,
    generation: 2,
    predecessor_event_id: "EVT-OLD",
    predecessor_commit: headSha,
  });

  const result = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: headSha, event: candidate, history: [forgedPrior] });
  assert.equal(result.published, false);
  assert.equal(result.outcome, "INVALID_HISTORY");
  assert.equal(github.state.head, headSha);
});

test("REGRESSION review1b: omitted history cannot create a second root when the ref already exists", async () => {
  const headSha = "a".repeat(40);
  const headEvent = createEvent(baseEvent({ event_id: "EVT-HEAD", idempotency_key: "IDEM-HEAD" }));
  const github = createCommitBoundGitHub(headSha, headEvent);

  const rootCandidate = baseEvent({
    event_id: "EVT-ROOT2",
    idempotency_key: "IDEM-ROOT2",
    predecessor_event_id: null,
    predecessor_commit: null,
  });
  const result = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: headSha, event: rootCandidate });
  assert.equal(result.published, false);
  assert.equal(result.outcome, "INVALID_HISTORY");
  assert.equal(github.state.head, headSha);
});

test("REGRESSION review2: projectEvents is input-order invariant and quarantines forks", () => {
  const root = createEvent(baseEvent({ event_id: "R", idempotency_key: "K-R", sequence: 0, generation: 0, predecessor_event_id: null }));
  const a = createEvent(baseEvent({ event_id: "A", idempotency_key: "K-A", sequence: 1, generation: 1, predecessor_event_id: "R" }));
  const b = createEvent(baseEvent({ event_id: "B", idempotency_key: "K-B", sequence: 1, generation: 1, predecessor_event_id: "R" }));

  for (const order of [[root, a, b], [root, b, a], [a, root, b]]) {
    const projection = projectEvents(order);
    assert.equal(projection.active.length, 1, JSON.stringify(order));
    assert.equal(projection.active[0].event_id, "R", JSON.stringify(order));
    assert.ok(projection.quarantined_event_ids.includes("A"), JSON.stringify(order));
    assert.ok(projection.quarantined_event_ids.includes("B"), JSON.stringify(order));
  }
});

test("REGRESSION review2b: duplicate event id with changed payload is quarantined", () => {
  const first = createEvent(baseEvent({ event_id: "E", idempotency_key: "K-1", sequence: 1, generation: 1 }));
  const changed = createEvent(baseEvent({ event_id: "E", idempotency_key: "K-2", sequence: 2, generation: 2 }));
  const projection = projectEvents([first, changed]);
  assert.equal(projection.active.length, 0);
  assert.ok(projection.quarantined_event_ids.includes("E"));
});

test("REGRESSION review2c: multiple roots quarantine the whole history", () => {
  const r1 = createEvent(baseEvent({ event_id: "R1", idempotency_key: "K-R1", sequence: 0, generation: 0, predecessor_event_id: null }));
  const r2 = createEvent(baseEvent({ event_id: "R2", idempotency_key: "K-R2", sequence: 0, generation: 0, predecessor_event_id: null }));
  const projection = projectEvents([r1, r2]);
  assert.equal(projection.active.length, 0);
  assert.ok(projection.quarantined_event_ids.includes("R1"));
  assert.ok(projection.quarantined_event_ids.includes("R2"));
});

test("REGRESSION review3: active lease cannot be self-fenced by listing predecessor in fenced_event_ids", async () => {
  const github = createFakeGitHub();
  github.readCommit = async (sha) => {
    const c = github.state.commits.get(sha);
    if (!c) return null;
    return { sha, parent: c.parent, parents: c.parent ? [{ sha: c.parent }] : [], event: c.event };
  };
  const prior = createEvent(baseEvent({
    event_id: "PRIOR",
    idempotency_key: "IDEM-PRIOR",
    predecessor_commit: SEED,
    lease_expires_utc: "2026-10-23T10:00:00+00:00",
  }));
  const first = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: SEED, event: prior });
  assert.equal(first.outcome, "ACCEPTED");

  const candidate = baseEvent({
    event_id: "NEXT",
    idempotency_key: "IDEM-NEXT",
    sequence: 2,
    generation: 2,
    predecessor_event_id: "PRIOR",
    predecessor_commit: first.commit_sha,
    fenced_event_ids: ["PRIOR"],
  });
  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: first.commit_sha,
    event: candidate,
    history: [first.event],
    trustedNowUtc: "2026-10-23T09:30:00+00:00",
  });
  assert.equal(result.published, false);
  assert.equal(result.outcome, "INVALID_HISTORY");
});

test("REGRESSION review3b: expired lease permits successor publication", async () => {
  const github = createFakeGitHub();
  github.readCommit = async (sha) => {
    const c = github.state.commits.get(sha);
    if (!c) return null;
    return { sha, parent: c.parent, parents: c.parent ? [{ sha: c.parent }] : [], event: c.event };
  };
  const prior = createEvent(baseEvent({
    event_id: "PRIOR",
    idempotency_key: "IDEM-PRIOR",
    predecessor_commit: SEED,
    lease_expires_utc: "2026-10-23T09:10:00+00:00",
  }));
  const first = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: SEED, event: prior });
  assert.equal(first.outcome, "ACCEPTED");

  const candidate = baseEvent({
    event_id: "NEXT",
    idempotency_key: "IDEM-NEXT",
    sequence: 2,
    generation: 2,
    predecessor_event_id: "PRIOR",
    predecessor_commit: first.commit_sha,
  });
  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: first.commit_sha,
    event: candidate,
    history: [first.event],
    trustedNowUtc: "2026-10-23T09:30:00+00:00",
  });
  assert.equal(result.outcome, "ACCEPTED");
  assert.equal(result.published, true);
});

test("REGRESSION review3c: illegal transition value is rejected", async () => {
  const github = createFakeGitHub();
  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: SEED,
    event: baseEvent({ transition: "ILLEGAL_TRANSITION", predecessor_commit: SEED }),
  });
  assert.equal(result.published, false);
  assert.equal(result.outcome, "INVALID_HISTORY");
});

test("REGRESSION review4: buildHandoffEvent rejects an arbitrary 40-hex commit without provenance", async () => {
  const prior = createEvent(baseEvent({ predecessor_commit: null }));
  await assert.rejects(
    async () =>
      buildHandoffEvent(prior, {
        event_id: "EVT-HANDOFF",
        attempt_id: "ATT-2",
        idempotency_key: "IDEM-HANDOFF",
        predecessor_commit: "f".repeat(40),
        clock_in_utc: "2026-10-23T09:12:00+00:00",
      }),
    /provenance/
  );
});

test("REGRESSION review5: reconcilePublication fails closed for unverified history even when head equals attempted commit", async () => {
  const headSha = "a".repeat(40);
  const headEvent = createEvent(baseEvent({ event_id: "EVT-HEAD", idempotency_key: "IDEM-HEAD" }));
  const github = createCommitBoundGitHub(headSha, headEvent);

  const prior = createEvent(baseEvent({ event_id: "EVT-PRIOR", idempotency_key: "IDEM-PRIOR" }));
  const conflicting = baseEvent({ event_id: "EVT-OTHER", idempotency_key: "IDEM-PRIOR", state: "DIFFERENT" });

  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: headSha,
    expectedHead: "b".repeat(40),
    history: [prior],
    event: conflicting,
  });
  assert.equal(result.accepted, false);
  assert.notEqual(result.outcome, "PUBLISHED");
});

test("REGRESSION review5b: reconcilePublication does not report PUBLISHED for a changed payload when history is absent", async () => {
  const headSha = "a".repeat(40);
  const headEvent = createEvent(baseEvent({ event_id: "EVT-HEAD", idempotency_key: "IDEM-HEAD", state: "ORIGINAL" }));
  const github = createCommitBoundGitHub(headSha, headEvent);

  const conflicting = baseEvent({ event_id: "EVT-CAND", idempotency_key: "IDEM-HEAD", state: "CHANGED" });
  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: headSha,
    expectedHead: headSha,
    history: [],
    event: conflicting,
  });
  assert.equal(result.accepted, false);
  assert.notEqual(result.outcome, "PUBLISHED");
});

test("REGRESSION review5c: reconcilePublication does not accept a duplicate from unverified history", async () => {
  const headSha = "a".repeat(40);
  const committed = createEvent(baseEvent({ event_id: "EVT-COMMITTED", idempotency_key: "IDEM-SAME" }));
  const github = createCommitBoundGitHub(headSha, committed);
  const forgedPrior = createEvent(baseEvent({ event_id: "EVT-FORGED", idempotency_key: "IDEM-SAME" }));

  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: headSha,
    expectedHead: "b".repeat(40),
    history: [forgedPrior],
    event: forgedPrior,
  });

  assert.equal(result.accepted, false);
  assert.notEqual(result.outcome, "DUPLICATE");
});

test("REGRESSION review6: caller time cannot expire a lease before the trusted GitHub clock", async () => {
  const github = createFakeGitHub();
  github.now = () => "2026-10-23T09:05:00+00:00";
  github.readCommit = async (sha) => {
    const c = github.state.commits.get(sha);
    if (!c) return null;
    return { sha, parent: c.parent, parents: c.parent ? [{ sha: c.parent }] : [], event: c.event };
  };
  const prior = createEvent(baseEvent({
    event_id: "PRIOR-TIMED",
    idempotency_key: "IDEM-PRIOR-TIMED",
    lease_expires_utc: "2026-10-23T10:00:00+00:00",
  }));
  const first = await publishEvent({ github, ref: "refs/heads/proof", expectedHead: SEED, event: prior });
  assert.equal(first.outcome, "ACCEPTED");

  const candidate = baseEvent({
    event_id: "NEXT-TIMED",
    idempotency_key: "IDEM-NEXT-TIMED",
    sequence: 2,
    generation: 2,
    predecessor_event_id: prior.event_id,
    predecessor_commit: first.commit_sha,
  });
  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: first.commit_sha,
    event: candidate,
    history: [first.event],
    trustedNowUtc: "2026-10-23T13:00:00+00:00",
  });

  assert.equal(result.published, false);
  assert.equal(result.outcome, "INVALID_HISTORY");
});

test("REGRESSION review7: role transition state combinations use an explicit allowlist", async () => {
  const valid = [
    { role: "Control", transition: "AUTHORIZE_BOUNDED_REWORK", state: "READY_FOR_SINGLE_WORKER_CLAIM" },
    { role: "Control", transition: "RECONCILE_DISPATCH", state: "PROMPT_NOT_CONSUMED_PRE_SEND_FAILURE" },
    { role: "Worker", transition: "CLAIM_REQUESTED_AND_CLOCK_IN", state: "READ_ONLY_SOURCE_INSPECTION" },
    { role: "Worker", transition: "CLAIM_AND_CLOCK_IN", state: "IMPLEMENTATION_AND_LIVE_CAS_PROOF" },
    { role: "Worker", transition: "CLAIM", state: "IN_PROGRESS" },
    { role: "Worker", transition: "COMPLETE_REWORK", state: "READY_FOR_FRESH_REVIEW" },
    { role: "Reviewer", transition: "REVIEW_COMPLETE", state: "FIX_REQUIRED" },
  ];
  for (const [index, combination] of valid.entries()) {
    const github = createFakeGitHub();
    const result = await publishEvent({
      github,
      ref: "refs/heads/proof",
      expectedHead: SEED,
      event: baseEvent({
        ...combination,
        event_id: `EVT-ROLE-${index}`,
        idempotency_key: `IDEM-ROLE-${index}`,
        predecessor_commit: SEED,
      }),
    });
    assert.equal(result.outcome, "ACCEPTED", JSON.stringify(combination));
  }

  for (const combination of [
    { role: "Watcher", transition: "AUTHORIZE_BOUNDED_REWORK", state: "READY_FOR_SINGLE_WORKER_CLAIM" },
    { role: "Control", transition: "WARP", state: "READY_FOR_SINGLE_WORKER_CLAIM" },
    { role: "Worker", transition: "MADE_UP", state: "IN_PROGRESS" },
    { role: "Worker", transition: "CLAIM", state: "READY_FOR_FRESH_REVIEW" },
  ]) {
    const github = createFakeGitHub();
    const invalidEvent = createEvent(baseEvent({ ...combination, event_id: "INVALID-ROLE-STATE", idempotency_key: "INVALID-ROLE-STATE-KEY" }));
    const projection = projectEvents([invalidEvent]);
    assert.equal(projection.active.length, 0, JSON.stringify(combination));
    assert.ok(projection.quarantined_event_ids.includes("INVALID-ROLE-STATE"), JSON.stringify(combination));
    const result = await publishEvent({
      github,
      ref: "refs/heads/proof",
      expectedHead: SEED,
      event: { ...invalidEvent, predecessor_commit: SEED },
    });
    assert.equal(result.published, false, JSON.stringify(combination));
    assert.equal(result.outcome, "INVALID_HISTORY", JSON.stringify(combination));
  }
});

test("REGRESSION review8: all duplicate idempotency key members quarantine independent of input order", () => {
  const first = createEvent(baseEvent({ event_id: "DUP-A", idempotency_key: "IDEM-DUP", predecessor_event_id: null, sequence: 0, generation: 0 }));
  const second = createEvent(baseEvent({ event_id: "DUP-B", idempotency_key: "IDEM-DUP", predecessor_event_id: "DUP-A", sequence: 1, generation: 1 }));
  for (const events of [[first, second], [second, first]]) {
    const projection = projectEvents(events);
    assert.equal(projection.active.length, 0);
    assert.deepEqual(projection.duplicate_idempotency_event_ids, ["DUP-A", "DUP-B"]);
    assert.deepEqual(projection.quarantined_event_ids, ["DUP-A", "DUP-B"]);
  }
});

test("REGRESSION review9: projection quarantines sequence and generation jumps", () => {
  const root = createEvent(baseEvent({ event_id: "SEQ-ROOT", idempotency_key: "IDEM-SEQ-ROOT", predecessor_event_id: null, sequence: 0, generation: 0 }));
  const jump = createEvent(baseEvent({ event_id: "SEQ-JUMP", idempotency_key: "IDEM-SEQ-JUMP", predecessor_event_id: "SEQ-ROOT", sequence: 99, generation: 99 }));
  const projection = projectEvents([root, jump]);
  assert.equal(projection.active[0]?.event_id, "SEQ-ROOT");
  assert.ok(projection.quarantined_event_ids.includes("SEQ-JUMP"));
});

test("REGRESSION review10: handoff requires a commit containing the canonical prior event", async () => {
  const headSha = "a".repeat(40);
  const prior = createEvent(baseEvent({ event_id: "HANDOFF-PRIOR", idempotency_key: "IDEM-HANDOFF-PRIOR", predecessor_event_id: null, predecessor_commit: null }));
  const github = createCommitBoundGitHub(headSha, prior);
  const next = {
    event_id: "HANDOFF-NEXT",
    attempt_id: "ATT-2",
    idempotency_key: "IDEM-HANDOFF-NEXT",
    predecessor_commit: headSha,
    clock_in_utc: "2026-10-23T09:12:00+00:00",
  };

  await assert.rejects(async () => buildHandoffEvent(prior, next, { commit_sha: headSha }), /provenance|verified|canonical/i);
  await assert.rejects(async () => buildHandoffEvent(prior, next), /provenance|verified|canonical/i);
  const forgedSha = "f".repeat(40);
  const selfAttestedPrior = createEvent({ ...prior, predecessor_commit: forgedSha });
  await assert.rejects(
    async () => buildHandoffEvent(selfAttestedPrior, { ...next, predecessor_commit: forgedSha }, {
      github,
      ref: "refs/heads/proof",
      expectedHead: forgedSha,
      history: [selfAttestedPrior],
    }),
    /canonical|verified/i
  );

  let handoff;
  await assert.doesNotReject(async () => {
    handoff = await buildHandoffEvent(prior, next, {
      github,
      ref: "refs/heads/proof",
      expectedHead: headSha,
      history: [prior],
    });
  });
  assert.equal(handoff.predecessor_commit, headSha);
  assert.equal(handoff.predecessor_event_id, prior.event_id);
});

test("REGRESSION review11: readCommit fails closed when adapter omits the requested commit SHA", async () => {
  const headSha = "a".repeat(40);
  const prior = createEvent(baseEvent({ event_id: "SHA-PRIOR", idempotency_key: "IDEM-SHA-PRIOR", predecessor_event_id: null, predecessor_commit: null }));
  const github = createCommitBoundGitHub(headSha, prior);
  github.readCommit = async () => ({ parent: null, event: prior });
  const candidate = baseEvent({
    event_id: "SHA-NEXT",
    idempotency_key: "IDEM-SHA-NEXT",
    sequence: 2,
    generation: 2,
    predecessor_event_id: prior.event_id,
    predecessor_commit: headSha,
  });

  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: headSha,
    event: candidate,
    history: [prior],
  });
  assert.equal(result.published, false);
  assert.equal(result.outcome, "INVALID_HISTORY");
});


test("REGRESSION attempt09 finding1a: publishEvent rejects history with committed chain plus uncommitted orphan before idempotency", async () => {
  const github = createFakeGitHub();
  const committed = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: SEED,
    event: baseEvent({ event_id: "EVT-COMMITTED", idempotency_key: "IDEM-COMMITTED", predecessor_commit: SEED }),
  });
  assert.equal(committed.outcome, "ACCEPTED");

  const orphan = createEvent(baseEvent({
    event_id: "EVT-ORPHAN",
    idempotency_key: "IDEM-ORPHAN",
    predecessor_event_id: "GHOST",
  }));

  const candidate = baseEvent({
    event_id: "EVT-CAND",
    idempotency_key: "IDEM-ORPHAN",
    sequence: 2,
    generation: 2,
    predecessor_event_id: committed.event.event_id,
    predecessor_commit: committed.commit_sha,
  });

  const before = github.state.head;
  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: committed.commit_sha,
    event: candidate,
    history: [committed.event, orphan],
  });

  assert.equal(result.published, false);
  assert.equal(result.outcome, "INVALID_HISTORY");
  assert.equal(github.state.head, before);
});

test("REGRESSION attempt09 finding1b: reconcilePublication does not accept duplicate from history with orphan", async () => {
  const github = createFakeGitHub();
  const committed = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: SEED,
    event: baseEvent({ event_id: "EVT-COMMITTED", idempotency_key: "IDEM-COMMITTED", predecessor_commit: SEED }),
  });
  assert.equal(committed.outcome, "ACCEPTED");

  const orphan = createEvent(baseEvent({
    event_id: "EVT-ORPHAN",
    idempotency_key: "IDEM-ORPHAN",
    predecessor_event_id: "GHOST",
  }));

  const before = github.state.head;
  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: "f".repeat(40),
    expectedHead: committed.commit_sha,
    history: [committed.event, orphan],
    event: orphan,
  });

  assert.equal(result.accepted, false);
  assert.notEqual(result.outcome, "DUPLICATE");
  assert.equal(github.state.head, before);
});

test("REGRESSION attempt09 finding2: buildHandoffEvent default transition is publishable", async () => {
  const headSha = "a".repeat(40);
  const prior = createEvent(baseEvent({ event_id: "HANDOFF-PRIOR", idempotency_key: "IDEM-HANDOFF-PRIOR", predecessor_event_id: null, predecessor_commit: null }));
  const github = createCommitBoundGitHub(headSha, prior);

  let handoff;
  await assert.doesNotReject(async () => {
    handoff = await buildHandoffEvent(
      prior,
      {
        event_id: "HANDOFF-NEXT",
        attempt_id: "ATT-2",
        idempotency_key: "IDEM-HANDOFF-NEXT",
        predecessor_commit: headSha,
        clock_in_utc: "2026-10-23T09:12:00+00:00",
      },
      { github, ref: "refs/heads/proof", expectedHead: headSha, history: [prior] }
    );
  });

  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: headSha,
    event: handoff,
    history: [prior],
  });

  assert.equal(result.outcome, "ACCEPTED");
  assert.equal(result.published, true);
  assert.equal(github.state.head, result.commit_sha);
});
test("REGRESSION attempt10 finding1: publishEvent fails closed for nonempty history at genesis", async () => {
  const github = createFakeGitHub();
  const rootHistory = createEvent(baseEvent({
    event_id: "EVT-GENESIS-ROOT",
    idempotency_key: "IDEM-GENESIS-ROOT",
    predecessor_event_id: null,
    predecessor_commit: null,
  }));
  const candidate = createEvent(baseEvent({
    event_id: "EVT-GENESIS-ROOT",
    idempotency_key: "IDEM-GENESIS-ROOT",
    predecessor_event_id: null,
    predecessor_commit: null,
  }));

  const before = github.state.head;
  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: SEED,
    event: candidate,
    history: [rootHistory],
  });

  assert.equal(result.published, false);
  assert.notEqual(result.outcome, "DUPLICATE");
  assert.equal(github.state.head, before);
});

test("REGRESSION attempt10 finding2: reconcilePublication fails closed for nonempty history at genesis", async () => {
  const github = createFakeGitHub();
  const rootHistory = createEvent(baseEvent({
    event_id: "EVT-GENESIS-ROOT",
    idempotency_key: "IDEM-GENESIS-ROOT",
    predecessor_event_id: null,
    predecessor_commit: null,
  }));
  const candidate = createEvent(baseEvent({
    event_id: "EVT-GENESIS-ROOT",
    idempotency_key: "IDEM-GENESIS-ROOT",
    predecessor_event_id: null,
    predecessor_commit: null,
  }));

  const before = github.state.head;
  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: "f".repeat(40),
    expectedHead: SEED,
    history: [rootHistory],
    event: candidate,
  });

  assert.equal(result.accepted, false);
  assert.notEqual(result.outcome, "DUPLICATE");
  assert.equal(github.state.head, before);
});

test("REGRESSION attempt11: reconcilePublication does not accept an invalid attempted successor with omitted history", async () => {
  const rootSha = "a".repeat(40);
  const attemptedSha = "b".repeat(40);
  const root = createEvent(baseEvent({
    event_id: "ATTEMPT11-ROOT",
    idempotency_key: "IDEM-ATTEMPT11-ROOT",
    sequence: 0,
    generation: 0,
    predecessor_event_id: null,
    predecessor_commit: null,
    transition: "CHECKPOINT_AND_CLOCK_OUT",
    state: "HANDOFF_READY_FOR_BOUNDED_PROOF_SHIFT",
    clock_out_utc: "2026-10-23T09:01:00+00:00",
  }));
  const github = createCommitBoundGitHub(rootSha, root);
  const candidate = createEvent(baseEvent({
    event_id: "ATTEMPT11-GHOST",
    idempotency_key: "IDEM-ATTEMPT11-GHOST",
    sequence: 99,
    generation: 99,
    predecessor_event_id: "GHOST",
    predecessor_commit: rootSha,
  }));
  github.state.commits.set(attemptedSha, { sha: attemptedSha, parent: rootSha, event: candidate });
  github.state.head = attemptedSha;

  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: attemptedSha,
    expectedHead: rootSha,
    event: candidate,
  });

  assert.notEqual(result.outcome, "PUBLISHED");
  assert.equal(result.accepted, false);
});

test("REGRESSION attempt11: reconcilePublication does not accept an invalid attempted successor against verified history", async () => {
  const rootSha = "a".repeat(40);
  const attemptedSha = "b".repeat(40);
  const root = createEvent(baseEvent({
    event_id: "ATTEMPT11-ROOT-VERIFIED",
    idempotency_key: "IDEM-ATTEMPT11-ROOT-VERIFIED",
    sequence: 0,
    generation: 0,
    predecessor_event_id: null,
    predecessor_commit: null,
    transition: "CHECKPOINT_AND_CLOCK_OUT",
    state: "HANDOFF_READY_FOR_BOUNDED_PROOF_SHIFT",
    clock_out_utc: "2026-10-23T09:01:00+00:00",
  }));
  const github = createCommitBoundGitHub(rootSha, root);
  const candidate = createEvent(baseEvent({
    event_id: "ATTEMPT11-GHOST-VERIFIED",
    idempotency_key: "IDEM-ATTEMPT11-GHOST-VERIFIED",
    sequence: 99,
    generation: 99,
    predecessor_event_id: "GHOST",
    predecessor_commit: rootSha,
  }));
  github.state.commits.set(attemptedSha, { sha: attemptedSha, parent: rootSha, event: candidate });
  github.state.head = attemptedSha;

  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: attemptedSha,
    expectedHead: rootSha,
    history: [root],
    event: candidate,
  });

  assert.notEqual(result.outcome, "PUBLISHED");
  assert.equal(result.accepted, false);
});

test("REGRESSION attempt11: reconcilePublication accepts an exact valid contiguous attempted successor", async () => {
  const rootSha = "a".repeat(40);
  const attemptedSha = "b".repeat(40);
  const root = createEvent(baseEvent({
    event_id: "ATTEMPT11-VALID-ROOT",
    idempotency_key: "IDEM-ATTEMPT11-VALID-ROOT",
    sequence: 0,
    generation: 0,
    predecessor_event_id: null,
    predecessor_commit: null,
    transition: "CHECKPOINT_AND_CLOCK_OUT",
    state: "HANDOFF_READY_FOR_BOUNDED_PROOF_SHIFT",
    clock_out_utc: "2026-10-23T09:01:00+00:00",
  }));
  const github = createCommitBoundGitHub(rootSha, root);
  const candidate = createEvent(baseEvent({
    event_id: "ATTEMPT11-VALID-NEXT",
    idempotency_key: "IDEM-ATTEMPT11-VALID-NEXT",
    sequence: 1,
    generation: 1,
    predecessor_event_id: root.event_id,
    predecessor_commit: rootSha,
  }));
  github.state.commits.set(attemptedSha, { sha: attemptedSha, parent: rootSha, event: candidate });
  github.state.head = attemptedSha;

  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: attemptedSha,
    expectedHead: rootSha,
    history: [root],
    event: candidate,
  });

  assert.equal(result.outcome, "PUBLISHED");
  assert.equal(result.accepted, true);
});

test("REGRESSION attempt12: reconcilePublication fails closed for a null event with verified history", async () => {
  const rootSha = "a".repeat(40);
  const attemptedSha = "b".repeat(40);
  const root = createEvent(baseEvent({
    event_id: "ATTEMPT12-NULL-ROOT",
    idempotency_key: "IDEM-ATTEMPT12-NULL-ROOT",
    sequence: 0,
    generation: 0,
    predecessor_event_id: null,
    predecessor_commit: null,
    transition: "CHECKPOINT_AND_CLOCK_OUT",
    state: "HANDOFF_READY_FOR_BOUNDED_PROOF_SHIFT",
    clock_out_utc: "2026-10-23T09:01:00+00:00",
  }));
  const github = createCommitBoundGitHub(rootSha, root);
  github.state.commits.set(attemptedSha, { sha: attemptedSha, parent: rootSha, event: null });
  github.state.head = attemptedSha;

  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: attemptedSha,
    expectedHead: rootSha,
    history: [root],
    event: null,
  });

  assert.equal(result.outcome, "UNCERTAIN");
  assert.equal(result.accepted, false);
});

test("REGRESSION attempt12: reconcilePublication fails closed for a schema-invalid event with verified history", async () => {
  const rootSha = "a".repeat(40);
  const attemptedSha = "b".repeat(40);
  const root = createEvent(baseEvent({
    event_id: "ATTEMPT12-INVALID-ROOT",
    idempotency_key: "IDEM-ATTEMPT12-INVALID-ROOT",
    sequence: 0,
    generation: 0,
    predecessor_event_id: null,
    predecessor_commit: null,
    transition: "CHECKPOINT_AND_CLOCK_OUT",
    state: "HANDOFF_READY_FOR_BOUNDED_PROOF_SHIFT",
    clock_out_utc: "2026-10-23T09:01:00+00:00",
  }));
  const github = createCommitBoundGitHub(rootSha, root);
  const invalid = { schema_version: -1 };
  github.state.commits.set(attemptedSha, { sha: attemptedSha, parent: rootSha, event: invalid });
  github.state.head = attemptedSha;

  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: attemptedSha,
    expectedHead: rootSha,
    history: [root],
    event: invalid,
  });

  assert.equal(result.outcome, "UNCERTAIN");
  assert.equal(result.accepted, false);
});

test("REGRESSION attempt12: reconcilePublication rejects a genesis root with a non-genesis predecessor commit", async () => {
  const attemptedSha = "b".repeat(40);
  const github = createFakeGitHub();
  const candidate = createEvent(baseEvent({
    event_id: "ATTEMPT12-BAD-GENESIS",
    idempotency_key: "IDEM-ATTEMPT12-BAD-GENESIS",
    predecessor_event_id: null,
    predecessor_commit: "c".repeat(40),
  }));
  github.state.commits.set(attemptedSha, { sha: attemptedSha, parent: SEED, event: candidate });
  github.state.head = attemptedSha;

  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: attemptedSha,
    expectedHead: SEED,
    event: candidate,
  });

  assert.notEqual(result.outcome, "PUBLISHED");
  assert.equal(result.accepted, false);
});

test("REGRESSION attempt12: publishEvent rejects a root with a non-genesis predecessor commit", async () => {
  const github = createFakeGitHub();
  const candidate = baseEvent({
    event_id: "ATTEMPT12-PUBLISH-BAD-GENESIS",
    idempotency_key: "IDEM-ATTEMPT12-PUBLISH-BAD-GENESIS",
    predecessor_event_id: null,
    predecessor_commit: "c".repeat(40),
  });

  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: SEED,
    event: candidate,
  });

  assert.equal(result.published, false);
  assert.equal(result.outcome, "INVALID_HISTORY");
  assert.equal(github.state.head, SEED);
  assert.equal(github.state.updates.length, 0);
});

test("REGRESSION attempt13: publishEvent rejects a successor of a committed root with malformed predecessor commit", async () => {
  const rootSha = "a".repeat(40);
  const root = createEvent(baseEvent({
    event_id: "ATTEMPT13-BAD-COMMITTED-ROOT",
    idempotency_key: "IDEM-ATTEMPT13-BAD-COMMITTED-ROOT",
    sequence: 0,
    generation: 0,
    predecessor_event_id: null,
    predecessor_commit: "c".repeat(40),
    transition: "CHECKPOINT_AND_CLOCK_OUT",
    state: "HANDOFF_READY_FOR_BOUNDED_PROOF_SHIFT",
    clock_out_utc: "2026-10-23T09:01:00+00:00",
  }));
  const github = createCommitBoundGitHub(rootSha, root);
  const successor = baseEvent({
    event_id: "ATTEMPT13-PUBLISH-SUCCESSOR",
    idempotency_key: "IDEM-ATTEMPT13-PUBLISH-SUCCESSOR",
    sequence: 1,
    generation: 1,
    predecessor_event_id: root.event_id,
    predecessor_commit: rootSha,
  });

  const result = await publishEvent({
    github,
    ref: "refs/heads/proof",
    expectedHead: rootSha,
    history: [root],
    event: successor,
  });

  assert.equal(result.published, false);
  assert.equal(result.outcome, "INVALID_HISTORY");
  assert.equal(github.state.head, rootSha);
  assert.equal(github.state.updates.length, 0);
});

test("REGRESSION attempt13: reconcilePublication rejects a successor of a committed root with malformed predecessor commit", async () => {
  const rootSha = "a".repeat(40);
  const attemptedSha = "b".repeat(40);
  const root = createEvent(baseEvent({
    event_id: "ATTEMPT13-BAD-RECONCILE-ROOT",
    idempotency_key: "IDEM-ATTEMPT13-BAD-RECONCILE-ROOT",
    sequence: 0,
    generation: 0,
    predecessor_event_id: null,
    predecessor_commit: "c".repeat(40),
    transition: "CHECKPOINT_AND_CLOCK_OUT",
    state: "HANDOFF_READY_FOR_BOUNDED_PROOF_SHIFT",
    clock_out_utc: "2026-10-23T09:01:00+00:00",
  }));
  const github = createCommitBoundGitHub(rootSha, root);
  const successor = createEvent(baseEvent({
    event_id: "ATTEMPT13-RECONCILE-SUCCESSOR",
    idempotency_key: "IDEM-ATTEMPT13-RECONCILE-SUCCESSOR",
    sequence: 1,
    generation: 1,
    predecessor_event_id: root.event_id,
    predecessor_commit: rootSha,
  }));
  github.state.commits.set(attemptedSha, { sha: attemptedSha, parent: rootSha, event: successor });
  github.state.head = attemptedSha;

  const result = await reconcilePublication({
    github,
    ref: "refs/heads/proof",
    attemptedCommitSha: attemptedSha,
    expectedHead: rootSha,
    history: [root],
    event: successor,
  });

  assert.notEqual(result.outcome, "PUBLISHED");
  assert.equal(result.accepted, false);
});
