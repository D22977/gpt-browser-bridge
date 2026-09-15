---
name: gbb-control-tower-v4_1-candidate
description: Candidate amendment that preserves the admitted Control Tower contract while making overnight-ready invariants, one-entrypoint cold start, and local Control-return behavior explicit.
---

# Control Tower SKILL v4.1 candidate — bounded handoff and Control-return law

Status: CANDIDATE only. This file is not the admitted canonical Skill and grants no integration, release, runtime, product, or reviewer authority. The canonical `skills/control-tower/SKILL.md` MUST NOT be modified by this Worker. A fresh independent review must read the exact new head and GitHub card before any later decision.

This candidate inherits every non-conflicting rule from the admitted D22977/gpt-browser-bridge skills/control-tower/SKILL.md, Git blob babbb3f704b852f499d96d2cb1ac7493e71cc851. The observed implementation base for this card is review-base/gbb-gh-01 at aa785ffae9122bf824bdbd9a57ac85a7f88f132e. The exact canonical identity is a live input, not a permanent constant.

## 1. Handoff-first navigation, authority unchanged

At every new Control conversation, generation handoff, process restart, recovered session, or local-adapter transition:

1. Read HANDOFF.md first for navigation only.
2. Bind the live admitted canonical Skill exact ref/head/blob and current durable GitHub Control authority.
3. Read SUCCESS_EVIDENCE_INDEX.md, then INVARIANTS_AND_LESSONS.md.
4. Bind current project/card/head state and only the exact task evidence and liveness required.
5. Open FAILURE_ARCHIVE.md only for the matching diagnostic, reviewer lineage, or explicit owner request.

A handoff pointer never outranks current owner instruction or current durable GitHub authority. A stale pointer fails closed and cannot select work.

## 2. Exact #62 overnight-ready invariants are normative

The exact source for this invariant set is D22977/gpt-browser-bridge#62 comment 5232486623:

- source_state: PASS
- capability_class: PROVEN_BOUNDED
- protocol: OVERNIGHT_RESUME_STANDARD_V1
- overnight_ready: true
- active_executor_surfaces: CODEX_DESKTOP_AGENT via preserved receipt 5232324012 / CODEX-DESKTOP-WAKE-ENTRYPOINT-V1; CODEX_LUNA_CLI_AGENT via runtime canary 1786291883245 / CODEX-LUNA-CLI-WAKE-V1
- schema: OVERNIGHT_RESUME_EVENT_V2
- required durable event tuple: source_repo, source_issue, source_receipt_id, source_protocol, source_event_class, target_executor, target_family, target_model, control_generation, observed_generation, idempotency_key, legal_next_action
- target binding: exact target executor/family/model, not a model name alone
- source event classes: CONTROL and FRESH_REVIEWER
- duplicate consumption: NO_OP
- stale, wrong, malformed, or conflicting authority: FAIL_CLOSED
- uncertain send: NO_BLIND_RETRY
- normal-path user_relay_count: 0
- runtime root and schema are part of the bounded contract
- explicit legal successor: before an unattended controller or current card terminates, its legal next action must be durably bound to the exact successor target, source event, idempotency key, and consumer.

These are normative admission conditions for an overnight-ready claim. A periodic instruction such as every 30 minutes, a chat promise, or a prior process being alive is not a resident/restartable trigger and cannot satisfy them. A current resident/restartable trigger must be able to re-invoke the consumer after process exit and re-read GitHub authority from the exact source event.

CONSUMED_STARTED != FUTURE_WAKE_BOUND. CONSUMED_STARTED proves one executor consumed one event. It does not prove that a resident scheduler/re-invocation binding will resume the next event after the parent exits or the child publishes READY. If the future consumer, scheduled binding, exact target, or legal successor is absent, report a precise missing-binding blocker such as BLOCKED_NO_BOUND_SUCCESSOR; do not report CAPABILITY_MISSING and do not silently wait forever.

