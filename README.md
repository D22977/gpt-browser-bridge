# GPT Browser Bridge (GBB)

GPT Browser Bridge is a Windows-local bridge for GitHub-backed coordination of
ChatGPT Web work. It separates durable Control decisions from local transport,
Worker/Reviewer execution, browser Sender writes, and read-only Watcher reads.

## Authority and status

This README is orientation only. It is not a project status database, runtime
checkpoint, or replacement for a Control receipt. Current semantic authority is
the repository's GitHub issues, comments, exact refs/heads/trees/blobs, and
read-back receipts. Start with [Issue #162](https://github.com/D22977/gpt-browser-bridge/issues/162)
for the resident/restartable restoration track and verify the exact current
binding before acting.

The local runtime tree is continuity and transport state. It must not be treated
as a competing semantic source of truth. The legacy parent work order and older
generation records remain useful historical context only when a current GitHub
card explicitly binds them.

The current restoration direction is a resident/restartable local Herdr
consumer. Issue-specific or generation-specific one-shot workflows may remain as
historical or transitional evidence, but they are not the normal unattended
loop. Their retirement requires a separate exact Control decision and a complete
reference audit.

## Quick start

```powershell
npm install
npm test
```

Use an isolated worktree for a bounded card. Before any tracked mutation, read
the Control card and its consumed-started receipt from GitHub, bind the exact
source head/tree and allow-listed paths, and stop at the Worker terminal.

## Repository layout

```text
README.md
AGENTS.md                repo-local agent rules
package.json             runtime dependencies and test command
plans/                   historical and card-specific planning material
skills/                  role skills and operational contracts
src/                     contracts, adapters, supervisor, Sender, Watcher
scripts/                 Windows lifecycle and resume entrypoints
tests/                   node:test regression matrix
.github/workflows/       GitHub transport and historical/transition workflows
docs/                    orientation and security documentation
```

## Operational boundaries

- Control is the decision point; Worker, Reviewer, Sender, Watcher, and
  Supervisor do not silently adopt another role.
- GitHub read-back, exact card/generation/head/tree/target binding, idempotency,
  duplicate suppression, and `NO_BLIND_RETRY` are safety requirements.
- Sender and Watcher remain separate source-level boundaries. A Watcher is
  read-only and must not gain browser write APIs for convenience.
- ORCA compatibility exists in the current supervisor surface; removing it is a
  separate architecture/support decision, not routine stale-file cleanup.
- No credentials, cookies, session tokens, Chrome profiles, or runtime secrets
  belong in Git.

## Documentation

- [AGENTS.md](AGENTS.md) — role, mutation, and verification rules
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — non-authoritative architecture
  orientation and boundaries
- [docs/SECURITY.md](docs/SECURITY.md) — security policy
- [Issue #162](https://github.com/D22977/gpt-browser-bridge/issues/162) — current
  GitHub control history for the resident restoration work
