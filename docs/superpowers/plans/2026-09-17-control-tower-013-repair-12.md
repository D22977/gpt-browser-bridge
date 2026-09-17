# Control Tower 013 Repair-12 Implementation Plan

## Scope

Close F001 from review `5706384213` by making the Supervisor the only
post-lock producer of the canonical `state/supervisor_identity.json` source,
while preserving F004 mixed-drive rejection, F006 durable
`SEND_PENDING`/`UNCERTAIN_SEND` no-blind-retry behavior, and the G001
Worker-only boundary.

Only these paths are in scope:

- `docs/superpowers/plans/2026-09-17-control-tower-013-repair-12.md`
- `src/supervisor.mjs`
- `tests/supervisor.test.mjs`

## Boundary

The public `runLoopOnce` path cannot mint an identity source. The Supervisor
entrypoint establishes the canonical source only after acquiring the lock with
an exclusive create, binds the lock pid/host/fence/fence_id and complete
authority tuple, and keeps a private ownership record so a pre-existing,
replaced, redirected, query/hash-loaded, or caller-supplied source fails closed
before reconstruction, admission, heartbeat, state mutation, resume, or send.

## Verification

- focused F001/F004/F006 checks
- full serial `npm test`
- `node --check src/supervisor.mjs`
- `node --check tests/supervisor.test.mjs`
- `git diff --check`
- exact three-path allowlist and one non-force commit/push
- exact GitHub ref/tree/parent/compare/blob read-back

Terminal is `READY_FOR_FRESH_REVIEW`; no self-review, adoption, merge, release,
workflow dispatch, browser/phone action, or successor activation.
