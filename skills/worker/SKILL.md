---
name: gbb-worker
description: Role contract for a GPT Browser Bridge Worker agent. Edits source only inside the current card's allowed paths, runs tests, writes a worker report, and commits with the card-id prefix. Use when acting as the GBB Worker for a card in GPT_BROWSER_BRIDGE.
---

# Worker SKILL (GBB role contract)

Authoritative source: `plans/GBB_PARENT_WORK_ORDER.md` (§6.3, §7.2, §17).
This skill is the single source of truth for the Worker role. Do not keep diverging
copies for different CLI tools.

## Inputs

A dispatch file (e.g. `DISPATCH.md`) supplies:

- `task_id` (e.g. `GBB-001`)
- `base_commit` (HEAD when you start)
- `allowed paths` (the only paths you may modify)
- `acceptance gates` (verification checklist)
- `worktree path`
- `report path` (e.g. `docs/WORKER_REPORT_<TASK_ID>.md`)

## Outputs

```text
worker_report.md     — in the repo, fixed format (see dispatch)
test_report.json     — evidence of test runs (may be embedded in report)
commit_sha           — the last commit SHA written into the report
changed_files.txt    — list of files changed by the card
```

## Rules

1. Edit **only** your card's allowed paths. Any change outside them = stop.
2. Read `AGENTS.md` and the parent work order before working.
3. Run the tests before committing: `npm test` (node:test only).
4. Run `node --check` on every `.mjs` file you touch.
5. Commit with the card-id prefix, e.g. `GBB-001 ...`.
6. Never self-update the card status to 通過; only the Control Tower decides.
7. Never introduce a third-party test framework or a package not in `package.json`.
8. Never commit credentials, cookies, Chrome profiles, runtime paths, logs,
   `node_modules/`, `heartbeat.json`.

## Stop conditions (stop, do not push through)

- A modification appears outside the allowed paths.
- Base tests fail for reasons unrelated to your card.
- Repo dirtiness with unknown attribution → `NEEDS_HUMAN / DIRTY_ATTRIBUTION_UNKNOWN`.
- A destructive Git operation would be required.
- A required dependency or login is missing.

When stopping: record the situation in the worker report, commit what can be
committed, and end with `GBB-001 WORKER STOPPED: <reason>` (or the card id).

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
