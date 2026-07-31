# GPT Browser Bridge — Architecture

This document records the intended architecture, the local environment inventory
(GBB-001 deliverable) and the skill/instruction loading matrix for each agent CLI.

Authoritative project rules: `plans/GBB_PARENT_WORK_ORDER.md`. This file is a
living design doc that each card may extend.

## 1. Overview

```text
Windows Task Scheduler
        │
        ▼
resume.ps1                 (start-supervisor.ps1)
        │
        ▼
Supervisor (deterministic Node process, no model)
        ├─ heartbeat + lock + checkpoint
        ├─ ORCA health
        ├─ Control Tower terminal health / recovery
        └─ morning_summary.md
        ▼
Control Tower Agent        (single decision point; never edits source directly)
        │
        ├─ Worker        — edits source inside allowed paths, runs tests, reports, commits
        ├─ Reviewer      — fresh context, different agent/model family; conclusion only
        ├─ Browser Action Runner — browser writes only (send / approved continue / approved re-open)
        └─ Read-only Watcher — browser reads only, writes reply.md + result.json atomically
```

Principles:

- Single-line serial execution (no parallelism between cards).
- Control Tower is the **only** decision point.
- All durable progress is written to the runtime tree **before** any terminal message.
- Terminal handles are not permanent IDs; recovery uses `run_id` + terminal title.
- Watcher source must never contain browser write APIs.
- Supervisor only recovers; it never decides pass/rework and never resends.

## 2. Paths

| Kind | Path | In Git? |
| ---- | ---- | ------- |
| Repo (production) | `D:\AIWORK\GPT_BROWSER_BRIDGE\` | yes |
| Worktrees | `D:\AIWORK_WT\GPT_BROWSER_BRIDGE\<TASK_ID>\` | per-card worktrees |
| Runtime | `D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\` | **no** (ignored) |
| This worktree | `C:\Users\Lupun\orca\workspaces\GPT_BROWSER_BRIDGE\gbb-001-a1` | yes (branch `gbb-001-a1`) |

The runtime tree (`state/`, `locks/`, `jobs/`, `runs/`, `events/`, `logs/`) is the
single source of truth for project progress. It is never committed.

## 3. Runtime structure

```text
D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\
├─ state/    project_state.json, heartbeat.json, morning_summary.md
├─ locks/    supervisor.lock
├─ jobs/     <job_id>/ job.json, reply.md, result.json, watcher.log, diagnostics/
├─ runs/     <run_id>/ dispatch.json, worker_report.md, reviewer_report.md, recovery.log
├─ events/   events.ndjson
└─ logs/     supervisor.log, control_tower.log, scheduler.log
```

`project_state.json` legal states: `INITIALIZING`, `RUNNING`, `WAITING_WORKER`,
`WAITING_REVIEWER`, `WAITING_BROWSER`, `REWORK`, `NEEDS_HUMAN`, `COMPLETED`,
`CANCELLED`. Supervisor must never move `NEEDS_HUMAN → RUNNING` on its own.

## 4. Repo structure (intended)

See parent work order §8. Implemented so far (GBB-001):

```text
README.md, AGENTS.md, package.json, package-lock.json, THIRD_PARTY_NOTICES.md,
.gitignore
plans/        parent work order (formal + raw)
skills/       control-tower, worker, reviewer, browser-sender, browser-watcher,
              recovery-supervisor  (canonical SKILL.md, single source of truth)
src/          contracts.mjs, adapters/ (orca / browser / agent)
scripts/      bootstrap.ps1, start-supervisor.ps1, resume.ps1, keep-awake.ps1,
              register-resume-task.ps1, unregister-resume-task.ps1
