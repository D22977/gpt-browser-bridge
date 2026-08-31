# Generation008 Repeat-Error Record — Seven Verified Recurrences

Status: CANDIDATE diagnostic record. This file is not current execution authority. It is read only when `HANDOFF.md` repeat-error matching selects one of the signatures below or when the owner/reviewer requests the recurrence evidence.

## Summary

Verified recurrence count: **7**

Severity: **PROCESS_CONTROL_FAILURE**

Root pattern:

```text
runtime/binding/liveness uncertainty
-> misclassification or stale identity
-> repair/rebuild or downstream diagnosis before proving the upstream layer
```

Permanent invariant:

> Historical PROVEN / PROVEN_BOUNDED capability must never be reconstructed merely because current liveness, session, transport, endpoint, binding, or delivery evidence is missing. Diagnose -> reuse -> restart -> rebind -> bounded repair first. Rebuild requires positive evidence that the existing proven path is unusable, not merely unavailable.

## Permanent signatures

### RE-001 — REGISTERED_IMPLEMENTATION_CONFUSION

Trigger examples:
- similarly named workflow treated as the registered production implementation;
- commit message or remembered path used instead of durable registration identity;
- page/tab/display title used as Control identity evidence.

Required gate:
- resolve exact registered path;
- bind durable registration authority;
- bind current blob/head;
- bind historical PASS / PROVEN evidence when applicable;
- enumerate known duplicate/historical paths as non-authoritative.

Forbidden recovery:
- mutate or diagnose a similarly named duplicate as if it were production;
- infer current registered implementation from a commit message or UI title.

### RE-002 — WORKFLOW_ZERO_JOB_WITHOUT_PREVALIDATION

Trigger examples:
- tracked workflow mutation is pushed before independent syntax/structure validation;
- GitHub default is used as the first parser;
- `failure` + `jobs=0` is followed by runner/Herdr/browser diagnosis.

Required gate:
- independent YAML/workflow syntax/structure validation before push;
- exact changed-path and semantic-diff verification;
- one bounded push only after prevalidation;
- if GitHub still reports zero-job configuration failure, stop and publish blocker rather than trial-and-error another default edit.

Forbidden recovery:
- blind second workflow edit;
- default-as-parser;
- downstream runner/Herdr/session repair while workflow admission is unproven.

### RE-003 — STALE_REHYDRATION_OR_LAYER_SKIP

Trigger examples:
- decision uses an older `CURRENT_START_HERE` after a newer receipt exists;
- source appears semantically correct so runtime diagnosis starts before workflow admission is checked;
- missing liveness is treated as capability absence.

Required gate:
- reread newest `CURRENT_START_HERE`, ACTIVE generation switch, active work, branch/head immediately before decision/mutation;
- diagnose strictly upstream to downstream;
- classify capability evidence separately from current liveness.

Forbidden recovery:
- rely on remembered CURRENT_START_HERE;
- skip workflow admission/event/run-creation layer;
- rebuild a proven capability due only to missing current runtime evidence.

## Seven verified incidents

### Incident 1 — first zero-job workflow repair

Evidence: Actions run `33370461184`, commit `426df8cc32594f3f97d312f9808b7b0f39ac35e3`.

Observed: `.github/workflows/control-return-comment-bridge.yml` rebind attempt concluded `failure` with zero jobs.

Signature: `RE-002`.

Lesson that should have been sufficient: the next workflow mutation required independent validation before another push.

### Incident 2 — repeated zero-job workflow repair

Evidence: Actions run `33370608610`, commit `8f2a7d29cd71876b1a02b5f4bc47e49c13ca6632`.

Observed: another edit to the same standalone return workflow again concluded `failure` with zero jobs.

Signature: `RE-002`.

Durable blocker later recorded in Issue #114 receipt `5475458414`, including the requirement to use an independently validated workflow edit/test path.

Recurrence level at this point: `REPEAT_ERROR`.

