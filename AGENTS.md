# AGENTS.md — GPT Browser Bridge build-agent rules

These rules apply to any agent that works in this repository. The authoritative
project rules are in `plans/GBB_PARENT_WORK_ORDER.md` (§6 roles, §7 skills, §17 Git
governance, §18 security). This file is the repo-local summary for build agents.

## Repo purpose

Implement GPT Browser Bridge as work orders (GBB-001 … GBB-005) governed by one semantic
Control Tower and a dependency DAG. Each card has one Worker in an isolated worktree;
independent cards may use at most two concurrent Worker lanes and require fresh-context
review from a different agent/model family. The GBB-001 … GBB-005 chain remains
sequential where review dependencies require it. Current project_state/contracts/
Supervisor behavior is legacy single-active-run; runtime multi-lane support is
NOT_IMPLEMENTED.

## Roles (do not mix)

- Control Tower — only decision point; never edits source directly.
- Worker — edits only card-allowed paths, follows the card's check scope, writes a report and commits. Code cards run their required tests; documentation-only cards explicitly marked NOT_RUN_BY_SCOPE do not run tests.
- Reviewer — fresh-context review; never edits code; conclusion only `通過` / `退修` / `受阻`.
- Browser Action Runner (Sender) — browser writes only.
- Watcher — browser reads only; must contain no write APIs.
- Supervisor — deterministic process; recovers terminals; never decides pass/rework.

## Worker lanes and phase closeout

- Only one semantic Control decision owner and one deterministic Supervisor instance are authorized. The canonical Control scheduler is GBB_G13_RESIDENT / IgnoreNew; GBB_TEMP_CONTROL_DOORBELL stays disabled and preserved per Issue #162 receipt 6017178735. Worker parallelism never uses parallel Control/Supervisor instances.
- Model cards as a dependency DAG with a default maximum of two concurrent Worker lanes. Start a lane only after its explicit accepted terminal/review prerequisites are satisfied.
- Parallelize only independent cards with isolated worktrees, disjoint allowed paths, separate artifacts, unique card/run/idempotency identities, and executor-authored receipts. Serialize same-path edits, shared mutable resources, and dependent cards.
- Preserve CARD_EXISTS → DISPATCH_REQUEST_WRITTEN → CONSUMED_STARTED → TERMINAL_RESULT → FRESH_REVIEW (when required) → CONTROL_ACK. A terminal alone never advances a dependent card.
- At phase closeout, Control reconciles each required lane's exact head, changed paths, terminal, fresh review, conflicts, and blockers; updates durable state/indexes; then issues only exact legal successors. Proven independent lanes may continue while a non-dependent lane is blocked.
- The current project_state/contracts/Supervisor runtime supports one active run only. Multi-lane runtime support is NOT_IMPLEMENTED. A separate reviewed implementation card must extend multi-lane state, recovery, deduplication, and stage-closeout receipts before runtime adoption or capability claims.
- Preserve fail-closed behavior, no-blind-retry, exact base/head binding, fresh independent reviews, and zero user task/result relay. Do not add a router, generic queue, second authority store, or scheduler.

## Building / testing

These build/test defaults apply to code cards. A documentation-only card explicitly
marked NOT_RUN_BY_SCOPE does not run tests or change test/runtime behavior.

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
