# Control Tower 013 Repair-11 Implementation Plan

## Scope

Close the F001 query-string capability-mint finding from review `5706050348`
while preserving F004 mixed-drive rejection, F006 durable
`SEND_PENDING`/`UNCERTAIN_SEND` no-blind-retry behavior, and the G001
Worker-only boundary.

Only these paths are in scope:

- `docs/superpowers/plans/2026-09-17-control-tower-013-repair-11.md`
- `src/supervisor.mjs`
- `tests/supervisor.test.mjs`

## Boundary

The production module exports no capability mint or test namespace. After lock
acquisition, `runLoopOnce` reads and validates the Supervisor identity snapshot
from its runtime state path, binds that parsed object to a module-private
capability, checks its lock tuple, and compares its complete authority tuple
with the caller's durable candidate before reconstruction, admission, or any
downstream state/delivery work. Caller-provided identity readers and source
objects are ignored.

## Verification

- focused F001 production-boundary adversarial regression
- full serial `npm test`
- `node --check src/supervisor.mjs`
- `node --check tests/supervisor.test.mjs`
- `git diff --check`
- exact three-path allowlist and one non-force commit/push
- exact GitHub ref/tree/parent/compare/blob read-back

Terminal is `READY_FOR_FRESH_REVIEW`; no self-review, adoption, merge, release,
workflow dispatch, browser/phone action, or successor activation.
