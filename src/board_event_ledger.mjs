import { createHash } from "node:crypto";
import { z } from "zod";

export const BOARD_EVENT_SCHEMA_VERSION = 1;

export const boardRoleEnum = z.enum([
  "Control",
  "Worker",
  "Reviewer",
  "Browser Action Runner",
  "Watcher",
  "Supervisor",
]);

const timestamp = z.string().datetime({ offset: true });
const commitSha = z.string().regex(/^[0-9a-f]{40}$/);

export const boardEventSchema = z.object({
  schema_version: z.literal(BOARD_EVENT_SCHEMA_VERSION),
  work_order_id: z.string().min(1),
  event_id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  predecessor_event_id: z.string().min(1).nullable().default(null),
  predecessor_commit: commitSha.nullable().default(null),
  attempt_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  role: boardRoleEnum,
  transition: z.string().min(1),
  state: z.string().min(1),
  authority: z.string().min(1),
  scope: z.string().min(1),
  checkpoint: z.string().min(1),
  clock_in_utc: timestamp,
  checkpoint_utc: timestamp.nullable().default(null),
  rest_until_utc: timestamp.nullable().default(null),
  handoff_utc: timestamp.nullable().default(null),
  clock_out_utc: timestamp.nullable().default(null),
  lease_expires_utc: timestamp.nullable().default(null),
  result: z.string().nullable().default(null),
  evidence: z.array(z.string()).default([]),
  next_legal_action: z.string().min(1),
  fenced_event_ids: z.array(z.string()).default([]),
  superseded_by_event_id: z.string().min(1).nullable().default(null),
  executor_identity: z.string().min(1).optional(),
});

const EVENT_FIELD_ORDER = [
  "schema_version",
  "work_order_id",
  "event_id",
  "sequence",
  "generation",
  "predecessor_event_id",
  "predecessor_commit",
  "attempt_id",
  "idempotency_key",
  "role",
  "transition",
  "state",
  "authority",
  "scope",
  "checkpoint",
  "clock_in_utc",
  "checkpoint_utc",
  "rest_until_utc",
  "handoff_utc",
  "clock_out_utc",
  "lease_expires_utc",
  "result",
  "evidence",
  "next_legal_action",
  "fenced_event_ids",
  "superseded_by_event_id",
  "executor_identity",
];

export function createEvent(input) {
  return boardEventSchema.parse(input);
}

export function canonicalEvent(input) {
  const event = boardEventSchema.parse(input);
  const ordered = {};
  for (const key of EVENT_FIELD_ORDER) {
    if (Object.prototype.hasOwnProperty.call(event, key)) {
      ordered[key] = event[key];
    }
  }
  return ordered;
}

export function serializeEvent(input) {
  return JSON.stringify(canonicalEvent(input));
}

export function eventDigest(input) {
  return createHash("sha256").update(serializeEvent(input), "utf8").digest("hex");
}

export function findIdempotencyConflict(history, candidate) {
  const next = canonicalEvent(candidate);
  for (const priorInput of history) {
    const prior = canonicalEvent(priorInput);
    if (prior.idempotency_key !== next.idempotency_key && prior.event_id !== next.event_id) {
      continue;
    }
    const kind = eventDigest(prior) === eventDigest(next) ? "DUPLICATE" : "IDEMPOTENCY_CONFLICT";
    return { kind, existing: prior };
  }
  return null;
}

export function projectEvents(events) {
  const byWorkOrder = new Map();
  for (const input of events) {
    const event = boardEventSchema.parse(input);
    const list = byWorkOrder.get(event.work_order_id) ?? [];
    list.push(event);
    byWorkOrder.set(event.work_order_id, list);
  }

  const active = [];
  const fencedEventIds = [];
  const duplicateIdempotencyEventIds = [];

  for (const list of byWorkOrder.values()) {
    const sorted = [...list].sort(
      (a, b) =>
        a.generation - b.generation ||
        a.sequence - b.sequence ||
        a.event_id.localeCompare(b.event_id)
    );
    const seenKeys = new Set();
    for (const event of sorted) {
      if (seenKeys.has(event.idempotency_key)) {
        duplicateIdempotencyEventIds.push(event.event_id);
      }
      seenKeys.add(event.idempotency_key);
    }
    const head = sorted.at(-1) ?? null;
    active.push(head);
    for (const event of sorted.slice(0, -1)) {
      fencedEventIds.push(event.event_id);
    }
  }

  return {
    active,
    fenced_event_ids: fencedEventIds.sort(),
    duplicate_idempotency_event_ids: duplicateIdempotencyEventIds.sort(),
  };
}

