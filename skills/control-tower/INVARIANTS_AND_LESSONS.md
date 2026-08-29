# Control Tower Invariants and Lessons

Status: CANDIDATE typed evidence companion. Default-readable after SUCCESS_EVIDENCE_INDEX and before current task routing. This file grants no capability, authority, liveness, successor, reviewer, merge, release, or product permission beyond the exact source state named in each entry.

## Typed-entry contract

Every entry carries a type, exact repository-qualified source and receipt, source state, authority effect, reusable invariant or lesson, non-authority boundary, and freshness rule. PASS-derived invariants preserve a bounded source claim. READY, FIX_REQUIRED, plan, and NO_OP records remain their source states; they are never relabeled as success.

## Entry IL-62 — PASS-derived overnight-ready invariants

- type: PASS_DERIVED_INVARIANT
- source: D22977/gpt-browser-bridge#62 comment 5232486623
- source_state: PASS
- capability_class: PROVEN_BOUNDED
- authority_effect: preserves only the exact bounded OVERNIGHT_RESUME_STANDARD_V1 mechanism and admitted surfaces; no current project binding is inferred.
- reusable_invariants:
  - overnight_ready requires a resident/restartable trigger that can re-invoke the consumer after process exit;
  - the OVERNIGHT_RESUME_EVENT_V2 tuple must bind source_repo, source_issue, source_receipt_id, source_protocol, source_event_class, target_executor, target_family, target_model, control_generation, observed_generation, idempotency_key, and legal_next_action;
  - consume is idempotent and duplicate consumption is NO_OP;
  - stale, wrong, malformed, or conflicting authority is FAIL_CLOSED and uncertain sends are not blindly retried;
  - normal-path user_relay_count is 0;
  - an exact legal successor must be durably bound before an unattended controller or current card terminates.
- non_authority: this record does not prove current scheduler liveness, current task binding, Browser transport, Reviewer orchestration, or universal reachability.
- freshness: retain exact receipt identity and require live reread for current binding/liveness.

## Entry IL-65 — Worker-Pull READY/FIX_REQUIRED lessons

- type: READY_FIX_REQUIRED_LESSON
- source: D22977/gpt-browser-bridge#65 READY comment 5242879562; formal FIX_REQUIRED comments 5247483464 and 5247486608
- source_state: READY plus FIX_REQUIRED; NOT PASS
- authority_effect: records negative implementation/review lessons only; no Worker-Pull capability is admitted.
- reusable_lessons:
  - the runtime-only review identity is review_request_id + source_ready_receipt_id + implementation_file_set_sha256; do not fabricate reviewed_head_sha;
  - READY with no exact formal result is WAIT_REVIEW / NO_MUTATION;
  - malformed, stale, conflicting, or superseded current authority is fail closed;
  - actual entrypoint behavior must preserve zero file mutation on WAIT_REVIEW;
  - current READY/result selection must be deterministic and exact-bound.
- non_authority: READY and FIX_REQUIRED do not enter SUCCESS_EVIDENCE_INDEX and do not prove an operational scheduler, Worker, Reviewer, or successor route.
- freshness: the READY/result lineage is historical source evidence; reread Issue #65 before applying a current state.

## Entry IL-66 — Reviewer-dispatch FIX_REQUIRED lessons

- type: FIX_REQUIRED_LESSON
- source: D22977/gpt-browser-bridge#66 comments 5243589918, 5243953042, and 5244200009
- source_state: FIX_REQUIRED x3; NOT PASS
- authority_effect: records reusable negative lessons only; no reviewer-dispatch capability or verdict authority is admitted.
- reusable_lessons:
  - exact result binding must include the card, issue, round, review_request_id, source_ready_receipt_id, and exact implementation_file_set_sha256; a wrong or missing field fails closed;
  - persisted LAUNCHING must remain an active duplicate guard across a parent restart so a second Reviewer is not launched;
  - post-launch observed results must satisfy full sameBinding with the current READY, not merely a same-target subset;
  - the current authorized READY protocol must be recognized and newer READY must supersede older protocol/identity; stale or conflicting authority fails closed.
- non_authority: these three FIX_REQUIRED results are not PASS, not proven reviewer orchestration, and not a formal verdict for any other card.
- freshness: use only as typed historical lessons after a live reread of Issue #66 and current review authority.

## Entry IL-68 — Immutable-plan and successor lessons

- type: PLAN_AND_SUCCESSOR_LESSON
- source: D22977/gpt-browser-bridge#68 comments 5241192078, 5241658627, and 5242713117
- source_state: ACTIVE_IMMUTABLE_NIGHT_RUN; ACTIVE_RUNTIME_ROUTING; ACTIVE_OVERNIGHT_ROUTING; DESIGN/PLAN AUTHORITY, not PASS
- authority_effect: preserves plan immutability, exact sequence, and successor-binding constraints; it grants no execution or capability authority.
- reusable_lessons:
  - once plan generation 2026-08-10-A is active and immutable, do not edit or reorder it; a different authority decision requires a new plan generation;
  - GitHub activation or PREPARED/dispatch wording is not evidence that a local process started or that a child consumed a task;
  - a legal successor must be explicit and durably bound before terminal continuation is promised;
  - current Worker lifecycle remains CARD_EXISTS -> DISPATCH_REQUEST_WRITTEN -> CONSUMED_STARTED -> TERMINAL_RESULT; do not collapse states;
  - immutable plan/design authority is not execution, capability PASS, or reviewer verdict.
- non_authority: no plan entry can substitute for a current scheduler binding, Herdr/local Control consumer, Browser TRANSPORT/SENDER, independent Reviewer dispatcher, or terminal receipt.
- freshness: preserve exact plan receipt identity and reread current plan/card state before use.
## Consolidated non-inflation rule

This file is default-readable because non-PASS lessons must not disappear between SUCCESS and current routing. It is not a success index. A later exact PASS may supersede a lesson only for the bounded scope it explicitly proves; no source-state label is changed retroactively.
