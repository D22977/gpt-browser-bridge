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

const ZERO_SHA = "0".repeat(40);

function isGenesisHead(sha) {
  return sha === null || sha === undefined || (typeof sha === "string" && /^0{40}$/.test(sha));
}

function parseMaybeEvent(value) {
  if (value === null || value === undefined) return null;
  const candidates = [
    value,
    value?.event,
    value?.commit?.event,
    value?.data?.event,
    value?.result?.event,
    value?.payload?.event,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      try {
        return boardEventSchema.parse(candidate);
      } catch {
        // continue
      }
    }
  }
  return null;
}

async function readCommitRaw(github, sha) {
  if (isGenesisHead(sha)) return null;
  const methodNames = [
    "readCommit",
    "getCommit",
    "readCommitEvent",
    "getCommitEvent",
    "readEventCommit",
    "verifyCommit",
    "readCommitContents",
    "commitContents",
    "readCommitSha",
  ];
  for (const name of methodNames) {
    if (typeof github?.[name] === "function") {
      try {
        const result = await github[name](sha);
        if (result && typeof result === "object") {
          const reportedSha =
            (typeof result.sha === "string" && result.sha) ||
            (typeof result?.commit?.sha === "string" && result.commit.sha) ||
            null;
          if (reportedSha !== sha) continue;
          return result;
        }
      } catch {
        // try the next adapter method
      }
    }
  }
  return null;
}

async function readCommitEvent(github, sha) {
  if (isGenesisHead(sha)) return null;
  const raw = await readCommitRaw(github, sha);
  if (!raw) return null;
  return parseMaybeEvent(raw);
}

function extractParentSha(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.parent === "string") return raw.parent;
  if (Array.isArray(raw.parents) && raw.parents.length > 0 && typeof raw.parents[0]?.sha === "string") {
    return raw.parents[0].sha;
  }
  if (raw.commit && Array.isArray(raw.commit.parents) && raw.commit.parents.length > 0 && typeof raw.commit.parents[0]?.sha === "string") {
    return raw.commit.parents[0].sha;
  }
  if (typeof raw.parent_sha === "string") return raw.parent_sha;
  if (raw.commit && typeof raw.commit.parent === "string") return raw.commit.parent;
  return null;
}

function resolveCanonicalPrior(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const workOrders = new Set();
  for (const item of history) {
    try {
      workOrders.add(boardEventSchema.parse(item).work_order_id);
    } catch {
      return null;
    }
  }
  if (workOrders.size !== 1) return null;
  const projection = projectEvents(history);
  if (projection.quarantined_event_ids.length > 0) return null;
  if (projection.active.length !== 1) return null;
  return projection.active[0] ?? null;
}

