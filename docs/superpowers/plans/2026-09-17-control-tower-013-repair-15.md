# Control Tower 013 Repair-15 Implementation Plan

## Scope

Close the F001 Proxy `ownKeys`/`has`/`get` caller-input bypass at exported
`runSupervisor`. Reject unsafe public inputs before normalization or loop
effects, then pass only a descriptor-safe snapshot of the six allowed own
runtime values to the non-trusted loop.

Only these paths are in scope:

- `docs/superpowers/plans/2026-09-17-control-tower-013-repair-15.md`
- `src/supervisor.mjs`
- `tests/supervisor.test.mjs`

## Boundary

The public `runSupervisor` boundary rejects Proxy, non-plain, accessor, symbol,
own-forbidden, and inherited-forbidden inputs with
`SUPERVISOR_ENTRYPOINT_REQUIRED`. A null-prototype snapshot containing only
own `runtimeRoot`, `orca`, `now`, `sleep`, `maxIterations`, and `intervalMs`
values is passed to normalization. Existing inherited/Object.prototype,
forged-own-key, trusted-entrypoint, provenance, F004-F006, and G001 behavior
remains unchanged.

## Verification

- TDD RED then GREEN for the executable Proxy regression across
  normal/query/hash/query+hash imports
- focused F001/F004/F006/G001 checks
- full serial `npm test`
- `node --check` for both touched `.mjs` files
- `git diff --check`
- exact three-path allowlist and one non-force commit/push
- exact GitHub ref/tree/parent/compare/blob read-back

Terminal is `READY_FOR_FRESH_REVIEW_V1`; no self-review, adoption, merge,
release, workflow dispatch, browser/phone action, or successor activation.