## 3. Four overnight surfaces are distinct and non-substitutable

The following surfaces may cooperate but cannot be merged or substituted:

| Surface | Owns | Does not prove or replace |
| --- | --- | --- |
| Herdr/local Control decision consumer | Rereads durable GitHub authority and consumes an already-authorized event exactly once | OS scheduling, Browser DOM/send, or formal Reviewer dispatch |
| OS scheduler re-invocation | Resident/restartable parent invocation after process exit, with single-flight behavior | Semantic Control decisions, Browser transport, or Reviewer verdict |
| Browser TRANSPORT/SENDER | Physical Browser wake/UI send on its exact admitted surface | Scheduler recurrence, Control authority, or Reviewer orchestration |
| Independent Reviewer-dispatch orchestration | Exact reviewer task binding, fresh context request, result identity, and reviewer-owned result path | Browser transport alone, Control self-review, or scheduler recurrence |

A PASS in one surface cannot be promoted to another. In particular, GBB #83 is bounded Browser TRANSPORT/SENDER evidence, not overnight continuation or reviewer-dispatch evidence.

## 4. Evidence-state classification before architecture or capability proposals

Before proposing a new capability, service, queue, Router, or other infrastructure, classify the missing edge as exactly one or more of:

- CAPABILITY_PROVEN: an exact bounded capability has a current, repository-qualified PASS or PROVEN_BOUNDED receipt.
- CURRENT_BINDING/LIVENESS: the capability may be proven, but the exact current target, scheduler binding, resident/restartable trigger, or runtime liveness is absent or unknown.
- TRANSPORT: the physical Browser TRANSPORT/SENDER path and its current delivery binding.
- REVIEWER_ORCHESTRATION: independent Reviewer dispatch, fresh context, exact result binding, and reviewer-owned publication.

Do not turn CURRENT_BINDING/LIVENESS, TRANSPORT, or REVIEWER_ORCHESTRATION into CAPABILITY_MISSING without evidence. Do not combine the four surfaces into a new generic wake+queue service. A proven capability still needs the smallest authorized current binding check at actual execution.

## 5. Success admission, local adapter, and authority boundaries

SUCCESS_EVIDENCE_INDEX.md admits exact PASS/PROVEN_BOUNDED evidence only. READY, FIX_REQUIRED, BLOCKED, NO_OP, design authority, and unknown liveness remain outside the success index. #65 READY/FIX_REQUIRED and #66 FIX_REQUIRED x3 are lessons, not proven success. #68 is plan/design authority, not capability PASS.

A local gbb-control-tower adapter is optional. The #97 NO_OP_NO_LOCAL_ADAPTER_FOUND receipt 5454371697 means no bound adapter was found and no write occurred; it does not block direct canonical GitHub Skill use and does not authorize creating a new adapter. An unverified or stale adapter cannot override live canonical bytes.

Transport, capability, or overnight PASS does not grant Control semantic routing, Reviewer verdict, product mutation, merge, release, successor activation, or local-adapter synchronization authority. No self-review or proxy verdict is permitted.

## 6. Freshness and invariant preservation

All mutable branch, PR, issue, card, READY, result, scheduler, runtime, and lifecycle references must carry an observed identity and time or an explicit live_reread_required rule. A candidate package must fail closed when a cited mutable state is stale, superseded, conflicting, or unbound; read the current GitHub source before using it.

Before accepting a Skill consolidation, compare the mandatory invariant set of the prior admitted Skill and exact prior PASS receipts against the candidate. The invariant-preservation check must fail if any mandatory source event, exact target, idempotent consume, duplicate NO_OP, stale/wrong/malformed FAIL_CLOSED, user_relay=0, runtime/schema, or explicit legal-successor condition is dropped. Preserve source-state labels; never promote a lesson or design statement to PASS.

## 7. Bounded restart-boundary process contract

For an unattended card that expects a future READY or review transition, the plan must bind:

