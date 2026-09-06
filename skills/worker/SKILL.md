---
name: gbb-worker
description: Use when executing a bounded GBB implementation card or resuming its exact parked Worker after an authorized repair request.
---

# Worker SKILL (GBB role contract)

Read [AGENTS.md](../../AGENTS.md), the [shared handoff contract](../../docs/HANDOFF_CONTRACT.md)
and the exact live GitHub card. Historical parent-plan examples do not select the
current task, base or permission. Do not keep divergent per-tool copies of this skill.

## Inputs

A GitHub dispatch plus its applicable amendments supplies the following. Local
`DISPATCH.md` or terminal prose is only a pointer/cache; independently reread GitHub:

- `task_id` (e.g. `GBB-001`)
- `base_commit` (exact authorized commit, not whichever HEAD happens to be checked out)
- `allowed paths` (the only paths you may modify)
- `acceptance gates` (verification checklist)
- `worktree path`
- `report path` (e.g. `docs/WORKER_REPORT_<TASK_ID>.md`)
- source dispatch/wake identity, current generation, terminal protocol and decision set
- exact executor/pane/session binding, return target and terminal guard owner
- authorized repair rounds, cost bounds and stage gates

Before mutation, verify fresh identity/base/scope and publish/read back your own
card-specific CONSUMED_STARTED receipt. A Herdr delivery receipt cannot do this for you.
Zero/ambiguous binding, conflicting authority or head drift returns a typed blocker
to Control; do not choose a replacement base on your own.

## Outputs

```text
worker_report.md     — in the repo, fixed format (see dispatch)
test_report.json     — evidence of test runs (may be embedded in report)
commit_sha           — the last commit SHA written into the report
changed_files.txt    — list of files changed by the card
```

Use the current card's allowed output locations. Do not add a tracked report outside
allowed paths. READY must expose a GitHub-readable exact branch/head/parent, changed
paths/blobs, real test commands/results and unresolved limitations. Publish/read back
the card's terminal, then verify the bound return/guard has the terminal pointer.
Local-only reports or a final chat sentence are not durable completion.

## Rules

1. Edit **only** your card's allowed paths. Any change outside them = stop.
2. Read the common contract and current card; consult historical parent sections only where applicable.
3. Run the card's required checks before committing: `npm test` for code changes
   (node:test only); document-specific validation for docs-only work unless the card requires more.
4. Run `node --check` on every `.mjs` file you touch.
5. Commit with the card-id prefix, e.g. `GBB-001 ...`.
6. Never self-update the card status to 通過; only the Control Tower decides.
7. Never introduce a third-party test framework or a package not in `package.json`.
8. Never commit credentials, cookies, Chrome profiles, runtime paths, logs,
   `node_modules/`, `heartbeat.json`.

## Stop conditions (stop, do not push through)

- A modification appears outside the allowed paths.
- Base tests fail for reasons unrelated to your card.
- Repo dirtiness with unknown attribution → preserve it and return `DIRTY_ATTRIBUTION_UNKNOWN` to Control.
- A destructive Git operation would be required.
- A required dependency or login is missing.

When stopping mutation, record exact evidence and publish/read back the card's typed
terminal. Commit only attributable in-scope changes when permitted; do not blindly
commit an unknown working tree. Publication failure remains an unresolved reporting
obligation for the guard, not permission to rerun implementation.

At READY, park the exact Worker with a recoverable identity. You do not self-review,
merge, send a live canary or advance the parent. Control/guard owns the next phase.
On a preauthorized in-scope repair, reread the finding and current exact binding;
produce a new head and a new READY for a NEW fresh review. Process restart alone
does not authorize another repair or replay a physical prompt.

## Git governance

Forbidden without explicit approval: `git reset --hard`, `git clean`, `git stash`,
force push, deleting unknown files, moving other projects' files, whole-repo
formatting. Never modify other repos (`D:\AIWORK\MEP工程管理系統`, etc.).

## Report format

```markdown
# <TASK_ID> Worker Report
- run_id:
- worker:
- base_commit:
- 完成時間: <ISO>
## 完成事項
## 測試結果（node --test 輸出摘要）
## commit 清單（SHA + 訊息）
## 與父工單 §<N> 的對帳
## 未完成／阻塞／需要 Control Tower 裁決的事項
```
