# Control Tower 013 Repair-14 Implementation Plan

## Scope

Close the F001 inherited/prototype caller-input bypass at the exported
`runSupervisor` boundary. Reject caller-selected authority, lock, liveness,
identity-source, admission, reconstruction, and delivery inputs before loop
normalization or effects.

Only these paths are in scope:

- `docs/superpowers/plans/2026-09-17-control-tower-013-repair-14.md`
- `src/supervisor.mjs`
- `tests/supervisor.test.mjs`

## Boundary

The public `runSupervisor` shape remains limited to non-authority runtime
configuration. Own and inherited forbidden semantic fields, including fields
polluted onto `Object.prototype`, return `SUPERVISOR_ENTRYPOINT_REQUIRED` with
zero lock, identity, heartbeat, state, event, resume, or send effects. The
private trusted production path and existing provenance checks remain intact.

## Verification

- TDD RED then GREEN for inherited/prototype inputs across normal/query/hash/query+hash imports
- focused F001/F004/F006/G001 checks
- full serial `npm test`
- `node --check` for both touched `.mjs` files
- `git diff --check`
- exact three-path allowlist and one non-force commit/push
- exact GitHub ref/tree/parent/compare/blob read-back

Terminal is `READY_FOR_FRESH_REVIEW_V1`; no self-review, adoption, merge,
release, workflow dispatch, browser/phone action, or successor activation.
