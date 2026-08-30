# Control Tower v4.1 handoff and local-return protocol

Status: CANDIDATE only. This protocol is a durable contract for a fresh Control,
Herdr, Worker, or Reviewer context. It does not replace the live GitHub authority,
does not modify the canonical Skill, and does not create a second control plane.

## BLOCKED_RECOVERY_OBLIGATION

Any blocked recovery, unexpected local problem, or non-preauthorized decision point
must use the return schema below before semantic work or further mutation. The
obligation is satisfied only by a durable GitHub return and read-back, followed by
the minimal pointer to the latest valid ACTIVE Control.

## Authority and one-entrypoint reading order

The only semantic authority is the newest valid, repository-qualified GitHub Control
receipt. `HANDOFF.md` is navigation only. A cold start, restart, recovered session,
or generation transition must use one entrypoint with this order:

1. Read the current task issue and newest comments directly from GitHub.
2. Read the current registry and generation switch, binding exact conversation or
   session identity, not a display name, model, or provider.
3. Read the canonical Skill bytes and compare any local adapter by exact bytes/blob.
4. Read the candidate handoff, success index, invariants/lessons, and only the
   matching failure archive entry when the live problem requires it.
5. Re-read the mutable base head, branch/worktree ownership, dirty state, current
   dispatch, predecessor, and review binding immediately before mutation.
6. Execute only the exact preauthorized edge, or publish one Control return and stop.

The reusable role/capability contract is generation-neutral. Project-specific values
such as Issue #102, generation 007, the current branch, or a named Worker are bound
by the live card and registry at execution time and must not be hard-coded into a
generic executor.

## Handoff phases and freeze rule

The durable handoff phases are:

```text
PREPARE -> FREEZE_HANDOFF_SCOPE -> ARCHIVE_PREDECESSORS -> HANDOFF_MANIFEST
-> CANDIDATE_AND_EXTERNAL_REVIEW -> INTEGRATION_GATE -> ROTATION_REQUIRED
-> NEW_CONTROL_REHYDRATION -> ROUTING_CANARY -> SWITCH -> RETIRED_BEHAVIOR
```

Failure at any phase keeps the old generation ACTIVE and forbids a partial switch.
The Worker may prepare the candidate and evidence only; it may not integrate the
canonical Skill, create the successor generation, retire the predecessor, merge,
release, or dispatch a workflow.

The handoff manifest must bind the predecessor generation/conversation and switch,
successor candidate status, canonical Skill ref/head/blob, current Control/registry
and product pointers, active card/executor/wait/blocker/terminal states,
accepted-but-unintegrated candidates, owner decisions and forbidden actions,
current BEST_NEXT/critical-path pointer, archive lineage, external review and
integration status, rotation checklist, and a freshness/idempotency marker.

## Durable return schema

`LOCAL_CONTROL_RETURN_V1` is the required terminal for an unexpected or
non-preauthorized problem. The record is published to the exact task issue and read
back before any pointer wake:

```yaml
protocol: LOCAL_CONTROL_RETURN_V1
event_id: <fresh deterministic event identity>
idempotency_key: <unique return delivery identity>
card_id: <exact current card>
phase: <exact current phase>
control_generation: <observed active generation and switch receipt>
dispatch: <exact current dispatch receipt or null>
head: <exact observed repository head>
branch: <exact observed branch/worktree identity>
problem_class: <typed blocker class>
evidence: <exact observations, errors, and source receipt references>
mutation_state: <NO_MUTATION or exact last mutation state>
last_known_safe_point: <checkpoint before the problem>
checks_attempted: <safe deterministic checks/recoveries only>
actions_not_taken: <substitution, scope, repair, reviewer, and product actions withheld>
requested_control_decision: <bounded decision requested from ACTIVE Control>
user_relay_count: 0
```

The return is a semantic stop. The Worker cannot repair, widen scope, choose a
replacement, select a Reviewer, or infer BEST_NEXT. Herdr is transport/session
orchestration only and has no semantic Control authority.

## Return delivery and response binding

The deterministic coordinator sends only a minimal pointer containing the task issue,
return receipt, and request to reread GitHub. It must not paste the full result,
task history, evidence narrative, or Reviewer output as authority. If the first
admitted deterministic delivery route fails, a second applicable route may be tried
only as transport recovery. Transport failure does not grant semantic fallback
authority.

If every legal Control-delivery route fails, publish/read back
`CONTROL_DELIVERY_BLOCKED_V1`, preserve the worktree and durable evidence, and stop.
This is not a request for the owner to courier Worker or Reviewer results.

Only a fresh durable Control decision bound to the same `event_id`, `idempotency_key`,
card, phase, generation, dispatch, head, and branch may resume execution. Legal
responses are `RESUME_EXACT`, `BOUNDED_REPAIR`, `REBIND_EXECUTOR`,
`REQUEST_FRESH_REVIEW`, `HOLD`, `ABORT`, and `HUMAN_REQUIRED`. A response with a
mismatched return event is rejected before resume.

`HUMAN_REQUIRED` is last resort only for credentials, payment/security consent,
irreversible owner choice, unresolved product/scope authority, or restoration of all
legal Control-delivery routes. Ordinary runtime errors, test failures, unavailable
Workers, and reviewer findings return to ACTIVE Control instead.

## Long-unattended continuation contract

