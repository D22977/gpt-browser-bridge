# Control Tower Handoff — User Guide

Status: CANDIDATE handoff guide. This file explains the handoff procedure in plain language. It does not replace live GitHub authority, `HANDOFF.md`, `CONTROL_HANDOFF_PROTOCOL.md`, or the canonical Skill.

## What the user should expect during a Control handoff

A handoff is successful only when a fresh Control can reconstruct the current project state directly from GitHub without asking the owner to repeat history or courier prompts/results.

The ACTIVE Control generation does not change merely because a handoff test is run, a page title changes, or a new conversation is opened. Rotation requires a separate durable generation-switch authority and read-back.

## Normal handoff procedure

1. Read the newest `CURRENT_START_HERE` receipt from GitHub.
2. Read the latest ACTIVE Control generation/switch and bind the exact conversation identity from durable authority, never from tab/page title alone.
3. Read the current task/card, active work, Worker/Reviewer/PR/head state, and exact BEST_NEXT blocker or successor.
4. Read the canonical Control Skill identity and strongest exact PASS / PROVEN_BOUNDED capability evidence needed by the current task.
5. Read the short `REPEAT_ERROR_INDEX` in `HANDOFF.md`.
6. If the current symptom matches a repeat-error signature, read only the matching detailed entry in `archive/REPEAT_ERROR_G8_7X.md`; do not replay the whole failure archive.
7. Before the first tracked mutation or other high-risk transition, resolve the registered implementation/path, current failure layer, recurrence level, forbidden prior recovery, and required prevalidation.
8. Publish/read back `CONTROL_REHYDRATION_REPEAT_ERROR_ACK_V1`. Without this ACK, high-risk mutation is not legal.
9. Execute only the current bounded BEST_NEXT action. If any authority, identity, scope, or validation fact is unresolved, fail closed and return to ACTIVE Control.

## The three permanent repeat-error signatures

### RE-001 — REGISTERED_IMPLEMENTATION_CONFUSION

Do not infer the current implementation from a similar filename, commit message, old workflow, display title, or remembered path. Resolve the exact registered path + durable authority + current blob/head + historical PASS before repair.

### RE-002 — WORKFLOW_ZERO_JOB_WITHOUT_PREVALIDATION

GitHub default must never be the first workflow parser. A workflow/config mutation requires independent syntax/structure validation before the one legal push. A `failure` with `jobs=0` stops diagnosis at workflow configuration/admission; it does not justify runner/Herdr/browser repair.

### RE-003 — STALE_REHYDRATION_OR_LAYER_SKIP

Immediately before a decision or mutation, reread `CURRENT_START_HERE`, the ACTIVE generation switch, active work, and exact branch/head. Diagnose upstream to downstream. Missing runtime evidence is not capability absence.

## Mandatory pre-mutation ACK

Before the first tracked mutation, workflow/transport repair, wake/rebind/restart/replay, Worker/Reviewer dispatch, merge, or other high-risk transition, the fresh Control must durably bind at least:

```text
CONTROL_REHYDRATION_REPEAT_ERROR_ACK_V1
control_generation: <current ACTIVE generation>
current_switch: <exact receipt>
current_start_here: <exact receipt>
current_task_or_card: <exact identity>
repeat_error_index_read: true
matching_signature: <RE-001 | RE-002 | RE-003 | NONE>
recurrence_level: <LESSON | REPEAT_ERROR | PROCESS_CONTROL_FAILURE | NONE>
registered_implementation: <exact path/blob/head or NOT_APPLICABLE>
failure_layer: <exact layer or NONE>
forbidden_prior_recovery: <exact mechanism or NONE>
required_prevalidation: <exact gate or NONE>
first_high_risk_mutation_allowed: true|false
readback_required: true
```

If any required field cannot be resolved, `first_high_risk_mutation_allowed` must be `false`.

## Recurrence policy

- First verified occurrence: `LESSON` — record the error and add a regression.
- Second verified occurrence: `REPEAT_ERROR` — the same recovery mechanism is prohibited.
- Third or later verified occurrence: `PROCESS_CONTROL_FAILURE` — the whole error class fails closed until the guard itself has mechanical acceptance evidence.

The generation008 seven-incident recurrence record is maintained in `archive/REPEAT_ERROR_G8_7X.md`.

## Where to look when something is wrong

Use this order and do not skip layers:

```text
CURRENT AUTHORITY / FRESHNESS
-> REGISTERED IMPLEMENTATION / WORKFLOW ADMISSION
-> GITHUB EVENT / RUN CREATION
-> JOB / RUNNER
-> HERDR / LOCAL TRANSPORT
-> BROWSER / SESSION
-> SEMANTIC CONTROL ACK
```

If a higher layer is not proven, do not repair a lower layer.

## Files and their purpose

- `HANDOFF_USER_GUIDE.md` — this plain-language owner/operator guide.
- `HANDOFF.md` — mandatory cold-start navigation and repeat-error gate.
- `CONTROL_HANDOFF_PROTOCOL.md` — detailed protocol/state machine and negative gates.
- `FAILURE_ARCHIVE.md` — diagnostic archive, default-excluded except for matching signatures.
- `archive/REPEAT_ERROR_G8_7X.md` — detailed seven-incident recurrence evidence and permanent guard rules.

## Generation009 regression meaning

A Generation009-style handoff regression means a fresh-context reader must be able to reconstruct the current state using GitHub only and satisfy the repeat-error ACK contract. It is not itself a Control rotation. The current generation remains ACTIVE until a separate durable generation switch is authorized and committed.
