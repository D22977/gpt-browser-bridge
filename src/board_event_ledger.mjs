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
  const quarantinedEventIds = [];

  for (const list of byWorkOrder.values()) {
    const seenKeys = new Set();
    for (const event of list) {
      if (seenKeys.has(event.idempotency_key)) {
        duplicateIdempotencyEventIds.push(event.event_id);
      }
      seenKeys.add(event.idempotency_key);
    }

    const children = new Map();
    for (const event of list) {
      const key = event.predecessor_event_id ?? "__root__";
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(event);
    }

    const roots = list.filter((event) => event.predecessor_event_id === null);
    const valid = new Set();
    let current = null;
    if (roots.length > 0) {
      current = roots[0];
      valid.add(current.event_id);
      const pathKeys = new Set([current.idempotency_key]);
      while (true) {
        const kids = children.get(current.event_id) ?? [];
        const candidates = kids.filter(
          (kid) =>
            !pathKeys.has(kid.idempotency_key) &&
            kid.sequence > current.sequence &&
            kid.generation >= current.generation
        );
        if (candidates.length === 0) break;
        const next = candidates[0];
        valid.add(next.event_id);
        pathKeys.add(next.idempotency_key);
        current = next;
      }
    }

    const head = current;
    if (head) active.push(head);
    for (const event of list) {
      if (event.event_id !== head?.event_id) {
        fencedEventIds.push(event.event_id);
      }
      if (!valid.has(event.event_id)) {
        quarantinedEventIds.push(event.event_id);
      }
    }
  }

  return {
    active,
    fenced_event_ids: fencedEventIds.sort(),
    duplicate_idempotency_event_ids: duplicateIdempotencyEventIds.sort(),
    quarantined_event_ids: quarantinedEventIds.sort(),
    invalid_event_ids: quarantinedEventIds.sort(),
    rejected_event_ids: quarantinedEventIds.sort(),
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
  if (next?.predecessor_commit == null) {
    throw new Error("buildHandoffEvent: predecessor_commit is required");
  }
  if (!commitSha.safeParse(next.predecessor_commit).success) {
    throw new Error("buildHandoffEvent: predecessor_commit must be a 40-hex commit sha");
  }
  const prior = boardEventSchema.parse(priorInput);
  return boardEventSchema.parse({
    ...prior,
    generation: next.generation ?? prior.generation + 1,
    sequence: next.sequence ?? prior.sequence + 1,
    event_id: next.event_id,
    attempt_id: next.attempt_id,
    idempotency_key: next.idempotency_key,
    predecessor_event_id: prior.event_id,
    predecessor_commit: next.predecessor_commit,
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

function resolveCanonicalPrior(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const workOrders = new Set(history.map((item) => boardEventSchema.parse(item).work_order_id));
  if (workOrders.size !== 1) return null;
  const projection = projectEvents(history);
  return projection.active[0] ?? null;
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

  const canonicalPrior =
    Array.isArray(history) && history.length > 0 ? resolveCanonicalPrior(history) : null;

  if (Array.isArray(history) && history.length > 0) {
    if (!canonicalPrior) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "history does not contain a valid canonical accepted event",
        next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
      };
    }
    if (expectedHead === null || expectedHead === undefined) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "canonical history requires a bound head commit",
        next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
      };
    }
    const priorLease = classifyLease(canonicalPrior, candidate.clock_in_utc);
    if (priorLease.state === "ACTIVE" && !candidate.fenced_event_ids.includes(canonicalPrior.event_id)) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "prior shift is still active and has not been fenced or expired",
        next_legal_action: "WAIT_FOR_LEASE_EXPIRY_OR_HANDOFF",
      };
    }
    if (candidate.work_order_id !== canonicalPrior.work_order_id) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "work order mismatch against canonical history",
        next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
      };
    }
    if (candidate.predecessor_event_id !== canonicalPrior.event_id) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "predecessor_event_id is not bound to the canonical accepted event",
        next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
      };
    }
    if (candidate.predecessor_commit !== expectedHead) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "predecessor_commit is not bound to the canonical accepted head",
        next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
      };
    }
    if (candidate.sequence <= canonicalPrior.sequence) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "sequence must advance beyond the canonical accepted event",
        next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
      };
    }
    if (candidate.generation <= canonicalPrior.generation) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "generation must advance beyond the canonical accepted event",
        next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
      };
    }
  } else if (candidate.predecessor_event_id !== null) {
    return {
      outcome: "INVALID_HISTORY",
      published: false,
      accepted: false,
      status: "INVALID_HISTORY",
      reason: "INVALID_HISTORY",
      error: "omitted history cannot publish a successor event",
      next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
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
      if (conflict.kind === "IDEMPOTENCY_CONFLICT") {
        return {
          outcome: "IDEMPOTENCY_CONFLICT",
          accepted: false,
          head,
          existing_event_id: conflict.existing.event_id,
          existing_idempotency_key: conflict.existing.idempotency_key,
          next_legal_action: "FAIL_CLOSED_USE_CANONICAL_EVENT",
        };
      }
      return {
        outcome: "DUPLICATE",
        accepted: true,
        head,
        existing_event_id: conflict.existing.event_id,
        existing_idempotency_key: conflict.existing.idempotency_key,
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
