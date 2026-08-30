# Control Tower Handoff — navigation landing contract

Status: CANDIDATE only. This document is a navigation pointer, not a replacement for live GitHub authority.

## Fresh reading order (exact)

Read these items in this order after a new Control conversation, generation handoff, process restart, recovered session, or local-adapter transition:

1. HANDOFF navigation only: use this file to locate the authoritative material; do not use its phase, gate, or next-action wording as authority.
2. Admitted canonical Skill identity: read the live D22977/gpt-browser-bridge skills/control-tower/SKILL.md and bind its current ref, commit head, and Git blob SHA. The observed implementation base for this candidate is review-base/gbb-gh-01, head aa785ffae9122bf824bdbd9a57ac85a7f88f132e, blob babbb3f704b852f499d96d2cb1ac7493e71cc851; fail closed if a live reread differs.
3. SUCCESS_EVIDENCE_INDEX: admit only exact PASS or PROVEN_BOUNDED evidence and read the exact receipt needed for the current task.
4. INVARIANTS_AND_LESSONS: read the typed source-state lessons after SUCCESS; they preserve constraints but grant no capability authority.
5. Current project durable Control/current-start-here + product/card identity: read the newest non-superseded GitHub Control/current-start-here pointer, then bind the current candidate, Issue #102 card, PR #98 predecessor, implementation branch, exact base, and head.
6. Exact task evidence/liveness: read only the receipts and current liveness needed by this task; classify capability, binding/liveness, transport, and reviewer orchestration separately.
7. FAILURE_ARCHIVE only for matching diagnostic/reviewer lineage/owner request: open only the exact matching entry when a current error, independent reviewer, or explicit owner request requires it.

The seventh item is conditional. Do not replay the archive during normal rehydration.

## Authority and freshness

Reading order does not change authority precedence. Current owner instruction for the live interaction and current durable GitHub authority outrank this pointer. A stale pointer must be ignored and reported as stale rather than used to choose work.

This candidate carries forward the reviewed PR #98 semantics from head 015a8ad4e7877eca98669b0099184c0885b2b538 onto the Issue #102 implementation branch. The current card and branch/head are live inputs; a fresh Control must reread them before use. Mutable branch, card, review, and lifecycle claims require an observed identity and time or an explicit live_reread_required rule.

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
