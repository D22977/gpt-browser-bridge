# Control Tower 013 Repair-09 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the F001 caller-self-attestable identity provenance gap while preserving the F004 and F006 repairs.

**Architecture:** `runLoopOnce` keeps the durable candidate authority for tuple comparison but no longer calls a caller-provided `readCurrentIdentity`. A module-private WeakSet capability is required; its immutable identity snapshot must bind process/host/fence fields to the acquired lock before its complete tuple can reach reconstruction or admission. Production has no caller-accessible constructor; the explicit test-only constructor binds deterministic fixtures. Missing or unbound source data returns a typed fail-closed result.

**Tech Stack:** Node.js ESM, Zod contracts, Node test runner, Git.

## Global Constraints

- Modify only `docs/superpowers/plans/2026-09-17-control-tower-013-repair-09.md`, `src/contracts.mjs`, `src/supervisor.mjs`, and `tests/supervisor.test.mjs`.
- Preserve F004 mixed-drive-separator rejection and F006 durable `SEND_PENDING` no-blind-retry behavior.
- Publish/read back `CONSUMED_STARTED` before tracked mutation; commit and push one candidate head.
- Stop at `READY_FOR_FRESH_REVIEW`; do not self-review, merge, release, adopt, or activate a successor.

### Task 1: Prove the production-boundary rejection

- Add one `runLoopOnce` test with the same forged tuple returned by `readCurrentIdentity` and supplied as `currentAuthority`.
- Include reconstruction inputs and a pending admission, then assert the typed source failure, no admission result, and no heartbeat write.

### Task 2: Bind the production identity source

- Add a Zod schema and module-private capability for the separately bound Supervisor identity snapshot, with only an explicit test-only constructor.
- Read only that snapshot after lock acquisition, validate its binding against lock pid/host/fence/fence_id, and compare its complete authority tuple with the durable candidate.
- Ignore the legacy caller-provided reader and fail closed when the Supervisor source is absent or invalid.
- Update existing production-path fixtures to use the new source shape without changing F004/F006 behavior.

### Task 3: Verify and publish

- Run the targeted regression, full serial test suite, `node --check` on touched modules, and `git diff --check`.
- Confirm the exact allowlist and one candidate commit, push without force, read back ref/head/tree/parent/compare/blob hashes, then publish `READY_FOR_FRESH_REVIEW`.
