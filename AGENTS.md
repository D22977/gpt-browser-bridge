# AGENTS.md — GPT Browser Bridge stable build-agent rules

These rules apply to any agent that works in this repository. They are stable
bootstrap and navigation rules, not permission to activate a task. The current
task authority is the exact GitHub Issue/PR and its latest non-superseded durable
receipts; the scheduler prompt, chat summary, and static examples are not task
authority. The parent work order remains a useful technical and historical
reference for the rules retained below.

## Repo purpose

Implement GPT Browser Bridge as atomic, independently reviewable cards, one
isolated worktree per card, with a fresh-context Reviewer from a different
agent/model family. The accepted V10.6 baseline uses an immutable
`OVERNIGHT_PLAN_V1`, Pull-first Worker/Reviewer schedulers, and existing GitHub
Issue/PR receipts. Older GBB-001 … GBB-005 Supervisor/Control-Tower material is
historical context unless a current card explicitly activates a compatible path.

## Current authority and task entry

- Read the exact card, executor, dependency, base, allowed paths, and latest
  durable receipts before editing; fail closed on missing, stale, conflicting, or
  ambiguous authority.
- The immutable `OVERNIGHT_PLAN_V1` is only the ordered menu for a run. It does
  not contain mutable READY, review-result, or head state; reread those from the
  exact GitHub card/PR each time.
- Authority precedence is: direct platform/user instruction; current exact
  GitHub card and non-superseded receipts; this stable bootstrap; architecture
  and development documentation; background examples.
- Before publishing any formal verdict, a fresh Reviewer must directly reread
  the exact GitHub card/PR and current non-superseded receipts, then verify the
  exact base, exact head, and exact allowed paths for that review identity. Fail
  closed on drift, supersession, duplicate identity, or scope mismatch.

## V10.6 Worker boundary

For an activated card, resolve exactly one action from current durable evidence:

- binding `PASS` -> `TERMINAL_SKIP`;
- binding in-scope, preauthorized `FIX_REQUIRED` -> `REPAIR`;
- current exact `READY` without a binding formal result -> `WAIT_REVIEW` and **no
  file mutation**;
- activated card with no current READY/result -> `IMPLEMENT`;
- malformed, stale, conflicting, or ambiguous authority -> `BLOCKED` and **no
  file mutation**.

The Worker never authors, launches, proxies, or judges the formal Reviewer. A
READY handoff must identify the exact implementation and carry
`review_request_id`, `source_ready_receipt_id`, and `reviewed_head_sha`; then the
Worker stops for one NEW fresh Reviewer.

## Roles (do not mix)

- Control — V10.6 activation, dependency, and transport exception boundary;
  never edits source directly or replaces the Worker or formal Reviewer.
- Worker — edits source inside its allowed paths; must run tests; writes a report; commits.
- Reviewer — NEW fresh context from a different family; never edits code or
  substitutes for the Worker; owns the formal `PASS` / `FIX_REQUIRED` / `BLOCKED`
  decision for the exact READY/head.
- Browser Action Runner (Sender) — browser writes only.
- Watcher — browser reads only; must contain no write APIs.
- LEGACY/NON-CURRENT Supervisor and Control Tower — historical GBB-001 … GBB-005
  process labels only; they are not V10.6 roles, persistent authority, or a
  current critical path.

No role may self-review, merge, release, invoke ORCA, claim unassigned work, or
expand the architecture unless the current exact card explicitly authorizes it.
A user relay is not a substitute for a missing durable receipt.

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
- Before READY, verify the exact base-to-head changed paths, `git diff --check`,
  the project tests, and a direct readback of the current durable receipts.

## Skills

Canonical skills live under `skills/<role>/SKILL.md` and are the single source of
truth. Do not maintain diverging copies for different CLI tools; if a tool loads
skills from a different location, create an adapter/copy from the canonical file
(see `ARCHITECTURE.md` and the existing `docs/ARCHITECTURE.md` "Skill loading
matrix").

The current V10.6 architecture pointer is [ARCHITECTURE.md](ARCHITECTURE.md).

## Security (summary; see docs/SECURITY.md)

- CDP binds to `127.0.0.1` only.
- Never log or commit cookies, session tokens, Authorization headers, Chrome profile
  content or ChatGPT account info.
- Allowed to log: conversation IDs from URLs, page titles, message counts, hashes,
  error codes, timestamps.
- Output directories must be validated and confined to the runtime root.
