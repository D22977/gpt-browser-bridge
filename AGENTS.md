# AGENTS.md — GPT Browser Bridge agent rules

These rules are a repo-local safety summary. They do not replace a current
GitHub Control card, its exact binding, or its durable read-back receipts.

## Source of truth

- GitHub issues, comments, exact refs/heads/trees/blobs, and terminal receipts
  are the semantic authority.
- The local runtime tree stores continuity, locks, checkpoints, and delivery
  state; it is not a competing project-status authority.
- `plans/` and older generation records are historical or explanatory unless a
  current card explicitly names and binds them.
- Read the current card and all required read-backs before acting. A wake,
  READY receipt, sent message, or generated reply is not completion by itself.

## Roles

- Control Tower — owns decisions and exact scope; does not edit source directly.
- Worker — changes only the card's allow-listed paths in an isolated worktree,
  verifies them, publishes a terminal receipt, and stops.
- Reviewer — fresh, independent, read-only review of the exact candidate and
  receipts; does not modify, adopt, merge, or release.
- Sender — browser writes only, and only after the final exact physical-send
  gate.
- Watcher — browser reads only; it must not import or invoke Sender write APIs.
- Supervisor — deterministic continuity/recovery process; it never judges,
  self-adopts, or blind-retries an uncertain send.

## GitHub-first mutation protocol

Before tracked mutation, verify the current Control card, source head/tree,
target, generation, allow-list, and consumed-started receipt. Serialize fields
from one authoritative snapshot and read back every durable write. A mismatch,
ambiguous history, stale ref, unknown dirty state, or uncertain physical send is
a fail-closed stop (`CONTROL_REQUIRED` / `NO_BLIND_RETRY` as applicable).

Do not create a successor card, merge, release, deploy, dispatch, or claim
completion unless the current Control authority explicitly permits that action.
Do not use a new workflow, scheduler, service, daemon, router, database, or MCP
dependency to compensate for a missing current binding.

## Workflow and architecture policy

Issue-specific and generation-specific one-shot workflows are not the normal
unattended loop. Keep historical or transitional workflows until a complete,
current-reference audit and a separate Control decision prove retirement safe.
The current Issue #162 direction is a resident/restartable local Herdr consumer.

ORCA remains a compatibility surface in the current supervisor implementation.
Its removal or replacement is an explicit architecture/support decision and must
not be bundled into documentation or workflow cleanup.

## Build and verification

```powershell
npm install
npm test
```

Use the repository test command (`node --test "tests/**/*.test.mjs"`) and run
`node --check` for every touched `.mjs` file. Keep the declared dependency set;
do not add a duplicate framework or helper package without an exact card.
For documentation-only work, verify the changed-path allow-list, links and
references, and prove that executable paths are unchanged.

## Security invariants

- CDP binds to `127.0.0.1`; never expose it on `0.0.0.0` or add firewall rules.
- Never commit credentials, cookies, session tokens, Chrome profiles,
  authorization headers, or runtime secrets.
- Preserve exact target admission, idempotency, duplicate suppression,
  reservation/lease/fence checks, and `NO_BLIND_RETRY`.
- Preserve the source-level Sender/Watcher write/read separation.
- Confine generated output to the validated runtime root.
