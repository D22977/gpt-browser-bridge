# GPT Browser Bridge — architecture orientation

This document explains the boundaries visible in the repository. It is not a
live registry, runtime checkpoint, or competing source of truth. Current
decisions and status come from GitHub Control cards, exact refs/heads/trees/
blobs, and read-back receipts; see [Issue #162](https://github.com/D22977/gpt-browser-bridge/issues/162)
for the current resident/restartable restoration authority.

## 1. Responsibilities

```text
GitHub durable Control authority
        │ exact card / generation / head / tree / target / receipt
        ▼
Resident/restartable local transport and Herdr delivery consumer
        │ read authority again before each bounded action
        ▼
Deterministic Supervisor
        ├─ heartbeat, lock, checkpoint, and bounded recovery
        ├─ local continuity and terminal health
        └─ delivery result and morning-summary records
        ▼
Role-specific execution
        ├─ Control Tower — decides and accepts
        ├─ Worker — edits only allow-listed paths
        ├─ Reviewer — fresh, independent, read-only verdict
        ├─ Sender — browser writes only
        └─ Watcher — browser reads only
```

The Supervisor transports and recovers durable work; it does not decide whether
work passes, adopt a candidate, or resend an uncertain browser action. A
resident consumer is the intended normal unattended path for Issue #162. A
one-shot workflow can be a bounded transport, bootstrap, diagnostic, or
historical record, but its presence does not make it the normal loop.

## 2. Durable versus local state

GitHub is the semantic authority for current work: cards, comments, review and
terminal receipts, exact refs, and exact content identities. The local runtime
tree is transport/continuity state only. Typical local state includes locks,
heartbeats, jobs, checkpoints, recovery records, logs, and idempotency state;
its exact path is an environment binding and must be verified from the current
card rather than copied from this document.

## 3. Repository boundaries

| Area | Responsibility | Mutation rule |
| --- | --- | --- |
| `src/` | deterministic contracts, adapters, Supervisor, Sender, Watcher, and resident delivery | only with an exact Worker card |
| `scripts/` | Windows lifecycle/resume entrypoints | only with an exact Worker card |
| `tests/` | executable regression and negative-path coverage | change with the behavior card, never to hide a failure |
| `skills/` | role contracts and operational instructions | separate exact skill-change authority |
| `.github/workflows/` | GitHub transport, bounded automation, and historical/transition records | no new normal-loop series; retirement needs reference audit and Control decision |
| `plans/` | historical or card-specific planning material | not semantic authority unless explicitly bound |
| `docs/` | orientation and security explanation | must not duplicate mutable current status |

## 4. Compatibility surfaces

The current Supervisor still contains ORCA terminal-recovery compatibility and
the repository retains its tests and fixtures. That coexistence is not proof of
overdevelopment: ORCA removal changes supported behavior and requires a separate
architecture/support decision. Likewise, the Herdr resume adapter and its
regression matrix protect exact admission, duplicate suppression, authority
revalidation, physical-send fencing, and uncertain-send stopping; their size
alone is not a deletion signal.

Sender and Watcher intentionally remain separate. The Watcher is read-only and
must not share the Sender's browser-write runner merely to reduce duplicated
plumbing.

## 5. Recovery and safety invariants

- Re-list and revalidate the exact target after a restart or transport drift;
  never trust a stale terminal handle or stale ref.
- Bind every action to the current card, generation, exact source head/tree,
  target, and idempotency key.
- Persist delivery state before the physical prompt where required, use the
  final reservation/lease/fence gate, and stop with `NO_BLIND_RETRY` when send
  outcome is uncertain.
- Treat malformed, incomplete, ambiguous, stale, or mismatched GitHub history as
  a control-required condition.
- Preserve `NEEDS_HUMAN` and other terminal boundaries; recovery cannot silently
  turn them back into active work.

## 6. Verification and change flow

1. Control publishes an exact card and the Worker reads it back.
2. Worker consumes the card in an isolated worktree, changes only allow-listed
   paths, and publishes a terminal receipt with exact hashes and evidence.
3. A NEW/FRESH/INDEPENDENT Reviewer rereads the current authority and exact
   candidate; it does not modify or adopt the candidate.
4. Control explicitly accepts or rejects the bounded result. Reviewer PASS does
   not itself authorize merge, release, deployment, or a successor.

For workflow retirement, the prerequisite is a complete reference audit against
current/open cards, comments, exact path/blob bindings, active normal-path needs,
and superseding terminal/acceptance receipts. Unproven items remain
`KEEP_ACTIVE`, `KEEP_HISTORICAL`, or `UNKNOWN`; do not delete by file age or line
count.

## 7. Environment notes

Tool versions, runner labels, executable locations, and runtime roots drift.
Record and verify them from the current Control card or live read-only checks;
do not treat an old inventory in this document as current configuration.

Security policy is maintained in [docs/SECURITY.md](SECURITY.md). Role and
mutation rules are summarized in [AGENTS.md](../AGENTS.md).
