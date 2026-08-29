---
name: gbb-control-tower-v4-candidate
description: Candidate amendment that preserves the admitted Control Tower contract while making overnight-ready invariants, evidence-state classification, handoff freshness, and non-substitutable execution surfaces explicit.
---

# Control Tower SKILL v4 candidate — bounded handoff and overnight invariants

Status: CANDIDATE only. This file is not the admitted canonical Skill and grants no integration, release, runtime, product, or reviewer authority. A fresh independent review must read the exact new head and GitHub card before any later decision.

This candidate inherits every non-conflicting rule from the admitted D22977/gpt-browser-bridge skills/control-tower/SKILL.md at base head 50cd14c941072de5ea04690f286683c05eac1d81, Git blob babbb3f704b852f499d96d2cb1ac7493e71cc851. The exact canonical identity is a live input, not a permanent constant.

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

## 8. Forbidden changes

This candidate authorizes no new wake service, reviewer queue service, Router/admission framework, generic browser engine, persistent AI Control daemon, mandatory local adapter, runtime infrastructure, CAD/product mutation, merge/integration/release, self-review, proxy verdict, or capability re-proof of #62/#83 solely for this documentation repair.

## 9. Acceptance tests (14)

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

These tests are documentation/contract acceptance checks. They do not authorize a runtime implementation, a new orchestrator, or later reviewer execution.