- the existing resident/restartable scheduler/re-invocation consumer;
- the exact durable source event and target executor;
- the exact legal successor token and next action;
- duplicate, stale, wrong, malformed, and conflicting outcomes;
- the no-user-relay rule.

The process test must terminate the active parent after child dispatch. After the child publishes READY, an existing scheduled wake must resume the exact successor exactly once with user_relay_count=0, or durably publish the precise missing-binding blocker. This tests current plan binding and parent/child continuation; it does not re-prove generic #62 capability. CONSUMED_STARTED alone cannot pass this test.

## 8. Bounded multi-AI and multi-executor dispatch

Control/Herdr may route a bounded card to any currently admitted,
role-compatible AI/executor lane that the card and current registry authorize.
Examples may include GPT Luna, OpenCode/DeepSeek, Codex/Connector, a fresh
WebGPT lane, or Grok when the exact card permits that lane. This is bounded
dispatch, not permission to create a router or to infer an executor from a
model name.

The dispatch contract is:

- GitHub is the task authority. The child receives only a minimal GitHub
  pointer and independently rereads the live card, dependencies, and newer
  superseding receipts.
- Bind `executor_role`, exact `executor_instance_id` or logical instance,
  `surface`, repo/card, task class, and current capability/liveness. A model
  or provider name alone never authorizes action.
- Classify `DISPATCH_CAPABILITY`,
  `MODEL_PROVIDER_CURRENT_AVAILABILITY`, and `CURRENT_LIVENESS` separately.
  A provider/model being unavailable does not erase an admitted Herdr
  dispatch capability.
- Executor substitution is permitted only when current durable card/Control
  authority explicitly allows it. Otherwise return `CONTROL_REQUIRED` or the
  card's equivalent fail-closed result; do not silently substitute.
- Do not create a generic model router, queue, orchestrator, or admission
  service merely because one provider or executor is unavailable.

The exact DeepSeek classification remains narrow and evidence-bound. Historical
OpenCode/DeepSeek use does not prove current reachability of
`opencode/deepseek-v4-flash-free`: CAD #2 recorded an
`OPTIONAL_BLOCKED_RUNTIME_ROUTE`, CAD #8 recorded
`BLOCKED_EXACT_MODEL_UNAVAILABLE_OR_UNREACHABLE`, and CAD #17 recorded
`BLOCKED_NO_ELIGIBLE_FREE_ROUTE`. These observations are not an exact-route
PASS and this candidate does not re-admit or retest that provider. Separately,
the current Issue #81 registry amendment admits a provider-agnostic generic
OpenCode Worker for cards that do not depend on a named model, subject to the
normal per-attempt access and exact-session checks. Keep those dimensions
separate.

## 9. Exact-owned disposable CLI and process cleanup

The launcher/watchdog/runtime lifecycle owner owns lifecycle only for an
execution surface it created or can bind exactly. Cleanup is a transport and
resource-hygiene operation, never semantic Control authority.

- When a disposable CLI/pane/process reaches its normal terminal or READY and
  no explicitly authorized same-card use remains, publish the required durable
  result first, read it back, then retire/close only that exact owned surface.
- On a bounded timeout, an exact-owned Worker may be terminated by its
  lifecycle owner only with timeout/kill evidence preserved and with no blind
  resend. A duplicate or stale child launch may be rejected or terminated only
  when it is the exact duplicate and ownership is certain; preserve the valid
  owner.
- Never broad-kill by process name, model, or tool. Never close an
  unknown/shared process, the active scheduler/wake consumer, active Control,
  or an independent Reviewer surface merely because one child card ended.
- Strong ownership evidence should bind the executor/card/run identity, PID
  and process start where available, pane/session/terminal identity, and
  isolated runtime identity. Ambiguity is `NO_OP` or `CONTROL_REQUIRED`, not a
  kill.
- Cleanup cannot choose `BEST_NEXT`, judge review, mutate product state, or
  grant merge/release/successor authority.

