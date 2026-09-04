# Control Tower Handoff — navigation landing contract

Status: CANDIDATE only. This document is a navigation pointer, not a replacement for live GitHub authority.

## Fresh reading order (exact)

Read these items in this order after a new Control conversation, generation handoff, process restart, recovered session, or local-adapter transition:

1. HANDOFF navigation only: use this file to locate the authoritative material; do not use its phase, gate, or next-action wording as authority.
2. Admitted canonical Skill identity: read the live D22977/gpt-browser-bridge skills/control-tower/SKILL.md and bind its current ref, commit head, and Git blob SHA. The candidate-base identity recorded here is review-base/gbb-gh-01, head 50cd14c941072de5ea04690f286683c05eac1d81, blob babbb3f704b852f499d96d2cb1ac7493e71cc851; fail closed if a live reread differs.
3. SUCCESS_EVIDENCE_INDEX: admit only exact PASS or PROVEN_BOUNDED evidence and read the exact receipt needed for the current task.
4. INVARIANTS_AND_LESSONS: read the typed source-state lessons after SUCCESS; they preserve constraints but grant no capability authority.
5. Current project durable Control/current-start-here + product/card identity: read the newest non-superseded GitHub Control/current-start-here pointer, then bind the current product or candidate, Issue #100 card, PR #98, branch, base, and head.
6. Exact task evidence/liveness: read only the receipts and current liveness needed by this task; classify capability, binding/liveness, transport, and reviewer orchestration separately.
7. FAILURE_ARCHIVE only for matching diagnostic/reviewer lineage/owner request: open only the exact matching entry when a current error, independent reviewer, or explicit owner request requires it.

The seventh item is conditional. Do not replay the archive during normal rehydration.

## Authority and freshness

Reading order does not change authority precedence. Current owner instruction for the live interaction and current durable GitHub authority outrank this pointer. A stale pointer must be ignored and reported as stale rather than used to choose work.

This candidate is the exact PR #98 artifact on branch control-tower/handoff-success-index-v1. The input head for this repair is f8924416552bc7eb805087e3349bc89009a0eb4d; a fresh Control must reread the live head before use. Mutable branch, card, review, and lifecycle claims require an observed identity and time or an explicit live_reread_required rule.

## Direct canonical use and exit facts

A local gbb-control-tower adapter is optional. If no adapter exists, the terminal NO_OP_NO_LOCAL_ADAPTER_FOUND receipt D22977/gpt-browser-bridge#97 comment 5454371697 does not block direct use of the canonical GitHub Skill and does not authorize adapter creation. An unverified local adapter never overrides canonical GitHub bytes.

After the exact reading order, the successor must be able to state the current Control generation and durable landing pointer, canonical Skill identity, product/card identity, strongest bounded success evidence, task-required liveness, legal successor binding, and forbidden actions. If not, fail closed and repair only the authorized landing artifact.