export function fenceOlderEvents(acceptedInput, priorInputs) {
  const accepted = boardEventSchema.parse(acceptedInput);
  const fenced = new Set(accepted.fenced_event_ids);
  for (const input of priorInputs) {
    const prior = boardEventSchema.parse(input);
    if (prior.work_order_id !== accepted.work_order_id) continue;
    if (prior.event_id === accepted.event_id) continue;
    if (prior.generation < accepted.generation || prior.sequence < accepted.sequence) {
      fenced.add(prior.event_id);
    }
  }
  return [...fenced].sort();
}

export function classifyLease(input, atUtc) {
  const event = boardEventSchema.parse(input);
  const at = Date.parse(atUtc);
  if (!Number.isFinite(at)) {
    throw new Error(`classifyLease: invalid timestamp ${JSON.stringify(atUtc)}`);
  }
  if (event.clock_out_utc) {
    return { state: "CLOCKED_OUT", active: false, clock_out_utc: event.clock_out_utc };
  }
  if (event.handoff_utc) {
    return { state: "HANDED_OFF", active: false, handoff_utc: event.handoff_utc };
  }
  if (!event.lease_expires_utc) {
    return { state: "NO_LEASE", active: false };
  }
  if (at >= Date.parse(event.lease_expires_utc)) {
    return {
      state: "EXPIRED",
      active: false,
      lease_expires_utc: event.lease_expires_utc,
      next_legal_action: "READ_CANONICAL_AND_TAKE_HANDOFF",
    };
  }
  return { state: "ACTIVE", active: true, lease_expires_utc: event.lease_expires_utc };
}

export function buildHandoffEvent(priorInput, next = {}) {
  const prior = boardEventSchema.parse(priorInput);
  return boardEventSchema.parse({
    ...prior,
    generation: next.generation ?? prior.generation + 1,
    sequence: next.sequence ?? prior.sequence + 1,
    event_id: next.event_id,
    attempt_id: next.attempt_id,
    idempotency_key: next.idempotency_key,
    predecessor_event_id: prior.event_id,
    predecessor_commit: next.predecessor_commit ?? prior.predecessor_commit,
    transition: next.transition ?? "HANDOFF",
    state: next.state ?? "HANDOFF_READY",
    checkpoint: prior.checkpoint,
    clock_in_utc: next.clock_in_utc ?? prior.clock_in_utc,
    handoff_utc: next.handoff_utc ?? null,
    clock_out_utc: next.clock_out_utc ?? null,
    lease_expires_utc: next.lease_expires_utc ?? null,
    result: next.result ?? null,
    evidence: next.evidence ?? [],
    next_legal_action: next.next_legal_action ?? prior.next_legal_action,
  });
}

export function reconcileProjection({ canonical, projection }) {
  if (!canonical || typeof canonical.head !== "string" || canonical.head.length === 0) {
    throw new Error("reconcileProjection: canonical.head is required");
  }
  const canonicalGeneration = canonical.generation ?? 0;
  const observedHead = projection?.head ?? null;
  const observedGeneration = projection?.generation ?? -1;

  if (observedHead === null) {
    return {
      state: "MISSING_PROJECTION",
      can_authorize: false,
      canonical_head: canonical.head,
      observed_projection_head: null,
      next_legal_action: "READ_CANONICAL_LEDGER",
    };
  }
  if (observedHead === canonical.head) {
    return {
      state: "CURRENT",
      can_authorize: true,
      canonical_head: canonical.head,
      observed_projection_head: observedHead,
      next_legal_action: canonical.next_legal_action ?? "CONTINUE_FROM_CANONICAL_HEAD",
    };
  }
  if (observedGeneration < canonicalGeneration) {
    return {
      state: "LAGGING",
      can_authorize: false,
      canonical_head: canonical.head,
      observed_projection_head: observedHead,
      next_legal_action: "READ_CANONICAL_LEDGER_BEFORE_ANY_STALE_WORK",
    };
  }
  if (observedGeneration > canonicalGeneration) {
    return {
      state: "DIVERGED",
      can_authorize: false,
      canonical_head: canonical.head,
      observed_projection_head: observedHead,
      next_legal_action: "BLOCKED_PROJECTION_AHEAD_OF_CANONICAL",
    };
  }
  return {
    state: "FORKED",
    can_authorize: false,
    canonical_head: canonical.head,
    observed_projection_head: observedHead,
    next_legal_action: "BLOCKED_PROJECTION_FORKED_AT_SAME_GENERATION",
  };
}

function requireGithub(github) {
  if (
    !github ||
    typeof github.readRef !== "function" ||
    typeof github.createCommit !== "function" ||
    typeof github.updateRef !== "function"
  ) {
    throw new Error("github adapter must provide readRef, createCommit and updateRef");
  }
}