## 10. Forbidden changes

This candidate authorizes no new wake service, reviewer queue service, Router/admission framework, generic browser engine, persistent AI Control daemon, mandatory local adapter, runtime infrastructure, CAD/product mutation, merge/integration/release, self-review, proxy verdict, or capability re-proof of #62/#83 solely for this documentation repair.

## 11. Acceptance tests (18)

A fresh independent reviewer must verify at least these exact reconciliation tests:

1. #62 receipt 5232486623 is classified bounded PASS and its overnight-ready invariants are normative.
2. #65 cannot be represented as PASS or proven without a newer exact PASS.
3. #66 receipts 5243589918, 5243953042, and 5244200009 cannot be represented as PASS or proven; their lessons remain reachable.
4. #97 terminal NO_OP_NO_LOCAL_ADAPTER_FOUND does not block direct canonical use and does not authorize adapter creation.
5. Periodic prose such as every 30 minutes without a current scheduler binding cannot claim overnight-ready.
6. CONSUMED_STARTED alone cannot satisfy restart-safe future continuation.
7. A future READY without an exact legal-successor and scheduled-consumer binding resolves as a missing-binding fail-closed state, not CAPABILITY_MISSING and not silent indefinite WAIT.
8. #83 receipts 5252595723 and 5252645117 remain transport-only and cannot be promoted to reviewer-dispatch or overnight-continuation PASS.
9. Candidate packaging fails when a cited mutable lifecycle claim is stale against current GitHub durable state.
10. Fresh Control names all four overnight surfaces and rejects merging them into one generic wake+queue service.
11. SUCCESS_EVIDENCE_INDEX rejects an entry without exact PASS or PROVEN_BOUNDED identity.
12. FAILURE_ARCHIVE remains default-excluded while high-value FIX_REQUIRED lessons remain reachable through INVARIANTS_AND_LESSONS.
13. Skill consolidation invariant-preservation fails when a mandatory prior admitted invariant is dropped.
14. The restart-boundary parent/child process contract is explicit: parent exit after child dispatch, child READY, existing scheduler resume exactly once with exact legal successor binding and zero user relay, or a precise missing-binding terminal.
15. Given a valid card targeting an admitted different AI/executor, fresh Control selects the exact role/instance/surface lane and emits only a GitHub pointer; it does not paste task history or create a router service.
16. Given Herdr dispatch capability plus unavailable exact DeepSeek Flash Free runtime, Control returns `MODEL_PROVIDER_CURRENT_AVAILABILITY=BLOCKED` or `OPTIONAL_BLOCKED` (or an equivalent typed state) without declaring Herdr dispatch capability missing and without silently substituting an unauthorized executor.
17. Given a disposable CLI with exact ownership and no legal need to remain resident, the lifecycle owner retires only that exact surface after durable result publication/readback; the active scheduler/Control and unrelated CLI remain untouched.
18. Given unknown/shared CLI ownership or PID/session ambiguity, cleanup fails closed as `NO_OP` or `CONTROL_REQUIRED` and never performs a broad process-name kill.

These tests are documentation/contract acceptance checks. They do not authorize a runtime implementation, a new orchestrator, or later reviewer execution.

## 12. ONE_ENTRYPOINT_COLD_START_CONTRACT

This candidate defines one memoryless cold-start entrypoint for Control, Herdr, Worker,
and Reviewer handoff. It is a contract for reading existing durable authority, not a
new daemon, queue, router, or authority database.

At every cold start, restart, recovered session, or generation handoff, the entrypoint
must execute this bounded sequence exactly once before semantic work:

1. Read the live GitHub card and newest non-superseded receipts directly.
2. Read the current Control generation switch and registry; bind exact conversation or
   session identity, not a display name, model, or provider string.
3. Read the canonical Skill bytes and compare any local adapter by exact bytes/blob;
   use canonical GitHub bytes directly when no adapter is admitted.
