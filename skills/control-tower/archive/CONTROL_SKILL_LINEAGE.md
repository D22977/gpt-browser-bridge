# Control Skill v4.1 lineage archive

Status: CANDIDATE pointer archive. This file preserves immutable identities and
supersession relationships; it is not a current authority snapshot and is not read
during normal cold start unless the matching lineage is required.

## Pointer-only archive

| archive item | exact identity | historical state | current-use rule |
| --- | --- | --- | --- |
| admitted v3 canonical Skill | `review-base/gbb-gh-01 @ 50cd14c941072de5ea04690f286683c05eac1d81`, blob `babbb3f704b852f499d96d2cb1ac7493e71cc851` | canonical predecessor | immutable historical source; live GitHub reread wins |
| current content-equivalent post-incident base | `review-base/gbb-gh-01 @ aa785ffae9122bf824bdbd9a57ac85a7f88f132e` | exact v4.1 implementation base | must be re-read before branch creation; no guessed rebase |
| preserved incident chain | `9daa2e17abaefbe4905120054f47afcfb682bb1f -> aa785ffae9122bf824bdbd9a57ac85a7f88f132e` | history preserved | no force rewrite or cleanup |
| write-gate incident | Issue #43 receipt `5465051064` | immutable incident evidence | read only for matching write-gate audit |
| PR98 base-history hold | Issue #101 receipt `5465051867` | immutable hold | preserve predecessor history and exact base distinction |
| accepted PR98 candidate | `control-tower/handoff-success-index-v1 @ 015a8ad4e7877eca98669b0099184c0885b2b538` | accepted predecessor, not integrated | carry forward semantics only; do not mutate its ref |
| PR98 fresh review | Issue #101 receipt `5463495551` | PASS | bounded review evidence for the exact PR98 head |
| PR98 Control acceptance | Issue #101 receipt `5463565634` | accepted predecessor | does not integrate v4.1 or authorize merge |
| v4.1 owner requirements | Issue #43 receipts `5465071194` and `5465120337` | durable owner/control requirements | live reread required before use |
| current Control-return amendment | Issue #43 receipt `5466283422` | current architecture correction | local problem returns to ACTIVE Control first |
| historical G6/G7 implementation dispatch | Issue #102 receipt `5466285546` and older G6/G7 dispatch lineage | HISTORICAL/SUPERSEDED | never select as a current executable command; resolve execution only from the newest live GitHub Control/current-task authority |
| v4.1 Worker terminal shape | `CONTROL_SKILL_V4_1_READY_FOR_FRESH_REVIEW_V1` | exact single terminal required by Issue #102 | publish once after fresh verification; stop at fresh independent review |

Every mutable item above remains subject to a fresh GitHub reread. An archive pointer
never proves current branch state, runtime liveness, executor availability, review
eligibility, or legal successor selection.

## Long-unattended heritage pointers

The candidate reuses only the bounded properties proved by these historical records:

- GBB #62 receipt `5232486623`, `OVERNIGHT_RESUME_STANDARD_V1`,
  `overnight_ready: true`: exact source/target/session binding, persisted restart
  state, duplicate `NO_OP`, stale/malformed fail-closed behavior, no blind retry,
  and `user_relay_count: 0`.
- GBB v1 Gate G closure commit `96778c9`: duplicate run rejection, deterministic
  timeout/result-missing exits, Job Object descendant cleanup, and runner-owned
  evidence protection.
- The #62 earlier partial record `5232324012` is retained as a caution: a tested
  resume mechanism without a resident restart-on-failure trigger is not proof of
  unattended operation. The trigger, restart policy, GitHub reread, exact successor,
  and current consumer binding must be explicit.

These pointers strengthen the candidate's stop-and-return law; they do not authorize
retesting, provider discovery, a new scheduler, or a new control plane.

## Archive invariants

1. Old branches and commits are never deleted or rewritten for cleanliness.
2. A receipt identity proves only what that receipt recorded; mutable claims require
   observed identity/time or `live_reread_required: true`.
3. `CONSUMED_STARTED` never substitutes for a future wake binding.
4. A historical PASS in one surface never promotes another surface to PASS.
5. A failure or lesson is never promoted to a success entry by copying it here.