async function readHead(github, ref) {
  const observed = await github.readRef(ref);
  return observed?.sha ?? null;
}

function isStaleRejection(error) {
  if (!error) return false;
  if (error.code === "STALE_HEAD") return true;
  if (error.status === 409) return true;
  if (error.status === 422 && /fast.?forward|stale|conflict/i.test(String(error.message ?? ""))) {
    return true;
  }
  return /fast.?forward|stale head/i.test(String(error.message ?? ""));
}

export async function publishEvent({ github, ref, expectedHead = null, event, history = [] }) {
  requireGithub(github);
  const candidate = boardEventSchema.parse(event);
  const conflict = findIdempotencyConflict(history, candidate);
  if (conflict) {
    return {
      outcome: conflict.kind,
      published: false,
      existing_event_id: conflict.existing.event_id,
      existing_idempotency_key: conflict.existing.idempotency_key,
      next_legal_action: "USE_EXISTING_ACCEPTED_EVENT",
    };
  }

  const observedHead = await readHead(github, ref);
  if (observedHead !== expectedHead) {
    return {
      outcome: "STALE_HEAD",
      published: false,
      expected_head: expectedHead,
      observed_head: observedHead,
      candidate_event_id: candidate.event_id,
      next_legal_action: "REREAD_CANONICAL_HEAD_AND_REBASE_NO_BLIND_RETRY",
    };
  }

  let commit;
  try {
    commit = await github.createCommit({
      parent: expectedHead,
      message: `board-event ${candidate.work_order_id} ${candidate.event_id}`,
      event: candidate,
    });
  } catch (error) {
    return {
      outcome: "PUBLICATION_UNCERTAIN",
      published: false,
      attempted_commit_sha: null,
      error: String(error?.message ?? error),
      next_legal_action: "READ_REF_BEFORE_ANY_RETRY",
    };
  }

  const commitSha = commit?.sha ?? null;
  if (typeof commitSha !== "string" || !/^[0-9a-f]{40}$/.test(commitSha)) {
    return {
      outcome: "PUBLICATION_UNCERTAIN",
      published: false,
      attempted_commit_sha: null,
      error: "createCommit did not return a 40-hex sha",
      next_legal_action: "READ_REF_BEFORE_ANY_RETRY",
    };
  }

  try {
    const updated = await github.updateRef({
      ref,
      sha: commitSha,
      expectedSha: expectedHead,
      force: false,
    });
    return {
      outcome: "ACCEPTED",
      published: true,
      commit_sha: commitSha,
      head: updated?.sha ?? commitSha,
      event: candidate,
    };
  } catch (error) {
    if (isStaleRejection(error)) {
      const rereadHead = await readHead(github, ref);
      return {
        outcome: "STALE_HEAD",
        published: false,
        expected_head: expectedHead,
        observed_head: rereadHead,
        attempted_commit_sha: commitSha,
        cause: String(error?.message ?? error),
        next_legal_action: "REREAD_CANONICAL_HEAD_AND_REBASE_NO_BLIND_RETRY",
      };
    }
    return {
      outcome: "PUBLICATION_UNCERTAIN",
      published: false,
      attempted_commit_sha: commitSha,
      error: String(error?.message ?? error),
      next_legal_action: "READ_REF_AND_RECONCILE_BEFORE_ANY_RETRY",
    };
  }
}

export async function reconcilePublication({
  github,
  ref,
  attemptedCommitSha,
  expectedHead = null,
  history = [],
  event = null,
}) {
  requireGithub(github);
  const head = await readHead(github, ref);

  if (event && history.length > 0) {
    const conflict = findIdempotencyConflict(history, event);
    if (conflict) {
      return {
        outcome: "DUPLICATE",
        accepted: true,
        head,
        existing_event_id: conflict.existing.event_id,
        next_legal_action: "USE_EXISTING_ACCEPTED_EVENT",
      };
    }
  }

  if (head !== null && head === attemptedCommitSha) {
    return {
      outcome: "PUBLISHED",
      accepted: true,
      head,
      attempted_commit_sha: attemptedCommitSha,
      next_legal_action: "CONTINUE_FROM_PUBLISHED_EVENT",
    };
  }
  if (head === expectedHead) {
    return {
      outcome: "NOT_PUBLISHED",
      accepted: false,
      head,
      attempted_commit_sha: attemptedCommitSha,
      next_legal_action: "REPUBLISH_FROM_REREAD_HEAD_ONLY_AFTER_NEW_PREDECESSOR",
    };
  }
  return {
    outcome: "UNCERTAIN",
    accepted: false,
    head,
    attempted_commit_sha: attemptedCommitSha,
    next_legal_action: "REREAD_CANONICAL_LEDGER_NO_BLIND_RETRY",
  };
}
