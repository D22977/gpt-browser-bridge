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

## Entry IL-ROUTE — Bounded multi-AI and multi-executor routing

- type: BOUNDED_DISPATCH_INVARIANT
- source: D22977/cad-pid-reconstruction#2 comment 5449557775; D22977/gpt-browser-bridge#81 comments 5463209769 and 5463211114
- source_state: ACCEPTED_BOUNDED for Herdr/GitHub/GPT Luna child routing; `OPTIONAL_BLOCKED_RUNTIME_ROUTE` for the exact OpenCode/DeepSeek Free route in the CAD admission record
- authority_effect: preserves only exact role-compatible child routing when a current card/registry authorizes it; it does not grant semantic Control, formal-review, product, merge, release, or successor authority.
- reusable_invariants:
  - GitHub is the task authority and a child receives a minimal pointer, then rereads GitHub independently.
  - Bind executor role, exact instance/surface, repo/card, task class, and current capability/liveness; model/provider names are evidence, not identity.
  - Keep `DISPATCH_CAPABILITY`, `MODEL_PROVIDER_CURRENT_AVAILABILITY`, and `CURRENT_LIVENESS` as independent dimensions.
  - An unavailable provider does not erase Herdr dispatch capability; substitution requires current durable card/Control authority, otherwise return Control/fail closed.
  - Do not create a generic router, queue, or orchestrator to compensate for provider unavailability.
- DeepSeek nuance: CAD #2 comment 5449557775 recorded `OPTIONAL_BLOCKED_RUNTIME_ROUTE`; CAD #8 comment 5450389802 recorded `BLOCKED_EXACT_MODEL_UNAVAILABLE_OR_UNREACHABLE`; CAD #17 comment 5452707104 recorded `BLOCKED_NO_ELIGIBLE_FREE_ROUTE`. Historical OpenCode/DeepSeek work is therefore not a current exact `opencode/deepseek-v4-flash-free` PASS. Issue #81's newer provider-agnostic OpenCode amendment may be used only for model-independent cards with a normal current access preflight; it does not re-admit or retest that exact route.
- non_authority: this mixed routing evidence proves neither universal AI reachability nor a named-provider current route, and it cannot authorize a new executor, router, or silent substitution.
- freshness: reread the current Issue #81 registry and the exact card before using any executor or provider state; historical CAD receipts remain evidence-state records, not current liveness.

## Entry IL-CLEANUP — Exact-owned disposable CLI/process lifecycle safety

- type: EXACT_OWNED_LIFECYCLE_SAFETY_LESSON
- source: D22977/gpt-browser-bridge#81 comments 5411436689, 5411707697, and 5411732428; corroborating local bounded smoke `fixtures/orca/WINDOWS_RESUME_SMOKE_20260801.md`
- source_state: CURRENT_LIFECYCLE_AMENDMENTS with bounded smoke corroboration; safety contract only, not a universal cleanup capability PASS
- authority_effect: permits lifecycle hygiene only for a disposable CLI/pane/process that the launcher/watchdog/runtime owner created or can bind exactly. It grants no semantic, product, review, merge, release, or successor authority.
- reusable_lessons:
  - Normal retirement occurs only after the required durable result/READY is published and read back, and only when no explicitly authorized same-card use remains.
  - A bounded timeout may terminate an exact-owned Worker with preserved timeout/kill evidence and no blind resend.
  - A duplicate or stale child may be rejected/terminated only when exact ownership is certain; preserve the valid owner.
  - Strong ownership binds executor/card/run identity, PID and process start where available, pane/session/terminal identity, and isolated runtime identity.
  - Broad process-name/model/tool kills are forbidden; unknown/shared processes and active scheduler/wake, Control, and independent Reviewer surfaces are not disposable child resources.
  - Ownership or PID/session ambiguity resolves to `NO_OP` or `CONTROL_REQUIRED`, never a kill.
  - The Windows smoke corroborates exact cleanup of a project-specific scheduled task, canary PIDs, and a validated isolated runtime while checking unrelated processes were untouched; it does not prove permission to clean arbitrary runtime resources.
- non_authority: cleanup cannot select BEST_NEXT, judge a review, mutate product state, or convert transport/resource evidence into semantic success.
- freshness: current card, binding, and lifecycle state must be reread before any cleanup; local smoke is immutable historical corroboration and does not replace current ownership evidence.

## Consolidated non-inflation rule

This file is default-readable because non-PASS lessons and bounded safety invariants must not disappear between SUCCESS and current routing. It is not a success index. A later exact PASS may supersede a lesson only for the bounded scope it explicitly proves; no source-state label is changed retroactively.
