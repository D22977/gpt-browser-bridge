# Control Tower Handoff — first-read landing contract

Status: CANDIDATE until independently reviewed and integrated into the admitted canonical Control Tower skill.

## Purpose

This file is the **first navigation read** for a fresh/recovered Control generation. It is deliberately small. It tells the new Control where the current authoritative material lives without requiring it to replay historical failures.

**Reading this file first does not make it authority.** It is a landing pointer only. If anything here conflicts with current durable GitHub Control authority, current owner instruction, or the admitted canonical `SKILL.md`, the newer authoritative source wins and this file is treated as stale.

## Fresh handoff reading order

1. Read this `HANDOFF.md` first for navigation only.
2. Read the admitted canonical `skills/control-tower/SKILL.md` and bind its exact ref/head/blob.
3. Read `SUCCESS_EVIDENCE_INDEX.md`; reuse still-valid PASS/proven receipts instead of re-testing them.
4. Read the current project's durable Control landing issue / `CURRENT_START_HERE` / latest generation-switch receipt.
5. Read the current project product/card identity, mutable branch/head metadata, and only the exact evidence required by the active task.
6. Read a project-local `HANDOFF.md` only as a pointer; reconcile it against current durable authority before using any phase/gate/next-action claim.
7. Do **not** read `FAILURE_ARCHIVE.md` by default. Open only the exact archived entry needed when the current error signature matches, an independent reviewer requires historical lineage, or the owner explicitly requests it.

## Default evidence policy

- Newer exact PASS/proven evidence outranks older failure evidence for capability selection.
- A failure that has a durable `superseded_by` success/correction is diagnostic history, not a current blocker.
- Unknown current liveness does not invalidate a proven bounded capability.
- Never recreate Router/capability-discovery work merely because an archived failure exists.
- Never infer current state from stale chat memory, stale terminal prose, or stale project handoff text.

## Current canonical pointers at candidate creation

- canonical repo: `D22977/gpt-browser-bridge`
- canonical path: `skills/control-tower/SKILL.md`
- admitted ref at candidate base: `review-base/gbb-gh-01`
- admitted head at candidate base: `50cd14c941072de5ea04690f286683c05eac1d81`
- admitted Git blob at candidate base: `babbb3f704b852f499d96d2cb1ac7493e71cc851`

These identities are **not permanent constants**. A fresh Control must read the current admitted canonical identity and fail closed if this candidate landing file is stale.

## Local adapter rule

A local `~/.agents/skills`, `~/.codex/skills`, or equivalent adapter is optional. If used, it must match the admitted canonical bytes. An unverified/stale local adapter never overrides canonical GitHub bytes. If canonical GitHub bytes are directly available, Web Control semantic work may proceed while local adapter synchronization is pending, unless a newer exact authority says otherwise.

## Exit condition

After the reading order above, the Control should be able to state, without replaying archived failures:

- active Control generation and exact switch receipt;
- canonical Skill identity;
- current product/candidate identity;
- strongest still-valid success/proven capability evidence for the active task;
- current liveness only where task execution actually needs it;
- BEST_NEXT and forbidden actions.
