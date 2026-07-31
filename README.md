# GPT Browser Bridge (GBB)

A Windows-local automation infrastructure project that lets ORCA and multiple CLI
agents (OpenCode / Claude Code / Codex) coordinate a single ChatGPT web conversation
for review jobs — with durable checkpoints, role separation, and overnight crash
recovery.

The authoritative requirements live in `plans/GBB_PARENT_WORK_ORDER.md`. This repo
implements them one work order (card) at a time, each with its own worker worktree
and a fresh-context reviewer.

## Current status

| Card | Purpose | State |
| ---- | ------- | ----- |
| GBB-001 | Bootstrap, governance & skills | In progress (this card) |
| GBB-002 | Playwright CLI compatibility spike | Not started |
| GBB-003 | Durable ChatGPT watcher MVP | Not started |
| GBB-004 | Overnight supervisor & crash recovery | Skeleton present |
| GBB-005 | Pilot, shadow review & final gate | Not started |

Project state (the single source of truth for progress) lives outside Git in the
runtime tree, see `docs/ARCHITECTURE.md`.

## Quick start

```powershell
npm install
npm test
```

## Repo layout

```text
README.md
AGENTS.md                build-agent rules for this repo
package.json             only playwright-core / write-file-atomic / zod
THIRD_PARTY_NOTICES.md   third-party usage & license record
plans/                   parent work order + per-card plans
skills/                  canonical agent skills (single source, no duplicated copies)
src/                     source (contracts, adapters, supervisor, watcher, ...)
scripts/                 bootstrap & lifecycle PowerShell scripts
tests/                   node:test suite (no third-party test framework)
docs/                    architecture, security, runbooks
```

## Environment inventory

Runtime versions, CLI availability and how each agent loads skills are recorded in
`docs/ARCHITECTURE.md` under "Environment inventory".

## Security

- CDP binds to `127.0.0.1` only; never `0.0.0.0`, no firewall rules.
- No credentials, cookies, session tokens, Chrome profiles or runtime paths in Git.
- See `docs/SECURITY.md` for the full policy.

## Documentation

- `docs/ARCHITECTURE.md` — architecture, environment inventory, skill loading matrix
- `docs/SECURITY.md` — security policy
- `plans/GBB_PARENT_WORK_ORDER.md` — authoritative parent work order
