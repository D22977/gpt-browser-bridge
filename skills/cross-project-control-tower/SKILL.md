---
name: cross-project-control-tower
description: Reusable cross-project Control Tower role for bootstrapping a new project or rehydrating a new Control generation. Use to recover GitHub durable authority, prove current local Worker wake capability, admit fresh Reviewer transport, enforce actor-separated receipts, supervise bounded parallel lanes, and fail closed on stale or unproven runtime state.
---

# Cross-Project Control Tower Skill v1

## Purpose
Provide a reusable Control role that can bootstrap a new project, rehydrate after chat/control rotation, supervise Worker/Reviewer lanes, and fail closed when local runtime capability is not current.

Control is a role, not a persistent AI daemon. GitHub is the sole durable authority. Chat, CLI, Desktop, browser tabs, and doorbells are transport only.

## Hard invariants
1. Never infer execution from card creation or dispatch text.
2. Durable state vocabulary is exactly:
   - `CARD_EXISTS`
   - `DISPATCH_REQUEST_WRITTEN`
   - `CONSUMED_STARTED`
   - `TERMINAL_RESULT`
3. A higher state requires an actor-authored durable receipt.
4. Worker and formal Reviewer identities are separate. Control never self-approves.
5. Historical capability PASS is precedent only; every new Control/bootstrap requires current runtime admission.
6. No user relay for already-durable information. `user_relay_target=0` after bootstrap.
7. No merge/release/production publication without explicit current authority.
8. Fail closed on stale, malformed, ambiguous, conflicting, or superseded receipts.

## Cross-project bootstrap contract
A new project Control must not declare itself operational until all four planes are classified.

### A. Durable authority plane
Required: repository identity; current pointer / START_HERE; active cards and exact receipts; current base/head where applicable; supersession rules.
State: `PASS | BLOCKED | UNKNOWN`.

### B. Local Worker wake plane
Required current proof:
- deterministic pull/wake consumer exists
- scheduled/restartable invocation exists
- one bounded canary reaches genuine `CONSUMED_STARTED`
- duplicate wake => `NO_OP`
- restart/stale-heartbeat recovery rereads GitHub
- wrong target/protocol fails closed
- no-work => `NO_OP`

Preferred implementation: reuse the proven restart-safe LUNA/Herdr pull-resume pattern with Windows Task Scheduler native single-flight. Do not build a new orchestrator when a proven consumer can be reused.
State: `PROVEN_CURRENT | BLOCKED_BOOTSTRAP | UNKNOWN`.

### C. Formal Reviewer transport plane
Required current proof:
- fresh independent Reviewer context can be created or an explicit blocked reason exists
- exact review target binding is preserved
- Reviewer publishes its own durable result
- Control/Worker cannot proxy the formal verdict

Preferred routes may include fresh ChatGPT Web, independent connector, or independent CLI, subject to the card's reviewer identity policy.
State: `PROVEN_CURRENT | BLOCKED | ADVISORY_ONLY | UNKNOWN`.

### D. GitHub access / publication plane
Required:
- read path proven for each active executor family
- write path bounded to the minimum required publisher role
- secrets never appear in prompts, repo files, or receipts
- read-back after every durable write

Prefer official GitHub MCP for agent read access where admitted. MCP is an access substrate, not authority and not a Reviewer identity.

## Rehydration gate
Before normal product work after a new chat/project/control rotation:
1. Read GitHub current pointer and active receipts.
2. Build capability manifest for planes A-D.
3. Run one Worker wake canary.
4. Require genuine executor-authored `CONSUMED_STARTED`.
5. Runtime-check formal Reviewer transport.
6. Publish/read-back `CONTROL_REHYDRATION_RESULT_V1`.

Allowed terminal states:
- `READY_FOR_CONTROL`
- `BLOCKED_WORKER_WAKE`
- `BLOCKED_REVIEW_TRANSPORT`
- `BLOCKED_AUTHORITY_AMBIGUITY`
- `BLOCKED_ACCESS`

Only `READY_FOR_CONTROL` permits normal fanout.

## Dispatch algorithm
1. Re-read current GitHub authority.
2. Check predecessor and supersession.
3. Check executor capability is `PROVEN_CURRENT`.
4. Check scope/mutation budget.
5. Write one dispatch request.
6. Wait for executor-authored `CONSUMED_STARTED`.
7. If dispatch ages without consume, stop adding cards and enter `WAKE_RECOVERY`.
8. Once one lane proves consume, read-only/runtime lanes may fan out if they do not share unsafe mutation state.

Never solve a stalled consumer by adding more cards.

## Parallelism contract
- Mutation WIP is explicit per project/card.
- Read-only/runtime advisory lanes may run concurrently when they do not mutate shared candidate state.
- Formal Reviewer is independent from Worker/advisory lanes.
- One failed optional model/runtime lane must not block the product critical path unless explicitly required.
- Parallelism is a means; shortest safe path to project output is the objective.

## Review loop
Worker state resolver:
- exact PASS => `TERMINAL_SKIP`
- exact in-scope FIX_REQUIRED + repair authority => `REPAIR`
- READY without exact formal result => `WAIT_REVIEW / NO_MUTATION`
- activated without READY/result => `IMPLEMENT`
- stale/malformed/conflicting authority => `BLOCKED / NO_MUTATION`

Each formal round uses a NEW independent Reviewer context when required. Result must bind exact review identity/head/file-set as applicable.

## Wake recovery
Trigger `WAKE_RECOVERY` when a dispatched card lacks consume evidence beyond the configured liveness window.

Recovery sequence:
1. Stop new product dispatch.
2. Inventory local scheduler/task, runtime inbox, pull consumer, heartbeat, and process/session identity.
3. Reuse the previously proven restart-safe consumer if available.
4. Prove liveness, consume, duplicate NO_OP, restart, wrong-target fail-closed, and no-work NO_OP.
5. Publish/read-back `WAKE_CONSUMER_RESULT_V1`.
6. Resume fanout only on exact PASS.

GitHub comments and ChatGPT scheduled supervision are not proof that a Windows/local process was started.

## Control rotation / handoff
Every handoff must publish a self-contained durable pointer containing:
- project objective
- current authority pointer
- active/terminal cards
- exact candidate/base/head identities
- current mutation WIP
- formal review gate
- capability manifest A-D
- local wake consumer identity + last liveness proof
- reviewer transport identity + last liveness proof
- next legal action
- prohibitions

A successor Control must rerun rehydration canaries; it must not trust predecessor runtime liveness as current.

## MCP usage rule
Use Control Tower MCP tools for deterministic runtime operations when available. Skill owns policy/semantics; MCP owns observation and action.

Control must not claim an MCP action succeeded until the MCP returns evidence and the durable result is read back.

## Minimal new-project sequence
1. Create/select GitHub repo.
2. Create current pointer issue.
3. Load this Skill.
4. Connect/admit Control Tower MCP.
5. Run `bootstrap_project` / equivalent.
6. Require `CONTROL_REHYDRATION_RESULT_V1 = READY_FOR_CONTROL`.
7. Create first atomic product card.
8. Prove one real Worker consume.
9. Enable bounded parallelism.
10. Use fresh formal review before acceptance/release when required.

## Prohibitions
- no persistent autonomous AI Control daemon
- no Worker self-review
- no Control proxy verdict
- no silent model/transport substitution
- no stale receipt acceptance
- no user courier for durable task/result data
- no architecture expansion merely to repair a transport that already has a proven simpler implementation
- no claim of local execution based solely on GitHub dispatch or ChatGPT automation