async function verifyHistoryAtHead(github, expectedHead, history) {
  if (isGenesisHead(expectedHead)) {
    if (Array.isArray(history) && history.length === 0) {
      return { ok: true, canonicalPrior: null };
    }
    return { ok: false, canonicalPrior: null };
  }
  const prior = resolveCanonicalPrior(history);
  if (!prior) return { ok: false, canonicalPrior: null };

  const raw = await readCommitRaw(github, expectedHead);
  const commitEvent = raw ? parseMaybeEvent(raw) : null;
  if (!commitEvent) return { ok: false, canonicalPrior: null };
  if (eventDigest(commitEvent) !== eventDigest(prior)) return { ok: false, canonicalPrior: null };

  const parsedHistory = (Array.isArray(history) ? history : [])
    .map((item) => {
      try { return boardEventSchema.parse(item); } catch { return null; }
    })
    .filter(Boolean);

  // Verify the committed ancestry chain, not just the immediate head.
  const visited = new Set();
  let currentSha = expectedHead;
  let currentRaw = raw;
  let currentEvent = prior;
  while (currentEvent.predecessor_event_id !== null) {
    if (visited.has(currentEvent.event_id)) return { ok: false, canonicalPrior: null };
    visited.add(currentEvent.event_id);

    const predecessorEvent = parsedHistory.find((item) => item.event_id === currentEvent.predecessor_event_id);
    if (!predecessorEvent) return { ok: false, canonicalPrior: null };

    const expectedParentSha = currentEvent.predecessor_commit;
    if (isGenesisHead(expectedParentSha)) return { ok: false, canonicalPrior: null };

    const actualParentSha = extractParentSha(currentRaw);
    if (actualParentSha !== expectedParentSha) return { ok: false, canonicalPrior: null };

    const parentRaw = await readCommitRaw(github, expectedParentSha);
    const parentEvent = parentRaw ? parseMaybeEvent(parentRaw) : null;
    if (!parentEvent || eventDigest(parentEvent) !== eventDigest(predecessorEvent)) {
      return { ok: false, canonicalPrior: null };
    }
    const reportedParentSha =
      (typeof parentRaw?.sha === "string" && parentRaw.sha) ||
      (typeof parentRaw?.commit?.sha === "string" && parentRaw.commit.sha) ||
      null;
    if (reportedParentSha && reportedParentSha !== expectedParentSha) {
      return { ok: false, canonicalPrior: null };
    }

    currentSha = expectedParentSha;
    currentRaw = parentRaw;
    currentEvent = predecessorEvent;
  }

  // A root event's commit should not carry a non-genesis parent.
  if (currentEvent.predecessor_event_id === null) {
    const rootParent = extractParentSha(currentRaw);
    if (rootParent && !isGenesisHead(rootParent)) {
      return { ok: false, canonicalPrior: null };
    }
  }

  return { ok: true, canonicalPrior: prior };
}

function resolveTrustedNow(github) {
  if (typeof github?.now === "function") {
    try {
      const value = github.now();
      if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
    } catch {
      // ignore
    }
  }
  if (typeof github?.currentTime === "function") {
    try {
      const value = github.currentTime();
      if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
    } catch {
      // ignore
    }
  }
  return new Date().toISOString();
}

const ALLOWED_ROLE_TRANSITIONS = new Map([
  ["Control", new Map([
    ["AUTHORIZE_BOUNDED_IMPLEMENTATION_AND_PROOF_SHIFT", new Set(["READY_FOR_SINGLE_WORKER_CLAIM"])],
    ["RECONCILE_DISPATCH", new Set(["PROMPT_NOT_CONSUMED_PRE_SEND_FAILURE"])],
    ["FENCE_STALLED_WORKER_SHIFT_AND_CHECKPOINT", new Set(["HANDOFF_READY_TDD_RESET_REQUIRED"])],
    ["AUTHORIZE_FRESH_BOUNDED_WORKER_SHIFT", new Set(["READY_FOR_SINGLE_WORKER_CLAIM"])],
    ["FENCE_PAUSED_WORKER_AND_RECONCILE_PARTIAL_PROOF", new Set(["HANDOFF_READY_AFTER_FIRST_REF_ADVANCE"])],
    ["AUTHORIZE_SUCCESSOR_SHIFT_FROM_PARTIAL_CAS_CHECKPOINT", new Set(["READY_FOR_SINGLE_WORKER_CLAIM"])],
    ["AUTHORIZE_BOUNDED_REWORK", new Set(["READY_FOR_SINGLE_WORKER_CLAIM"])],
  ])],
  ["Worker", new Map([
    ["CLAIM_REQUESTED_AND_CLOCK_IN", new Set(["READ_ONLY_SOURCE_INSPECTION"])],
    ["CHECKPOINT_AND_CLOCK_OUT", new Set(["HANDOFF_READY_FOR_BOUNDED_PROOF_SHIFT"])],
    ["CLAIM_AND_CLOCK_IN", new Set(["ACTIVE", "IMPLEMENTATION_AND_LIVE_CAS_PROOF"])],
    ["CLOCK_OUT_AND_HANDOFF", new Set(["READY_FOR_FRESH_REVIEW"])],
    ["CLAIM", new Set(["IN_PROGRESS"])],
    ["COMPLETE_REWORK", new Set(["READY_FOR_FRESH_REVIEW"])],
    ["HANDOFF", new Set(["HANDOFF_READY"])],
  ])],
  ["Reviewer", new Map([
    ["REVIEW_COMPLETE", new Set(["FIX_REQUIRED"])],
  ])],
]);

