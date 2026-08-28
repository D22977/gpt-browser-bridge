# Control Tower Failure Archive

Status: CANDIDATE diagnostic archive. **Do not read this file during normal rehydration or capability selection.**

## Default exclusion rule

Archived failures are retained for auditability, root-cause analysis, and external review lineage, but they are excluded from the normal Control reading path.

Open only the exact relevant archived entry when at least one is true:

1. the current task produces the same error signature on the same executor/surface;
2. a fresh independent reviewer explicitly requires historical lineage;
3. a success/correction receipt explicitly points back to the failure for comparison;
4. the owner explicitly asks to inspect historical failures.

Never use an archived failure to infer current capability absence when a newer exact success/correction exists for the relevant executor/surface/task class.

Never create a new Router, admission card, capability canary, or repair merely because an archived failure exists.

## Archived / superseded records

### FA-001 — fixed CDP endpoint unavailable during old WebGPT wake path

- historical source: `D22977/gpt-browser-bridge#83` receipt `5252554961`
- symptom: configured `127.0.0.1:9225` route returned `CONNECTION_REFUSED`
- classification: historical runtime-path failure
- superseded_by:
  - `D22977/gpt-browser-bridge#83` receipt `5252595723` — app-managed IAB route `PROVEN_BOUNDED`, runtime reachability PASS
  - `D22977/gpt-browser-bridge#83` receipt `5252645117` — restore result PASS and exactly-once fresh WebGPT wake
- current rule: do not retry fixed-CDP proof merely because this failure exists; use the proven app-managed Desktop route when task-applicable.

### FA-002 — CAD Review Router / CLI surface reported IAB unavailable

- historical source: CAD diagnostic route associated with `D22977/cad-pid-reconstruction#13`
- symptom: `CODEX_API_AGENT / Herdr CLI` reported browser/IAB unavailable
- classification: wrong-executor-surface diagnostic, not Desktop capability invalidation
- superseded_by:
  - `D22977/cad-pid-reconstruction#3` receipt `5453135973` — `CONTROL_REVIEW_TRANSPORT_REUSE_CORRECTION_V1`
  - GBB #83 success receipts `5252595723` + `5252645117`
  - CAD correction receipt `5454020442`
- current rule: do not repair/re-run #13 as Router work. A CLI/API failure must not be used to disprove the proven Desktop app-managed browser route.

### FA-003 — old Issue #7 transport status with no prompt sent

- historical source: `D22977/cad-pid-reconstruction#7` receipt `5450391991`
- symptom: `prompt_sent=false`, reviewer not started, no terminal verdict
- classification: superseded delivery-status snapshot
- superseded_by:
  - owner send confirmation `D22977/cad-pid-reconstruction#3` receipt `5452923535`
  - transport reuse correction `5453135973`
  - Control 002 evidence-reuse correction `5454020442`
- current rule: do not ask the owner again and do not infer that the formal review capability is unproven from this old snapshot.

### FA-004 — DeepSeek Flash Free unavailable

- historical source: `D22977/cad-pid-reconstruction#17` receipt `5452707104`
- result: `BLOCKED_NO_ELIGIBLE_FREE_ROUTE`
- classification: optional runtime/model-route failure
- superseded/current disposition: nonblocking for CAD critical path; no paid fallback authorized by that card
- current rule: do not let this model-route failure block CAD, Control handoff, or formal Web review work when another admitted lane exists.

### FA-005 — stale project HANDOFF.md claims

- historical file: `D22977/cad-pid-reconstruction/HANDOFF.md` blob `04843d7b5d97bc64c5e8d720c3349da4aad9a483`
- stale claims: Phase 0; CAD not started; `WAIT_USER_SCOPE_CONFIRMATION`; ask owner before preliminary generation
- classification: `STALE_POINTER_ONLY`
- superseded_by:
  - CAD-first owner priority `D22977/cad-pid-reconstruction#3` receipt `5449555714`
  - candidate `ed50890bc783a05b162120b84f5a21c5424ebf44`
  - Control 002 rehydration `5453837257`
  - generation switch `5453887915`
- current rule: project HANDOFF remains a navigation pointer only until legally refreshed; stale claims do not override current durable GitHub authority.

## Pending is not failure

Do not place unresolved-but-not-terminal work in this archive merely because it is incomplete. Example:

- `D22977/gpt-browser-bridge#97` local Control adapter synchronization is currently `DISPATCH_REQUEST_WRITTEN` only. It is `NOT_ADMITTED_PENDING_SYNC`, not a terminal failure. Canonical GitHub bytes remain usable directly by Web Control.

## Archive handling

Each future archived entry should include:

- archive ID;
- exact repo-qualified receipt/file identity;
- executor/surface;
- error signature or stale claim;
- classification;
- exact `superseded_by` receipt(s), if any;
- current rule explaining why normal Control should not select it as present authority.
