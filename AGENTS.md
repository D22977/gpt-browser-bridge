# AGENTS.md — shared entry for GBB agents

Read this file when entering the repo, receiving a minimal GitHub pointer, or
recovering a role after a turn/process/generation change. The filename is
`AGENTS.md`; do not maintain a separate `Agent.md` with competing instructions.

Current durable GitHub authority governs execution. The historical parent plan is
design context, not a current task queue. A candidate documentation branch is not
accepted guidance until the required independent review and explicit adoption.

## Read only the common contract and your role's entry

All roles read [HANDOFF_CONTRACT.md](docs/HANDOFF_CONTRACT.md), then:

| Role | Required role entry |
| --- | --- |
| Web GPT Control | [WEB_CONTROL_RUNBOOK.md](docs/WEB_CONTROL_RUNBOOK.md), [Control skill](skills/control-tower/SKILL.md) |
| Desktop Herdr operator / transport | [HERDR_RUNBOOK.md](docs/HERDR_RUNBOOK.md); the invoked executor reads its own skill below |
| Worker | [Worker skill](skills/worker/SKILL.md), exact live dispatch |
| Formal Reviewer | [Reviewer skill](skills/reviewer/SKILL.md), exact live review request |
| Deterministic recovery / guard | [Recovery skill](skills/recovery-supervisor/SKILL.md), admitted route/run binding |
| Browser Sender / Watcher | [Sender skill](skills/browser-sender/SKILL.md) / [Watcher skill](skills/browser-watcher/SKILL.md), exact browser job |

Fresh-read all pages of the current [#43 index](https://github.com/D22977/gpt-browser-bridge/issues/43),
[#81 registry](https://github.com/D22977/gpt-browser-bridge/issues/81),
[#88 switch](https://github.com/D22977/gpt-browser-bridge/issues/88), and target card.
Bind the admitted documentation ref/blob; resolve current head, generation and
executor at action time. Do not copy current IDs into permanent startup prompts.

Web Project instructions must explicitly point to these GitHub files; do not assume
repo-local AGENTS loading happens in WebGPT. Herdr dispatch must make the same
pointer available to the exact CLI executor; documentation is not a live consumer.

## Repo purpose

Implement GBB through bounded GitHub work orders, isolated Worker checkouts and
fresh independent review. Preserve each card's WIP limits. Model-family and review
surface constraints come from the current exact card; preserve a different-family
requirement where still applicable. Runtime/checkpoints preserve observations;
GitHub receipts govern semantic progress and authorization.

## Roles (do not mix)

- Control Tower — only decision point; never edits source directly.
- Worker — edits source inside its allowed paths; must run tests; writes a report; commits.
- Reviewer — fresh independent context; never edits code; uses the exact card's terminal protocol and decision set.
- Browser Action Runner (Sender) — browser writes only.
- Watcher — browser reads only; must contain no write APIs.
- Supervisor — deterministic process; recovers terminals; never decides pass/rework.
- Herdr transport — consumes already-authorized events, binds fresh executors and
  guards terminal/return delivery; never invents Control decisions.

## Handoff responsibilities

- Admit the outbound consumer and terminal guard before claiming a dispatch is executable.
- `CARD_EXISTS -> DISPATCH_REQUEST_WRITTEN -> CONSUMED_STARTED -> TERMINAL_RESULT`
  are distinct. Worker authors its own start; delivery is not consumption.
- Worker stops mutation at READY; Control/guard continue the parent work through
  required fresh review, adjudication and separately authorized adoption/E2E.
- Persist phase, exact bindings, physical attempt state, next owner and live guard
  before a planned turn end. Stored next-step prose alone is not autonomous recovery.
- `CONTROL_REQUIRED` routes to Control for bounded recovery. Escalate to the owner
  only for a proven human gate. An old uncertain send does not forbid an independent
  authorized repair, but cannot be replayed under a new ID.
- For first-send vs duplicate vs uncertainty, follow the shared contract's evidence
  rules; missing ACK alone proves neither delivery nor non-delivery.

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
- If the working tree is dirty for unknown reasons, stop mutation there and report
  `DIRTY_ATTRIBUTION_UNKNOWN` to Control. Preserve all files; do not guess ownership.
  Control may bind a clean isolated checkout under current authority, without
  duplicating a live Worker. Require a human only when attribution/access needs one.

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