4. Re-read mutable repository metadata immediately before mutation: exact base head,
   branch/worktree ownership, dirty state, and predecessor bindings.
5. Bind the exact task/card, dispatch receipt, role, executor instance, surface,
   allowed paths, current head, and idempotency key.
6. Select only the already-authorized deterministic edge. A missing or ambiguous edge
   is a Control-return condition, never an invented BEST_NEXT.

Project-specific bindings such as generation 007, Issue #102, `aa785ff...`, or a named
Worker belong in the durable card and current registry. Reusable role and capability
rules remain generation-neutral and never hard-code a runtime identity.

The entrypoint is success-first and pointer-minimal: it follows only the exact durable
source/target pointers needed for the current edge, stops at the first stale,
malformed, conflicting, or missing binding, and never copies task history or result
text through a user courier. `user_relay_count: 0` is the normal path.

## 13. LOCAL_CONTROL_RETURN_V1 / BLOCKED_RECOVERY_OBLIGATION

Any unexpected or non-preauthorized problem must return to the current ACTIVE Control
before further semantic work or new mutation. This includes authority conflict,
malformed newer authority, stale card/head/branch/review binding, unexpected dirty
state, scope or architecture ambiguity, non-preauthorized test failure or repair,
unavailable bound Worker where substitution would be needed, reviewer conflict, and
transport uncertainty that changes legal execution.

