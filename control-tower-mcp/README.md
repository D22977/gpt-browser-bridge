# Control Tower MCP v1 — Runtime Contract

## Why MCP exists
The Control Tower Skill defines policy and reasoning. The MCP exposes deterministic runtime capabilities so Control can observe and act without pretending that GitHub comments or chat text started a local process.

This MCP is cross-project infrastructure. It must not contain project-specific product logic.

## Architectural role
- GitHub = durable authority
- Control Tower Skill = semantic policy / state machine
- Control Tower MCP = deterministic observation + runtime actuation
- Herdr/LUNA/OpenCode/Codex = executors
- fresh Reviewer = independent review identity

MCP is transport/capability infrastructure, not authority and not a Reviewer identity.

## Required tool surface

### Project bootstrap
`bootstrap_project(repo, current_pointer_issue?)`
Returns:
- repo identity/default branch
- current pointer candidates
- active card summary
- capability manifest skeleton
- no writes unless explicitly requested

### Durable authority
`read_control_state(repo, pointer)`
- reread current durable pointer
- resolve supersession
- return exact receipt ids / base/head identities

`write_receipt(repo, issue, protocol, payload)`
- bounded durable write
- automatic read-back
- return exact receipt id

### Worker wake/runtime
`inspect_worker_wake()`
Returns current inventory of:
- Windows Task Scheduler tasks
- known Herdr/LUNA/worker-pull launchers
- runtime inboxes
- process/session identity
- heartbeat/last liveness evidence

`wake_worker(target, card, idempotency_key)`
- use only an admitted deterministic wake mechanism
- never infer start from enqueue
- return dispatch transport evidence only

`run_worker_wake_canary(target)`
Must prove:
- liveness
- genuine executor-authored `CONSUMED_STARTED`
- duplicate => NO_OP
- restart-safe reread
- wrong-target fail-closed
- no-work => NO_OP

`worker_status(target)`
- distinguishes DISPATCH_REQUEST_WRITTEN from CONSUMED_STARTED/TERMINAL_RESULT

### Reviewer transport
`inspect_reviewer_routes()`
- runtime-check fresh WebGPT / connector / CLI reviewer transports
- historical PASS is not current liveness proof

`launch_fresh_reviewer(review_request)`
- creates a NEW independent context/session when required
- binds exact review identity/head/file-set
- returns prompt_sent / started evidence separately

### Parallel execution
`dispatch_batch(cards)`
Preconditions:
- at least one current Worker wake canary PASS
- every card is independently legal
- explicit mutation_wip budget

Must never turn batch enqueue into execution claims.

### Liveness / recovery
`recover_wake_consumer()`
- inventory first
- prefer reuse of proven #62/#65 restart-safe pull/resume mechanism
- Windows Task Scheduler native single-flight preferred
- no new orchestrator unless reuse is impossible and separately authorized

`self_test()`
Runs bootstrap canaries without product mutation.

## Capability manifest schema
Each new Control/bootstrap must publish current observations for:

```yaml
control_tower_capabilities:
  durable_authority:
    state: PASS|BLOCKED|UNKNOWN
    evidence: []
  worker_wake:
    state: PROVEN_CURRENT|BLOCKED_BOOTSTRAP|UNKNOWN
    mechanism: null
    last_canary_receipt: null
  reviewer_transport:
    state: PROVEN_CURRENT|BLOCKED|ADVISORY_ONLY|UNKNOWN
    formal_route: null
    advisory_routes: []
  github_access:
    state: PASS|BLOCKED|UNKNOWN
    read_mechanism: null
    write_mechanism: null
```

## Mandatory bootstrap canary
A new project/control rotation is not operational until:
1. durable authority read succeeds;
2. Worker wake plane is current;
3. one executor-authored `CONSUMED_STARTED` is observed;
4. duplicate wake is NO_OP;
5. restart/stale-heartbeat recovery is proven or current proven reusable consumer is re-admitted;
6. Reviewer route is current or explicitly blocked;
7. `CONTROL_REHYDRATION_RESULT_V1` is published/read back.

## Security and permission model
- least privilege by actor
- Worker GitHub access read-only by default
- publication/write can be delegated to a deterministic publisher
- never expose credentials/secrets in prompts, receipts, logs, or repo files
- no cross-executor browser-profile/session theft
- no hidden paid-model fallback

## Proven mechanisms to reuse
This design intentionally reuses existing evidence:
- GBB #62 restart-safe Desktop/LUNA wake-resume consumer pattern
- GBB #65 `WORKER-PULL-00`, activated by `EXECUTE_ON_NEXT_PULL_WAKE` and reaching READY
- Windows `GPT_BROWSER_BRIDGE_RESUME` scheduled task / `resume.ps1` smoke: five-minute wake, stale-heartbeat restart, duplicate-safe supervisor
- GBB #83 fresh WebGPT app-managed isolated fresh-tab transport
- GBB #40 independent Connector Reviewer probe
- GBB #41 independent CLI Reviewer probe

## Explicit non-goals
- not a persistent reasoning daemon
- not autonomous architecture authority
- not an auto-merge service
- not a replacement for formal Reviewer identity
- not a generic multi-agent framework
- not a second source of project truth

## Recommended deployment
Install one local Control Tower MCP service per workstation/runtime boundary, not per project. Project-specific configuration should be declarative: repo, pointer issue, executor bindings, allowed runtime roots, and reviewer policy.

A new project should need only:
1. repo URL/name
2. current pointer issue creation
3. executor binding
4. bootstrap canary
5. first atomic card
