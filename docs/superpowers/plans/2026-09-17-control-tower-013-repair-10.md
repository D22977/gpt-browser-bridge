# Control Tower 013 Repair-10 Implementation Plan

## Goal

Close the F001 exported capability-mint path while preserving the existing
module-private WeakSet binding, F004 mixed-drive rejection, F006 durable
`SEND_PENDING`/`UNCERTAIN_SEND` behavior, and G001 Worker-only boundary.

## Scope

- `src/supervisor.mjs`
- `tests/supervisor.test.mjs`
- this plan file

The normal production import exposes no capability mint. Tests use the
explicit `__testOnly` namespace through a test-only module URL so positive
fixtures remain bound to the same module-private WeakSet. The adversarial
regression imports the normal production surface and supplies forged current
authority, legacy reader, and source together; it must fail before
reconstruction, admission, heartbeat, state mutation, or resume work.

## Verification

- targeted F001 regression
- full serial `npm test`
- `node --check` for `src/supervisor.mjs` and `tests/supervisor.test.mjs`
- `git diff --check`
- exact allowlist, one commit, non-force push, exact GitHub read-back