The Worker or Herdr must publish and read back exactly one durable
`LOCAL_CONTROL_RETURN_V1` (or the card's exact `CONTROL_REQUIRED`/`BLOCKED` equivalent)
on the task issue. The payload must include:

- `event_id` and `idempotency_key`;
- `card_id`, `phase`, current Control generation, dispatch, head, branch, and executor
  binding;
- `problem_class`, exact observations/evidence, `mutation_state`, and
  `last_known_safe_point`;
- safe deterministic checks/recoveries already attempted and actions explicitly not
  taken;
- `requested_control_decision` and `user_relay_count: 0`.

After publication/readback, semantic mutation stops. Herdr sends only a minimal pointer
to the latest valid ACTIVE Control. It cannot choose another Worker or Reviewer,
expand scope, select architecture, define repair, or convert a transport error into a
user relay. A second currently admitted deterministic delivery route may be tried only
for transport recovery; it does not grant semantic fallback authority. If all such
routes fail, publish/read back `CONTROL_DELIVERY_BLOCKED_V1` and preserve state.

Only an exact durable Control response bound to the return `event_id` and idempotency
key can resume work. Legal responses include `RESUME_EXACT`, `BOUNDED_REPAIR`,
`REBIND_EXECUTOR`, `REQUEST_FRESH_REVIEW`, `HOLD`, `ABORT`, and `HUMAN_REQUIRED`.
`HUMAN_REQUIRED` is last resort only for credentials, payment/security consent,
irreversible owner choice, unresolved product/scope authority, or restoration of all
legal Control-delivery routes. The owner is never asked to carry Worker or Reviewer
result text.

## 14. Long-unattended continuation and safe stopping

The overnight-ready heritage is strengthened with an explicit distinction between
`CONSUMED_STARTED` and future continuation. A consumed event proves one execution; it
does not prove a resident/restartable wake. Before a parent exits after dispatch, the
durable state must bind the exact source event, target, legal successor, scheduler or
re-invocation consumer, and idempotency key. After a child publishes READY or a
Control-return, the existing consumer must re-read GitHub and resume that exact edge
once, or publish a precise missing-binding terminal. Periodic prose, a live process,
or a chat promise is insufficient.

The safe unattended loop is:

```text
durable event -> exact consumer binding -> one consume
-> checkpoint/read-back -> child terminal or Control return
-> exact successor pointer or typed stop -> duplicate/stale NO_OP
```

The loop preserves single-flight execution, bounded retries, deterministic timeout
and result-missing classification, exact-owned cleanup only, no blind resend, and
`user_relay_count: 0`. It may pause or exit while waiting because GitHub remains the
authority; it must not assume an LLM process stays alive or polling.

## 15. Control-return regression index

The exact twelve mandatory regressions are specified in
`CONTROL_HANDOFF_PROTOCOL.md` as R01-R12. They are normative negative gates for this
candidate and do not authorize canonical integration, merge, release, generation
creation, or formal-review execution.

## 16. CONTROL_RETURN_AFTER_PASS and review/integration gates

Fresh-review `PASS` returns to ACTIVE Control for exact acceptance and integration
decision; it never integrates, merges, releases, creates generation 007, or retires
generation 006 by itself. Reviewer `FIX_REQUIRED`, `BLOCKED`, or `CONTROL_REQUIRED`
also returns to ACTIVE Control. A deterministic repair edge may run only when the
current durable card explicitly binds its scope, executor, base, head, and
idempotency key.

## 17. BIDIRECTIONAL_CONTROL_HERDR_HANDOFF_V1

This amendment makes the outbound handoff and inbound Control-return edge
explicit without creating a new transport or control plane. The exact state
machine is:

```text
ACTIVE_CONTROL -> DURABLE_DECISION_READBACK -> HERDR_CURRENT_ACCESS_CHECK
-> EXACT_HERDR_WAKE -> PHYSICAL_CONSUMED_STARTED_OR_RESIDENT_FUTURE_CONSUMER_BOUND
-> CONTROL_IDLE_ALLOWED -> HERDR/WORKER_EXECUTION
-> DURABLE_READY_TERMINAL_OR_CONTROL_RETURN -> CONTROL_RETURN_REQUEST
-> CONTROL_DOORBELL_TO_CURRENT_ACTIVE_GENERATION -> CONTROL_REHYDRATION
-> BOUNDED_CONTROL_DECISION
```

The following distinctions are invariant and must be preserved in every
receipt, test, and implementation:

- `DURABLE_DISPATCH != PHYSICAL_HANDOFF_COMPLETE`.
- `CONSUMED_STARTED != FUTURE_WAKE_BOUND`.
- `TERMINAL_DURABLE != AUTO_REPORT_COMPLETE`.
- `CAPABILITY_PROVEN != CURRENT_LIVENESS`.
- `TRANSPORT != AUTHORITY`.

`CONTROL_IDLE_ALLOWED` is legal only after the exact bound target has physically
consumed the event and the exact resident/restartable future consumer, legal
successor, and idempotency binding are durably proven. A dispatch receipt,
open process, periodic instruction, or model polling cannot satisfy that gate.
Once idle is allowed, active Web Control performs no semantic polling; the
existing deterministic local consumer owns the wait and the next exact edge.

On a Worker terminal or local return, the existing consumer must reread the
current ACTIVE Control generation and publish/read back the exact return or
READY evidence before any next decision. A terminal without that return/doorbell
edge is `AUTO_REPORT_INCOMPLETE`. A stale or retired target is
`NO_OP_RETIRED`, and a duplicate outbound wake or inbound doorbell is
`NO_OP_DUPLICATE` with no second prompt, mutation, or semantic decision.

Herdr runtime failure blocks only current liveness. It preserves any exact
`PROVEN_BOUNDED` capability classification and never authorizes a new
scheduler, watcher, router, queue, infrastructure, or silent substitution.
If a child terminates after its parent exits without a resident exact successor,
the result is `FUTURE_WAKE_BOUND_MISSING` / `BLOCKED_NO_BOUND_SUCCESSOR`, not a
capability failure and not silent indefinite waiting.

Every source, card, head, generation, target, role, and idempotency mismatch
fails closed as `FAIL_CLOSED` before mutation. Normal execution keeps
`user_relay_count: 0` and `owner_courier_count: 0`. Worker READY remains a
candidate terminal for fresh independent review; it never authorizes review,
merge, release, canonical Skill mutation, or successor inference.

