# GitHub authority Control loop

This is a code candidate for the generation-bound resident core. Runtime activation is a separate Control decision after fresh exact-head review. This candidate starts no process, scheduler, webhook, workflow, or transport adapter and publishes no live generation lease.

## Responsibilities

| Part | Responsibility |
| --- | --- |
| GitHub | Sole semantic record: active Control authority, source events, lease, heartbeat, wake request, Control ACK, and later Control decision. Every transition is reconstructed from receipts. |
| Local resident | Deterministic `runOnce` over a GitHub client. It validates the current generation, exact Control identity, one live lease, source binding, and receipt readback. It does not choose the next project task. |
| Wake transport | An injected callback receives only `{source_repo, source_issue, source_comment_id, wake_request_comment_id}` after the wake request is published and read back. Delivery, failure, or timeout is diagnostic only. |
| WebGPT Control | Rehydrates the current start, registry, active switch, and source from GitHub, then publishes an exact `ACTIVE_CONTROL_WAKE_ACK_V1` and reads it back. An ACK records wake consumption; a later bound Control decision/card alone can release a named executor. |

The existing issue-comment workflows are historical task-specific transport adapters. Webhook or Actions success can trigger an iteration; it is never a semantic progress receipt. The optional UI selector lane is deferred and does not block this GitHub authority core.

## Injected GitHub client

`runOnce({ github, transport, residentInstanceId, triggerContractHash, now })` expects:

- `readAuthority()` to return the current generation, exact active Control conversation identity, current start receipt ID, current registry receipt ID, active switch receipt ID, and `switch_conflict: false`, all derived from current GitHub receipts. A newer or conflicting switch must set a conflict or change these bindings.
- `listReceipts()` to return the relevant parsed GitHub receipts, each with `github_comment_id`; `getReceipt(id)` to fetch that exact comment for readback.
- `listSourceEvents()` to return current GitHub source events with repository, issue, comment ID, event type, generation, Control identity, and `named_executor` for terminal or control-needed events.
- `publishReceipt(receipt)` to append one GitHub comment and return its comment ID. The core directly fetches it by ID and compares every published field before proceeding.

The adapter must fetch complete relevant issue-comment pages and parse receipts without substituting a local cache, process state, stdout, workflow status, or browser state. A local cursor may reduce repeated API reads only; `runOnce` never consumes it as authority. `now` comes from the runtime clock for expiry checks and grants no semantic timeout.

## Protocol

1. `createLease` produces `LOCAL_CONTROL_RESIDENT_LEASE_V1` with deterministic lease ID, owner, generation, Control conversation ID, acquired/expiry times, watched issue set, contract hash, idempotency key, and `readback_required: true`. The runtime admission layer must publish/read back the lease separately. `validateLease` rejects expired, future, stale, or conflicting unexpired leases. `runOnce` requires exactly one current lease owned by its resident instance and reads the lease by GitHub comment ID.
2. `createHeartbeat` produces `LOCAL_CONTROL_RESIDENT_HEARTBEAT_V1`. A runtime layer must publish/read back the heartbeat separately. `watcherRunning` returns true only for the exact current lease, owner, generation, contract, expiry, and a heartbeat within the chosen freshness window. Code availability or a running process alone never proves monitoring.
3. `runOnce` reads current GitHub authority, receipts, and source events. It forms a deterministic `LOCAL_CONTROL_WAKE_REQUEST_V1` for one watched source. An existing exact request returns `NO_OP_DUPLICATE` without another transport call. A new request is published, fetched by ID, and checked for duplicates before the injected transport is called. The authority is read again before notification.
4. The source remains `WAIT_CONTROL_ACK` or, for terminal/control-needed events, `WAIT_CONTROL_DECISION` regardless of transport result. Exact `ACTIVE_CONTROL_WAKE_ACK_V1` binding to the wake, source, generation, Control identity, and current start/registry/switch receipts must be present and fetched from GitHub before wake consumption is reported.
5. A terminal/control-needed source remains in `WAIT_CONTROL_DECISION` after ACK. Only a later, read-back `ACTIVE_CONTROL_SOURCE_DECISION_V1` bound to the wake request, source, ACK comment, current generation/Control identity, and exact `named_executor` yields `RELEASED_TO_NAMED_EXECUTOR`. The return value is a pointer for a separately authorized runtime adapter; this module launches nothing. Action or transport timeouts never release the wait.

Restarting with an empty local cache reconstructs these states from GitHub. Duplicate ACKs return `NO_OP_DUPLICATE` with the same semantic wait. Conflicting receipts fail closed. A completed source does not prevent the next source from being considered.

GitHub issue comments do not provide an atomic compare-and-swap operation. The activation layer must admit one resident instance per contract and prevent concurrent iterations by that instance; if competing receipts appear, this core stops before treating them as authority. Runtime activation, lease publication, heartbeat scheduling, webhook wiring, and any wake adapter require their own later Control gate.
