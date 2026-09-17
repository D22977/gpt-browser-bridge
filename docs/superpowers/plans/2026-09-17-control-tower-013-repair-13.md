# Control Tower 013 Repair-13 Implementation Plan

## Scope

Close the remaining F001 caller-invokable `runSupervisor` authority mint and
bind the Supervisor identity source to the filesystem object created by the
trusted path, including replacement and redirection fail-closed handling.

Only these paths are in scope:

- `docs/superpowers/plans/2026-09-17-control-tower-013-repair-13.md`
- `src/supervisor.mjs`
- `tests/supervisor.test.mjs`

## Boundary

The exported `runSupervisor` accepts only non-authority runtime configuration
and uses the injectable/non-trusted loop; caller-selected identity, lock,
liveness, admission, reconstruction, and delivery inputs return
`SUPERVISOR_ENTRYPOINT_REQUIRED` before loop effects. Only private `main` calls
the trusted producer that supplies `SUPERVISOR_ENTRYPOINT`. Identity ownership
retains the exclusive-create handle and compares its object identity with a
no-follow path stat, while raw bytes remain an additional integrity check.

## Verification

- focused F001 production-boundary regression
- focused F004/F006/G001 checks
- full serial `npm test`
- `node --check` for both touched `.mjs` files
- `git diff --check`
- exact three-path allowlist and one non-force commit/push
- exact GitHub ref/tree/parent/compare/blob read-back

Terminal is `READY_FOR_FRESH_REVIEW_V1`; no self-review, adoption, merge,
release, workflow dispatch, browser/phone action, or successor activation.
