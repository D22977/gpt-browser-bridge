# Control Tower Success Evidence Index

Status: CANDIDATE companion to the admitted Control Tower skill. This index exists to make successful, still-valid routes the default evidence path during rehydration and dispatch.

## Rule

Read this index before historical failures. For an active task, load only the exact success/proven receipt needed for the claim. Do not re-run a capability canary merely because runtime liveness is unknown or because an older failure exists.

A success receipt remains bounded by its executor, surface, task class, repo/card scope, and explicit restrictions. Reuse does not expand authority.

## Core durable success/proven evidence

### Canonical Control Tower contract

- repo: `D22977/gpt-browser-bridge`
- path: `skills/control-tower/SKILL.md`
- admitted base head when this candidate was created: `50cd14c941072de5ea04690f286683c05eac1d81`
- admitted base blob: `babbb3f704b852f499d96d2cb1ac7493e71cc851`
- meaning: consolidated Control Tower v3 contract, including evidence reuse, role separation, stale-handoff handling, generation rotation, exactly-once publication, and local-adapter fail-closed behavior.

### Evidence reuse standard

- `D22977/gpt-browser-bridge#81` receipt `5343071985`
- capability class: governance/evidence reuse standard
- proven rule: search still-valid success evidence before opening new admission/discovery work; unknown current liveness does not erase bounded capability proof.

### Desktop -> fresh ChatGPT Web transport

- `D22977/gpt-browser-bridge#83` receipt `5252595723` — `ACCESS_CAPABILITY_CHECK_V1`
- `D22977/gpt-browser-bridge#83` receipt `5252645117` — `WEBGPT_WAKE_TRANSPORT_RESTORE_RESULT_V1 / PASS`
- executor/surface: `CODEX_DESKTOP_AGENT_RUNTIME_OPERATOR / DESKTOP`
- mechanism: Codex app-managed In-app Browser / isolated `NEW_CONVERSATION_EMPTY` ChatGPT Web context
- capability class: `PROVEN_BOUNDED`
- proven properties: fresh WebGPT context, exactly-once wake, GitHub-only rehydration, durable GitHub result, no user relay, no product mutation.
- reuse rule: do not ask CLI/API/Herdr lanes to re-prove this Desktop-only surface. At actual use, check only current liveness/target binding; if needed, at most one bounded restore of the same proven route.

### Restart-safe GitHub pull/wake

- `D22977/gpt-browser-bridge#62`
- `D22977/gpt-browser-bridge#65`
- capability class: proven restart/resume pattern
- proven rule: GitHub is durable task channel; restart/wake rereads current authority rather than relying on process memory.

### External reviewer self-publication / provenance

- `D22977/gpt-browser-bridge#50` receipt `5230984658`
- capability class: external review governance
- proven rule: independent reviewer reads GitHub directly and self-publishes its own exact-bound result; Control/transport must not proxy the formal verdict.

### Review result idempotency / recovery consumption

- `D22977/gpt-browser-bridge#45` receipt `5230668817`
- `D22977/gpt-browser-bridge#46` receipt `5230774418`
- capability class: exactly-once review result / bound recovery consumption
- proven rule: duplicate/stale results fail closed; exact binding is mandatory.

### Control generation rotation / rehydration

- `D22977/gpt-browser-bridge#88` receipt `5439994646` — `CONTROL_GENERATION_SWITCH_V1`
- capability class: Control generation switch
- proven rule: new Control is not ACTIVE until exact handoff/rehydration gates pass and the later atomic switch receipt is published/read back.

## Derived-project success evidence currently relevant to CAD/P&ID reconstruction

These are project-specific and must not be generalized outside their stated scope.

### CAD local Herdr binding

- `D22977/cad-pid-reconstruction#19` terminal receipt `5452655957`
- result: `PASS_CAD_BINDING_RESTORED`
- scope: bounded local CAD Herdr runtime/config execution
- restriction: not a formal Reviewer substitute and not proof of Desktop browser transport.

### CAD source cross-check

- `D22977/cad-pid-reconstruction#15` terminal receipt `5452901622`
- result: source-to-candidate geometry/text cross-check completed with advisories only; no blocking candidate geometry defect reported.
- restriction: read-only advisory, not formal review.

### CAD visual preparation

- `D22977/cad-pid-reconstruction#12` terminal result: `ADVISORY_FINDINGS_PRESENT`, blocking findings none
- meaning: preliminary render is usable for review; full-sheet warning text becomes small at overall zoom.
- restriction: advisory visual QA, not formal review.

### CAD Control generation 002

- `D22977/cad-pid-reconstruction#3` receipt `5453837257` — `CADPID_CONTROL_002_REHYDRATION_RESULT_V1 / PASS`
- `D22977/cad-pid-reconstruction#3` receipt `5453887915` — `CONTROL_GENERATION_SWITCH_V1 / SWITCH_PASS`
- result: `cad-pid-reconstruction-控制塔-002 = ACTIVE`; 001 retired.
- proven property: fresh Web Control reconstructed correct state from GitHub without being misled by stale project `HANDOFF.md`, pending local adapter sync, old transport blockers, or chat memory.

### CAD evidence reuse / skill handoff correction

- `D22977/cad-pid-reconstruction#3` receipt `5454020442`
- rule: do not re-prove the already durable #83 Desktop -> fresh-WebGPT capability for Issue #7; verify only canonical Web Skill vs local adapter handoff when needed.

## Selection rule

When a task needs a capability:

1. find the narrowest success entry matching exact executor + surface + task class;
2. read its exact durable receipt;
3. confirm no newer durable invalidation exists;
4. perform only task-time liveness/target binding if required;
5. do not open the failure archive unless a current failure or review question actually needs historical diagnostics.
