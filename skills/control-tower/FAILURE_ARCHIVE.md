# Control Tower Failure Archive

Status: CANDIDATE diagnostic archive. Default-excluded from normal rehydration and capability selection.

## Default exclusion rule

Archived records are retained for auditability, matching diagnostics, reviewer lineage, and explicit owner requests. Do not read this file during normal handoff. Open only the exact entry when the current error signature matches the same executor/surface, an independent reviewer requires historical lineage, a current success/correction receipt points to it, or the owner explicitly requests it.

Never use an archived record to infer current capability absence when a newer exact success or correction exists. Never create a Router, admission card, capability canary, wake service, reviewer queue, or repair merely because an archived record exists.

## Mutable lifecycle freshness

Every mutable lifecycle reference in this archive is historical evidence only. Before using a status as current, require all of:

- observed_identity: exact repository-qualified issue/PR/card/branch/head or receipt identity;
- observed_time: the source time when it is available;
- live_reread_required: true when the source time is unavailable or the status can change;
- current-use rule: a live GitHub reread must win over this archived snapshot.

A receipt identity alone proves what that receipt said; it does not freeze a branch, card, review, or runtime state. If the identity or time cannot be bound, use the record only as historical context and fail closed for current-state decisions.

## Archived / superseded records

### FA-001 — fixed CDP endpoint unavailable during old WebGPT wake path

- historical_source: D22977/gpt-browser-bridge#83 receipt 5252554961
- symptom: configured 127.0.0.1:9225 route returned CONNECTION_REFUSED
- classification: historical runtime-path failure
- superseded_by: D22977/gpt-browser-bridge#83 receipt 5252595723 and receipt 5252645117
- current_rule: do not retry fixed-CDP proof merely because this record exists; use the admitted bounded Desktop route only when its exact current target/liveness is bound.
- live_reread_required: true

### FA-002 — CAD Review Router / CLI surface reported IAB unavailable

- historical_source: D22977/cad-pid-reconstruction#13
- symptom: CODEX_API_AGENT / Herdr CLI reported browser/IAB unavailable
- classification: wrong-executor-surface diagnostic, not Desktop capability invalidation
- superseded_by: D22977/cad-pid-reconstruction#3 receipt 5453135973; GBB #83 receipts 5252595723 and 5252645117; CAD correction receipt 5454020442
- current_rule: do not repair or rerun #13 as Router work. A CLI/API failure cannot disprove the admitted Desktop transport route.
- live_reread_required: true

### FA-003 — old Issue #7 transport status with no prompt sent

- historical_source: D22977/cad-pid-reconstruction#7 receipt 5450391991
- symptom: prompt_sent=false, reviewer not started, no terminal verdict
- classification: superseded delivery-status snapshot
- superseded_by: D22977/cad-pid-reconstruction#3 receipts 5452923535 and 5453135973; Control correction 5454020442
- current_rule: do not infer current review capability from this old delivery snapshot.
- live_reread_required: true

### FA-004 — DeepSeek Flash Free unavailable

- historical_source: D22977/cad-pid-reconstruction#17 receipt 5452707104
- result: BLOCKED_NO_ELIGIBLE_FREE_ROUTE
- classification: optional runtime/model-route failure
- disposition: nonblocking for the CAD critical path; no paid fallback is authorized by that card
- current_rule: do not let this model-route failure block another admitted lane.
- live_reread_required: true

### FA-005 — stale project HANDOFF.md claims

- historical_file: D22977/cad-pid-reconstruction/HANDOFF.md blob 04843d7b5d97bc64c5e8d720c3349da4aad9a483
- stale_claims: Phase 0; CAD not started; WAIT_USER_SCOPE_CONFIRMATION
- classification: STALE_POINTER_ONLY
- superseded_by: CAD-first owner priority D22977/cad-pid-reconstruction#3 receipt 5449555714; candidate ed50890bc783a05b162120b84f5a21c5424ebf44; Control 002 rehydration 5453837257; generation switch 5453887915
- current_rule: project HANDOFF remains a pointer only until legally refreshed; stale claims do not override current durable authority.
- live_reread_required: true

## Current lifecycle correction — #97

The current exact terminal for D22977/gpt-browser-bridge#97 is:

- source: Issue #97 comment 5454371697
- protocol: CONTROL_TOWER_LOCAL_ADAPTER_SYNC_RESULT_V1
- state: NO_OP_NO_LOCAL_ADAPTER_FOUND
- observed_identity: D22977/gpt-browser-bridge#97 comment 5454371697
- observed_time: not supplied by the source receipt
- live_reread_required: true
- meaning: no bound local gbb-control-tower adapter was found under the examined roots; no write occurred. This is an allowed no-adapter mode when canonical GitHub bytes are used directly. It is not a request to create an adapter and does not block direct canonical Skill use.

The terminal #97 record replaces any earlier lifecycle wording. Do not treat #97 as pending, incomplete, or a current failure merely because local synchronization was not performed.

## Archive handling contract

Every future record must include an archive ID, exact repo-qualified receipt or file identity, executor/surface, exact error or stale claim, classification, superseded_by receipts when applicable, current selection rule, and the observed identity/time or live_reread_required rule. The archive remains default-excluded.