### Incident 3 — registered-path repair repeated the prevalidation failure

Evidence: registered-path repair commit `50d642264deb6407613ef5e2be43844b67b06658`; Actions run `33371537167` concluded `failure` with `jobs=0`. Companion return workflow run `33371538062` also failed.

Observed: the historically registered path was targeted, but the workflow was still pushed without the required effective prevalidation gate.

Signature: `RE-002`.

Later exact defect: embedded JavaScript PowerShell here-string bodies/closers physically escaped the YAML `run: |` block indentation.

Recurrence level: `PROCESS_CONTROL_FAILURE`.

### Incident 4 — standalone duplicate used as current production truth

Evidence: Issue #114 health diagnosis lineage including receipt `5476064973`.

Observed: `.github/workflows/control-return-comment-bridge.yml` G7/#103 binding was used to reason about current production Control-return health even though the historically registered path was `.github/workflows/herdr-control-comment-bridge.yml`.

Signature: `RE-001`.

Required correction: production diagnosis must begin with registered-path resolution, not filename similarity.

### Incident 5 — scheduled worker repeated the same implementation confusion

Evidence: Issue #114 receipt `5476786868`, later corrected by Control receipt `5477340481`.

Observed: the scheduled worker again asserted the current registered workflow remained G7/#103-bound by conflating the standalone duplicate with the registered path.

Signature: `RE-001`.

Control-system responsibility: subordinate read-only workers may coordinate tools but their claims must not become Control truth without exact registered-path evidence.

### Incident 6 — source looked current, so diagnosis skipped workflow admission

Evidence: correction lineage after `5477340481`, later root cause receipt `5477790036`.

Observed: after proving the registered source was generic/current-aware, diagnosis initially moved to runtime delivery/session uncertainty without first checking that the exact workflow had already failed GitHub registration with `33371537167 = failure / jobs=0`.

Signature: `RE-003` and `RE-002`.

Required correction: source semantic correctness does not imply GitHub workflow admission.

### Incident 7 — stale rehydration/current-start usage

Evidence: `CURRENT_REHYDRATION_INDEX_V75` receipt `5477871795` existed, but a later pulse reported/used V74-era state before correcting freshness.

Observed: durable current state was available but not reread immediately before conclusion.

Signature: `RE-003`.

Required correction: remembered/current-context state is never sufficient for mutable authority; final reread is mandatory.

## Recurrence enforcement

The recurrence policy is mandatory:

1. First verified occurrence -> `LESSON`; record it and add a regression.
2. Second verified occurrence -> `REPEAT_ERROR`; the same recovery mechanism is prohibited.
3. Third or later verified occurrence -> `PROCESS_CONTROL_FAILURE`; mutation in that error class is blocked until the guard itself has mechanical acceptance evidence.

The seven incidents above therefore place `RE-001`, `RE-002`, and `RE-003` under permanent pre-mutation handoff enforcement.

## Handoff selection rule

Normal cold start does not replay this file. `HANDOFF.md` must expose the three short signatures. If a current symptom matches one, the successor reads the matching section here before the first high-risk mutation and includes the signature, recurrence level, forbidden prior recovery, registered implementation, failure layer, and required prevalidation in `CONTROL_REHYDRATION_REPEAT_ERROR_ACK_V1`.

If the ACK cannot be produced and read back with exact current identities, high-risk mutation is not legal.

## Non-WebGPT limitations versus process failures

True surface limitations may include lack of direct visibility into a Windows interactive process/session or an unavailable connector endpoint. These limitations must be reported as missing current evidence only.

The following are NOT accepted as WebGPT limitations:
- forgetting a newer `CURRENT_START_HERE`;
- confusing duplicate and registered workflow paths;
- skipping Actions admission evidence;
- treating GitHub default as the first parser;
- rebuilding capability from missing liveness;
- inferring Control identity from page/tab title.

Those are Control/process failures and are governed by the signatures above.
