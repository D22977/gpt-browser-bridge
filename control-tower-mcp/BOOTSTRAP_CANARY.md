# Control Tower Bootstrap Canary v1

Use this checklist whenever a NEW project, NEW control chat, NEW Control generation, or machine/runtime restart occurs.

## Inputs
- repo
- current pointer issue (or create one)
- intended Worker executor family
- intended formal Reviewer policy
- local runtime boundary

## Phase 1 — Authority
- read repository metadata
- read current pointer
- enumerate active cards and terminal receipts
- resolve superseded generations
- bind exact base/head/file-set identities where applicable

PASS only if the current legal state is unambiguous.

## Phase 2 — Worker wake admission
Inventory current local mechanisms before changing anything:
- Task Scheduler tasks
- Herdr/LUNA/worker-pull consumers
- launchers/runtime inboxes
- process/session identity
- heartbeat/last-liveness

Run one bounded no-product canary:
1. create/use a harmless read-only canary card;
2. dispatch through the admitted local wake mechanism;
3. require executor-authored `CONSUMED_STARTED`;
4. second wake while active => NO_OP;
5. restart/stale-heartbeat path rereads GitHub and resumes deterministically;
6. wrong target/protocol => BLOCKED / no action;
7. no legal work => NO_OP.

If no local actor can run the canary, state is `BLOCKED_BOOTSTRAP`; do not create more product cards.

## Phase 3 — Reviewer admission
Runtime-check the formal route required by the project.

For fresh Web Reviewer:
- NEW empty context/session
- no reuse of Worker or current Control context
- exact review request binding
- distinguish tab/context created, prompt sent, reviewer started, verdict published

Connector/CLI lanes may be independently admitted as advisory or formal only if project authority explicitly permits that identity.

## Phase 4 — Access and write boundary
- prove GitHub read for active executors
- prove deterministic bounded write/read-back path
- verify secrets absent from durable output
- verify no broad write authority was silently granted to read-only Worker lanes

## Phase 5 — Publish rehydration result
Publish exactly one:

```text
CONTROL_REHYDRATION_RESULT_V1
project: <repo>
control_generation: <id>
authority_state: PASS|BLOCKED|UNKNOWN
worker_wake_state: PROVEN_CURRENT|BLOCKED_BOOTSTRAP|UNKNOWN
worker_wake_mechanism: <exact mechanism|null>
worker_consume_canary_receipt: <id|null>
reviewer_transport_state: PROVEN_CURRENT|BLOCKED|ADVISORY_ONLY|UNKNOWN
formal_reviewer_route: <route|null>
github_access_state: PASS|BLOCKED|UNKNOWN
user_relay_target: 0
tracked_product_mutation: false
decision: READY_FOR_CONTROL|BLOCKED_WORKER_WAKE|BLOCKED_REVIEW_TRANSPORT|BLOCKED_AUTHORITY_AMBIGUITY|BLOCKED_ACCESS
```

Read the receipt back.

## Fanout gate
Normal card fanout is legal only after `READY_FOR_CONTROL` and at least one current genuine Worker consume proof.

Start with one lane. After it reaches `CONSUMED_STARTED`, enable parallel read-only/runtime lanes within the explicit mutation budget.

## Watchdog
If a dispatch remains only `DISPATCH_REQUEST_WRITTEN` beyond the configured liveness window:
- stop new dispatch
- do not wake-spam
- enter `WAKE_RECOVERY`
- diagnose scheduler/consumer/runtime liveness

## Handoff gate
Before rotating Control, publish a durable handoff containing current authority plus the capability manifest and last current canaries. The successor still reruns current runtime admission.

## PASS means
The Control can read the project truth, a local Worker can actually consume work without the user acting as courier, the Reviewer path is known, and durable writes can be read back.

PASS does not authorize merge, release, deployment, publication, or product-scope expansion unless separately granted.