function isAllowedRoleTransition(event) {
  return ALLOWED_ROLE_TRANSITIONS.get(event.role)?.get(event.transition)?.has(event.state) ?? false;
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
    const quarantined = new Set();

    for (const event of list) {
      if (!isAllowedRoleTransition(event)) quarantined.add(event.event_id);
    }

    // duplicate event ids with changed payload
    const byEventId = new Map();
    const duplicateEventIdValues = new Set();
    for (const event of list) {
      const existing = byEventId.get(event.event_id);
      if (existing && eventDigest(existing) !== eventDigest(event)) {
        duplicateEventIdValues.add(event.event_id);
      }
      if (!existing) byEventId.set(event.event_id, event);
    }
    for (const event of list) {
      if (duplicateEventIdValues.has(event.event_id)) quarantined.add(event.event_id);
    }

    // Every event sharing an idempotency key is corrupt, regardless of input order.
    const byIdempotencyKey = new Map();
    for (const event of list) {
      const group = byIdempotencyKey.get(event.idempotency_key) ?? [];
      group.push(event);
      byIdempotencyKey.set(event.idempotency_key, group);
    }
    for (const group of byIdempotencyKey.values()) {
      if (group.length > 1) {
        for (const event of group) {
          duplicateIdempotencyEventIds.push(event.event_id);
          quarantined.add(event.event_id);
        }
      }
    }

    // build children map deterministically (sorted)
    const children = new Map();
    for (const event of [...list].sort((a, b) => a.event_id.localeCompare(b.event_id))) {
      const key = event.predecessor_event_id ?? "__root__";
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(event);
    }

    const roots = list
      .filter((event) => event.predecessor_event_id === null)
      .sort((a, b) => a.event_id.localeCompare(b.event_id));

    const viableRoots = roots.filter((root) => !quarantined.has(root.event_id));

    let head = null;
    const valid = new Set();

    if (viableRoots.length !== 1) {
      for (const event of list) quarantined.add(event.event_id);
    } else {
      const root = viableRoots[0];
      valid.add(root.event_id);
      let current = root;
      let stop = false;
      while (!stop) {
        const kids = (children.get(current.event_id) ?? [])
          .filter((kid) => !quarantined.has(kid.event_id))
          .sort((a, b) => a.event_id.localeCompare(b.event_id));
        const validKids = kids.filter(
          (kid) =>
            kid.sequence === current.sequence + 1 &&
            kid.generation >= current.generation &&
            kid.generation <= current.generation + 1
        );
        if (validKids.length === 0) break;
        if (validKids.length > 1) {
          // fork: quarantine all competing children, stop chain
          for (const kid of validKids) quarantined.add(kid.event_id);
          head = current;
          stop = true;
          break;
        }
        const next = validKids[0];
        valid.add(next.event_id);
        current = next;
      }
      if (!stop) {
        head = current;
      }
      if (head) active.push(head);
    }

    for (const event of list) {
      if (!head || event.event_id !== head.event_id) {
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

export async function buildHandoffEvent(priorInput, next = {}, provenance = {}) {
  if (next?.predecessor_commit == null) {
    throw new Error("buildHandoffEvent: predecessor_commit is required");
  }
  if (!commitSha.safeParse(next.predecessor_commit).success) {
    throw new Error("buildHandoffEvent: predecessor_commit must be a 40-hex commit sha");
  }

  const prior = boardEventSchema.parse(priorInput);

  const github = provenance?.github;
  const ref = provenance?.ref;
  const expectedHead = provenance?.expectedHead;
  const history = provenance?.history;
  if (!github || typeof github.readRef !== "function" || typeof github.readCommit !== "function" || typeof ref !== "string") {
    throw new Error("buildHandoffEvent: verified canonical ref provenance is required");
  }
  if (expectedHead !== next.predecessor_commit || await readHead(github, ref) !== expectedHead) {
    throw new Error("buildHandoffEvent: predecessor_commit must match the canonical ref head");
  }
  const verified = await verifyHistoryAtHead(github, expectedHead, history);
  if (!verified.ok || !verified.canonicalPrior || eventDigest(verified.canonicalPrior) !== eventDigest(prior)) {
    throw new Error("buildHandoffEvent: supplied history is not the verified canonical accepted chain");
  }

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
    typeof github.updateRef !== "function" ||
    typeof github.readCommit !== "function"
  ) {
    throw new Error("github adapter must provide readRef, createCommit and updateRef (readCommit required for committed ancestry)");
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

export async function publishEvent({ github, ref, expectedHead = null, event, history = [], ...options }) {
  requireGithub(github);
  const candidate = boardEventSchema.parse(event);
  const trustedNow = resolveTrustedNow(github);

  const normalizedHistory = Array.isArray(history) ? history : [];

  if (normalizedHistory.length > 0) {
    let canonicalPrior = null;
    if (isGenesisHead(expectedHead)) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "nonempty history cannot be verified at the genesis head",
        next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
      };
    } else {
      const verification = await verifyHistoryAtHead(github, expectedHead, normalizedHistory);
      if (!verification.ok) {
        return {
          outcome: "INVALID_HISTORY",
          published: false,
          accepted: false,
          status: "INVALID_HISTORY",
          reason: "INVALID_HISTORY",
          error: "history does not match the verified event chain at the observed ref head",
          next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
        };
      }
      canonicalPrior = verification.canonicalPrior;
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
    const verifiedHistoryConflict = findIdempotencyConflict(normalizedHistory, candidate);
    if (verifiedHistoryConflict) {
      return {
        outcome: verifiedHistoryConflict.kind,
        published: false,
        existing_event_id: verifiedHistoryConflict.existing.event_id,
        existing_idempotency_key: verifiedHistoryConflict.existing.idempotency_key,
        next_legal_action: "USE_EXISTING_ACCEPTED_EVENT",
      };
    }
    if (Array.isArray(candidate.fenced_event_ids) && candidate.fenced_event_ids.includes(canonicalPrior.event_id)) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "candidate cannot fence the canonical predecessor",
        next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
      };
    }
    const priorLease = classifyLease(canonicalPrior, trustedNow);
    if (priorLease.state === "ACTIVE") {
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
    if (candidate.sequence !== canonicalPrior.sequence + 1) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "sequence must advance exactly once from the canonical accepted event",
        next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
      };
    }
    if (candidate.generation < canonicalPrior.generation || candidate.generation > canonicalPrior.generation + 1) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "generation may stay level or advance by one from the canonical accepted event",
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
  } else {
    // omitted history and root event: reject if ref already exists
    const observedHead = await readHead(github, ref);
    if (!isGenesisHead(observedHead)) {
      return {
        outcome: "INVALID_HISTORY",
        published: false,
        accepted: false,
        status: "INVALID_HISTORY",
        reason: "INVALID_HISTORY",
        error: "omitted history cannot publish a root event when the ref already exists",
        next_legal_action: "REREAD_CANONICAL_LEDGER_AND_REBASE",
      };
    }
  }

  if (!isAllowedRoleTransition(candidate)) {
    return {
      outcome: "INVALID_HISTORY",
      published: false,
      accepted: false,
      status: "INVALID_HISTORY",
      reason: "INVALID_HISTORY",
      error: "role, transition and state combination is not allowed",
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

  const commitShaValue = commit?.sha ?? null;
  if (typeof commitShaValue !== "string" || !/^[0-9a-f]{40}$/.test(commitShaValue)) {
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
      sha: commitShaValue,
      expectedSha: expectedHead,
      force: false,
    });
    return {
      outcome: "ACCEPTED",
      published: true,
      commit_sha: commitShaValue,
      head: updated?.sha ?? commitShaValue,
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
        attempted_commit_sha: commitShaValue,
        cause: String(error?.message ?? error),
        next_legal_action: "REREAD_CANONICAL_HEAD_AND_REBASE_NO_BLIND_RETRY",
      };
    }
    return {
      outcome: "PUBLICATION_UNCERTAIN",
      published: false,
      attempted_commit_sha: commitShaValue,
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
  ...options
}) {
  requireGithub(github);
  const originalHistory = Array.isArray(history) ? history : [];
  let normalizedHistory = [...originalHistory];
  let historyVerified = originalHistory.length === 0;
  let canonicalPrior = null;

  if (originalHistory.length > 0 && expectedHead !== null && expectedHead !== undefined) {
    const verification = await verifyHistoryAtHead(github, expectedHead, normalizedHistory);
    if (verification.ok) {
      historyVerified = true;
      canonicalPrior = verification.canonicalPrior;
    } else {
      normalizedHistory = [];
      historyVerified = false;
    }
  } else if (originalHistory.length > 0) {
    historyVerified = false;
  }

  const head = await readHead(github, ref);

  if (originalHistory.length > 0 && !historyVerified) {
    return {
      outcome: "UNCERTAIN",
      accepted: false,
      head,
      attempted_commit_sha: attemptedCommitSha,
      next_legal_action: "REREAD_CANONICAL_LEDGER_NO_BLIND_RETRY",
    };
  }

  if (event) {
    const candidate = (() => {
      try {
        return boardEventSchema.parse(event);
      } catch {
        return null;
      }
    })();
    if (candidate) {
      if (normalizedHistory.length > 0) {
        const conflict = findIdempotencyConflict(normalizedHistory, candidate);
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

    }
  }

  if (head !== null && head === attemptedCommitSha) {
    const candidate = (() => {
      try { return event ? boardEventSchema.parse(event) : null; } catch { return null; }
    })();
    const attemptedRaw = await readCommitRaw(github, attemptedCommitSha);
    const attemptedEvent = attemptedRaw ? parseMaybeEvent(attemptedRaw) : null;
    const actualParent = extractParentSha(attemptedRaw);
    const parentMatches = isGenesisHead(expectedHead)
      ? isGenesisHead(actualParent)
      : actualParent === expectedHead;
    const validGenesisRoot = isGenesisHead(expectedHead) && candidate?.predecessor_event_id === null;
    const validSuccessor = Boolean(
      !isGenesisHead(expectedHead) &&
      originalHistory.length > 0 &&
      historyVerified &&
      canonicalPrior &&
      isAllowedRoleTransition(candidate) &&
      candidate.work_order_id === canonicalPrior.work_order_id &&
      candidate.predecessor_event_id === canonicalPrior.event_id &&
      candidate.predecessor_commit === expectedHead &&
      candidate.sequence === canonicalPrior.sequence + 1 &&
      candidate.generation >= canonicalPrior.generation &&
      candidate.generation <= canonicalPrior.generation + 1 &&
      !(candidate.fenced_event_ids ?? []).includes(canonicalPrior.event_id) &&
      classifyLease(canonicalPrior, resolveTrustedNow(github)).state !== "ACTIVE"
    );
    if (
      candidate &&
      attemptedEvent &&
      eventDigest(attemptedEvent) === eventDigest(candidate) &&
      parentMatches &&
      isAllowedRoleTransition(candidate) &&
      (validGenesisRoot || validSuccessor)
    ) {
      return {
        outcome: "PUBLISHED",
        accepted: true,
        head,
        attempted_commit_sha: attemptedCommitSha,
        next_legal_action: "CONTINUE_FROM_PUBLISHED_EVENT",
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