The durable loop distinguishes `CONSUMED_STARTED` from future wake binding. Before a
parent exits, the state must bind the source event, exact target, legal successor,
existing scheduler/re-invocation consumer, and idempotency key. After a child emits a
terminal or Control return, the consumer rereads GitHub and resumes that exact edge
once, or emits a precise missing-binding terminal. A periodic promise, open terminal,
or LLM process is not a resident trigger.

```text
GitHub event -> exact consumer binding -> one consume
-> durable checkpoint/read-back -> terminal or Control return
-> exact successor OR typed stop -> duplicate/stale NO_OP
```

The loop preserves single-flight execution, bounded retries, no blind resend,
exact-owned cleanup, terminal/result-missing classification, and
`user_relay_count: 0`. The local process may pause or exit while waiting because
GitHub remains authoritative.

## TOOL_MUTATION_GATE

Tool availability or connector permission is never mutation authority. Before any
file, ref, process, issue-state, or product-state mutation, the executor must bind
the exact current authority, target/path/surface, and purpose. Read, diagnostic,
audit, and review tasks default to `NO_TRACKED_MUTATION` and
`NO_PROCESS_MUTATION`. Wrong tool selection fails closed before mutation. An
unauthorized mutation stops all further mutation, preserves evidence, performs only
an exactly-owned reversible cleanup when legally justified, publishes the incident,
and invalidates affected review/integration identity.

## Mandatory control-return regressions

Each scenario below is a negative gate. Its expected result is a durable return,
no unauthorized semantic mutation, and zero normal user/owner courier use.

### R01 — head drift

Trigger: exact base/head drift is observed before mutation. Result:
`LOCAL_CONTROL_RETURN_V1` or `CONTROL_REQUIRED`, `mutation_state: NO_MUTATION`,
and `user_relay_count: 0`. Do not guess, rebase, or repair.

### R02 — unexpected implementation branch

Trigger: an unexpected existing implementation branch, ref, or worktree is found.
Result: `CONTROL_REQUIRED` returns to ACTIVE Control with no reset/delete. There is no reset/delete and
no ownership assumption.

### R03 — bound Worker unavailable

Trigger: the preferred or bound Worker is unavailable and substitution would be
needed. Result: `CONTROL_REQUIRED` requesting `REBIND_EXECUTOR`; no silent substitute,
no second Worker, and no user courier.

### R04 — ambiguous test failure

Trigger: a non-preauthorized test failure or uncertain root cause occurs. Result:
`CONTROL_REQUIRED` returns to Control before repair. The Worker does not choose repair scope or treat
the failure as authorization.

### R05 — newer malformed or conflicting authority

Trigger: a newer authority record is malformed or conflicts with an older parseable
record. Result: `FAIL_CLOSED` / `CONTROL_REQUIRED`; never use an older fallback and
never continue from a stale parse.

### R06 — Herdr semantic overreach

Trigger: Herdr would need to invent `BEST_NEXT`, choose repair scope, or make a
semantic routing decision. Result: `CONTROL_REQUIRED`; Herdr semantic authority is
`NONE` (semantic authority = NONE), so it only transports the minimal return pointer.

### R07 — exact return binding

Trigger: a local return is prepared. The record must bind `event_id`,
`idempotency_key`, `card_id`, `phase`, `generation`, `dispatch`, `head`, `branch`,
`problem_class`, `mutation_state`, and `last_known_safe_point` before delivery.
Missing binding is rejected before publication.

### R08 — duplicate return delivery

Trigger: the same return identity is delivered again. Result:
`NO_OP_DUPLICATE` with no second semantic decision, no second mutation, and no second
owner/user courier.

### R09 — Control response binding

Trigger: a Control response is received for a pending return. The response must bind
the exact return event and idempotency key before resume. A mismatched response is
rejected and execution remains stopped.

### R10 — Control transport failure

Trigger: Control-delivery transport failure occurs. Result: try only another admitted
deterministic route if applicable; otherwise publish/read back
`CONTROL_DELIVERY_BLOCKED_V1`. Transport failure never becomes user relay and never
grants semantic fallback authority; `user_relay_count: 0`.

### R11 — genuine human-only escalation

Trigger: a credential, payment/security consent, irreversible owner choice, unresolved
product/scope authority, or restoration of all Control-delivery routes is required.
Result: last-resort `HUMAN_REQUIRED`; no owner courier carries Worker/Reviewer result
text and `user_relay_count: 0` remains the normal path.

### R12 — Reviewer FIX_REQUIRED boundary

Trigger: a Reviewer emits `FIX_REQUIRED`. Result: return to ACTIVE Control and do
not silently route to a Worker. A repair is legal only through an explicitly
authorized deterministic edge bound by current Control; otherwise remain stopped.

## Role and review boundary

Worker READY is not integration, merge, release, canonical Skill adoption, or formal
review. A fresh independent Reviewer must read GitHub directly and publish its own
bound result. Reviewer `PASS` does not authorize merge/release; Reviewer
`FIX_REQUIRED`, `BLOCKED`, or `CONTROL_REQUIRED` returns to ACTIVE Control under
this protocol. No local Worker, Herdr coordinator, or Control transport may
impersonate the Reviewer.

## CONTROL_RETURN_AFTER_PASS

Fresh-review `PASS` is still a Control decision point. The Worker publishes the
ready evidence and stops; ACTIVE Control must bind the exact reviewed head before
acceptance or integration. A review result, terminal result, or successful canary
never authorizes the Worker or Herdr to merge, release, rotate, or choose a successor.
