# AGENTS.md — GPT Browser Bridge build-agent rules

These rules apply to any agent that works in this repository. The cited parent plan
defines project-wide role, skill, Git, and security rules; current durable GitHub
Control authority and the exact card govern the current task, scope, and execution.
This file is the repo-local summary for build agents.

## Control entry

Control reads `skills/control-tower/HANDOFF.md` as navigation only, then follows the
single rehydration order in the live `skills/control-tower/SKILL.md` §3. Read the
canonical Skill's current GitHub ref, commit head, and blob SHA; if that identity does
not match the authorized card/base, fail closed. A candidate identity recorded in
HANDOFF is a freshness hint, not authority; report it as stale when it differs from
the live GitHub binding.

Any shared handoff contract and applicable role-specific runbook or skill supplement
role duties only after that Control rehydration sequence. They do not reorder it,
replace current GitHub authority, or select the task.

At a handoff/control-return boundary that relies on later autonomous wake, follow the
canonical Skill's §8.1 current ACTIVE Control binding, current-generation lease, and
matching fresh-heartbeat gate. A missing edge requires `CONTROL_REQUIRED` and a stop;
GitHub, Actions, and scheduler records alone do not prove WebGPT delivery or ACK.

## Repo purpose

Implement GPT Browser Bridge as a series of work orders (GBB-001 … GBB-005),
serially, one worker worktree per card, reviewed by a fresh-context reviewer from a
different agent/model family. A deterministic Supervisor + Control Tower agent (the
single decision point) drive the flow; this repo is where source, skills, plans and
tests are versioned.

## Roles (do not mix)

- Control Tower — only decision point; never edits source directly.
- Worker — edits source inside its allowed paths; must run tests; writes a report; commits.
- Reviewer — fresh-context review; never edits code; conclusion only `通過` / `退修` / `受阻`.
- Browser Action Runner (Sender) — browser writes only.
- Watcher — browser reads only; must contain no write APIs.
- Supervisor — deterministic process; recovers terminals; never decides pass/rework.

## Building / testing

```powershell
npm install
npm test          # node --test "tests/**/*.test.mjs"  (node:test only; see note below)
```

- Use only the packages allowed by the parent work order: `playwright-core`,
  `write-file-atomic`, `zod`. Do not add functionally duplicate packages.
- Run `node --check` on every `.mjs` file you touch before committing.
- Never introduce a third-party test framework or a package not in `package.json`.
- Note: on Node 24 Windows, `node --test tests/` (bare directory arg) fails with
  `MODULE_NOT_FOUND` (nodejs/node#64555). Use the glob form
  `node --test "tests/**/*.test.mjs"` (already the `npm test` script).

## Git governance

- Only commit files under your card's allowed paths.
- Commit message prefix must be the card id, e.g. `GBB-001 ...`.
- Forbidden without explicit approval:
  `git reset --hard`, `git clean`, `git stash`, force push, deleting unknown files,
  moving other projects' files, whole-repo formatting.
- Do not commit: credentials, cookies, Chrome profiles, runtime paths,
  `node_modules/`, logs, `heartbeat.json`.
- If the working tree is dirty for unknown reasons, stop and report
  `NEEDS_HUMAN / DIRTY_ATTRIBUTION_UNKNOWN` — do not guess.

## Skills

Canonical skills live under `skills/<role>/SKILL.md` and are the single source of
truth. Do not maintain diverging copies for different CLI tools; if a tool loads
skills from a different location, create an adapter/copy from the canonical file (see
`docs/ARCHITECTURE.md` "Skill loading matrix").

## Security (summary; see docs/SECURITY.md)

- CDP binds to `127.0.0.1` only.
- Never log or commit cookies, session tokens, Authorization headers, Chrome profile
  content or ChatGPT account info.
- Allowed to log: conversation IDs from URLs, page titles, message counts, hashes,
  error codes, timestamps.
- Output directories must be validated and confined to the runtime root.
