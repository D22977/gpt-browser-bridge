# GPT Browser Bridge (GBB)

A Windows-local automation project connecting GitHub work orders, Web GPT Control,
Herdr/CLI executors and independent reviewers. Roles remain separate; each physical
route requires current admission and each phase requires its own durable evidence.

Start at [AGENTS.md](AGENTS.md) and the [shared handoff contract](docs/HANDOFF_CONTRACT.md).
Web Control uses [its runbook](docs/WEB_CONTROL_RUNBOOK.md); desktop Herdr uses
[its runbook](docs/HERDR_RUNBOOK.md). These are role views of one contract, not
separate authority stores. The original parent plan preserves historical design.

## Current status

Read the latest applicable receipts, with complete pagination, in
[#43](https://github.com/D22977/gpt-browser-bridge/issues/43),
[#81](https://github.com/D22977/gpt-browser-bridge/issues/81),
[#88](https://github.com/D22977/gpt-browser-bridge/issues/88), then the current work
order. Do not infer current status from this README or a historical card table.
GitHub is durable semantic authority. Local runtime state is execution/recovery
evidence and cache; it must be reconciled before sending or resuming work.

## Quick start

```powershell
npm install
npm test
```

## Repo layout

```text
README.md
AGENTS.md                shared role entry and GitHub rehydration pointers
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
- `docs/HANDOFF_CONTRACT.md` — common authority, lifecycle, failure and continuation rules
- `docs/WEB_CONTROL_RUNBOOK.md` — Web Control reading and decision procedure
- `docs/HERDR_RUNBOOK.md` — desktop transport admission, execution and terminal guard
- `plans/GBB_PARENT_WORK_ORDER.md` — historical parent requirements and execution records