tests/        contracts.test.mjs
docs/         ARCHITECTURE.md, SECURITY.md
```

## 5. Environment inventory (recorded 2026-07-31, GBB-001)

| Tool | Version / state | Notes |
| ---- | --------------- | ----- |
| Node.js | `v24.18.0` | `C:\Program Files\nodejs\node.exe` |
| npm | `11.16.0` | |
| Git | `2.55.0.windows.3` | |
| opencode | `1.18.10` | `%APPDATA%\npm\opencode.cmd` |
| claude | `2.1.218` (Claude Code) | `C:\Users\Lupun\.local\bin\claude.exe` |
| codex | `codex-cli 0.145.0` | `%APPDATA%\npm\codex.cmd` |
| orca | app `1.4.162` | CLI at `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe` |

Notes:

- `orca` / `orca-cli` are **not** on `PATH` in a plain PowerShell. The public CLI
  binary is `C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe`
  (see `C:\Users\Lupun\.agents\skills\orca-cli\SKILL.md` resolution rules: prefer
  `$env:ORCA_CLI_COMMAND` when set, else `orca`). `%LOCALAPPDATA%\Programs\orca\Orca.exe`
  is the Electron app launcher (single-instance) and is not the CLI.
- `opencode` requires `NO_COLOR` or a non-TTY to emit clean `--help` text (ANSI art).
- None of the missing tools were installed by this card; missing CLI tools are only
  recorded per parent work order §12.4–§12.5.
- `playwright-core@1.62.1`, `write-file-atomic@8.0.0`, `zod@4.4.3` are installed as
  the only runtime dependencies (`package.json`). `npm install` reports 0
  vulnerabilities. (2 devDependencies resolved transitively — none added by us.)
- Node 24 on Windows: `node --test tests/` (bare directory argument) fails with
  `MODULE_NOT_FOUND` (nodejs/node#64555). The `npm test` script therefore uses the
  glob form `node --test "tests/**/*.test.mjs"`; see `AGENTS.md`.

## 6. Skill loading matrix

Canonical skills live in this repo under `skills/<role>/SKILL.md`. Different CLIs
load instructions/skills from different locations; the matrix below records what was
found on this machine (GBB-001). Do **not** hand-maintain diverging copies of the
same rules per tool; copy/adapt from the canonical files only.

| Tool | Instructions file (repo-local) | Skill / instruction locations on this machine | Notes |
| ---- | ------------------------------ | --------------------------------------------- | ----- |
| opencode | `AGENTS.md` (root) | project `opencode.json` / `.opencode/`; user config `~/.config/opencode/opencode.json(c)`; skills loaded from `~/.agents/skills/<name>/SKILL.md` | `opencode.json` at repo root currently sets model + permission rules (provided by Control Tower; outside GBB-001 allowed paths). |
| claude | `CLAUDE.md` / `AGENTS.md` | `~/.claude/skills/<name>/SKILL.md`; `~/.claude/settings.json`; project `.claude/skills/` | Installed via `C:\Users\Lupun\.local\bin\claude.exe`. |
| codex | `AGENTS.md` (root, supported) | `~/.codex/AGENTS.md`; `~/.codex/skills/` (incl. `.system/` bundled skills); `~/.codex/config.toml` (model, plugins, marketplaces) | Installed via npm (`%APPDATA%\npm\codex.cmd`). |
| orca | `orca skills get <name>` | orca CLI bundles version-matched skill guides (`orca skills list` / `orca skills get`); agent skills under `~/.agents/skills/` | Do not hardcode orca skill text; fetch via `orca skills get orca-cli` etc. |

Adapter strategy (parent work order §7): for each CLI that loads skills from its own
directory, create a copy/symlink adapter from the canonical `skills/<role>/SKILL.md`
into that tool's skill location, and record the mapping here. No manual divergence.

## 7. Skills

Canonical skills are the role contracts. Content is specified in parent work order
§7.1–§7.6 and implemented in `skills/<role>/SKILL.md`. They define role boundaries
(Section 6 of the parent order): Sender (browser writes only), Watcher (browser reads
only), Worker (allowed-paths source edits), Reviewer (fresh context, read-only),
Control Tower (only decision point), Recovery Supervisor (deterministic recoverer).

## 8. Contracts & adapters

- `src/contracts.mjs` — Zod schemas for `job.json`, `result.json`,
  `project_state.json` and agent report schemas (see `docs/` schemas). Validated by
  `tests/contracts.test.mjs` with `node:test`.
- `src/adapters/` — interface stubs for `orca_adapter.mjs` (terminal/worktree ops),
  `browser_adapter.mjs` (send vs watch separation), `agent_adapter.mjs`
  (CLI invocation for worker/reviewer). Bodies are filled by later cards.

## 9. Security posture

See `docs/SECURITY.md`. Highlights: CDP binds `127.0.0.1` only; no cookies/tokens/
Chrome profiles in Git; logs limited to conversation IDs, titles, counts, hashes,
error codes, timestamps; `output_dir` validated and confined to the runtime root.
