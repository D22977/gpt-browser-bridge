# Control Tower Handoff — navigation landing contract

Status: CANDIDATE only. This document is a navigation pointer, not a replacement for live GitHub authority.

## Fresh reading order (exact)

Read these items in this order after a new Control conversation, generation handoff, process restart, recovered session, or local-adapter transition:

1. HANDOFF navigation only: use this file to locate the authoritative material; do not use its phase, gate, or next-action wording as authority.
2. Admitted canonical Skill identity: read the live D22977/gpt-browser-bridge skills/control-tower/SKILL.md and bind its current ref, commit head, and Git blob SHA. The aa785ffae9122bf824bdbd9a57ac85a7f88f132e implementation-base reference is historical lineage/evidence only; a reviewed default-head advance does not by itself make the current identity stale. Fail closed only on an actual live canonical Skill identity/blob mismatch or a current-authority mismatch.
3. SUCCESS_EVIDENCE_INDEX: admit only exact PASS or PROVEN_BOUNDED evidence and read the exact receipt needed for the current task.
4. INVARIANTS_AND_LESSONS: read the typed source-state lessons after SUCCESS; they preserve constraints but grant no capability authority.
5. Current project durable Control/current-start-here + product/card identity: read the newest non-superseded GitHub Control/current-start-here pointer, then bind the current task/card, PR or predecessor lineage, implementation branch, exact base, and head from that live authority.
6. Exact task evidence/liveness: read only the receipts and current liveness needed by this task; classify capability, binding/liveness, transport, and reviewer orchestration separately.
7. FAILURE_ARCHIVE only for matching diagnostic/reviewer lineage/owner request: open only the exact matching entry when a current error, independent reviewer, or explicit owner request requires it.

The seventh item is conditional. Do not replay the archive during normal rehydration.

## Authority and freshness

Reading order does not change authority precedence. Current owner instruction for the live interaction and current durable GitHub authority outrank this pointer. A stale pointer must be ignored and reported as stale rather than used to choose work.

This candidate carries forward the reviewed PR #98 semantics from head 015a8ad4e7877eca98669b0099184c0885b2b538 as historical predecessor lineage. The current card and branch/head are live inputs; a fresh Control must reread them before use. Mutable branch, card, review, and lifecycle claims require an observed identity and time or an explicit live_reread_required rule.

## Direct canonical use and exit facts

A local gbb-control-tower adapter is optional. If no adapter exists, the terminal NO_OP_NO_LOCAL_ADAPTER_FOUND receipt D22977/gpt-browser-bridge#97 comment 5454371697 does not block direct use of the canonical GitHub Skill and does not authorize adapter creation. An unverified local adapter never overrides canonical GitHub bytes.

After the exact reading order, the successor must be able to state the current Control generation and durable landing pointer, canonical Skill identity, product/card identity, strongest bounded success evidence, task-required liveness, legal successor binding, and forbidden actions. If not, fail closed and repair only the authorized landing artifact.

## Cold-start and blocker return

This file is navigation only. The one-entrypoint cold-start contract and semantic
Control-return rules live in `SKILL_V4_1_CANDIDATE.md` and
`CONTROL_HANDOFF_PROTOCOL.md`; this pointer never chooses a Worker, Reviewer,
repair, scope, or BEST_NEXT action.

On any unexpected/non-preauthorized problem, the executor must publish/read back one
`LOCAL_CONTROL_RETURN_V1` or exact `CONTROL_REQUIRED` pointer on the task issue, stop
semantic mutation, and wake the latest valid ACTIVE Control with only that minimal
pointer. If delivery fails on every admitted deterministic route, preserve state and
publish/read back `CONTROL_DELIVERY_BLOCKED_V1`. The normal owner/user courier count
is zero.

## Bidirectional handoff pointer

For the outbound Worker edge and inbound Control-return edge, read
`SKILL_V4_1_CANDIDATE.md` section
`BIDIRECTIONAL_CONTROL_HERDR_HANDOFF_V1`, then
`CONTROL_HANDOFF_PROTOCOL.md` sections `BIDIRECTIONAL_CONTROL_HERDR_HANDOFF_V1`
and `BH01`-`BH10`. Those sections are the candidate contract and negative gates;
this landing file remains navigation only and cannot authorize a wake, repair,
review, merge, release, or successor.


## A0 bounded repair scope

The Issue #114 live card is the sole authority for this pre-merge repair. Its
R01-R04 Worker mutation is limited to these four tracked paths:

- `skills/control-tower/HANDOFF.md`
- `skills/control-tower/FAILURE_ARCHIVE.md`
- `skills/control-tower/archive/CONTROL_SKILL_LINEAGE.md`
- `tests/contracts.test.mjs`

No other tracked path may change. The canonical `skills/control-tower/SKILL.md`
and the default branch remain outside this Worker scope.
