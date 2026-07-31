# GPT Browser Bridge Morning Checklist

Use this checklist before accepting any overnight claim. Treat the summary as
an index; confirm it against state, Git, tests, reports, and current ORCA data.

## 1. Read durable state in order

```powershell
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\morning_summary.md' -Raw
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\project_state.json' -Raw
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\heartbeat.json' -Raw
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\events\events.ndjson' -Tail 100
```

Confirm the summary has:

- `generated_at`, `project_state`, task/attempt, last checkpoint, active
  processes, latest commit, tests, Reviewer, browser, and ORCA status.
- Completed/In progress/Recoveries/Blockers/Human actions/Resume command/Files
  sections.
- A generation time no more than 30 minutes old while the Supervisor is
  running.

Interpret state strictly:

- `COMPLETED`: still verify commit, tests, and a fresh Reviewer `通過`.
- `RUNNING` or a waiting state: `next_action` must be concrete.
- `NEEDS_HUMAN`: stop automation and resolve `blocked_reason` first.
- `CANCELLED`: do not resume.

## 2. Verify repo and latest commits

```powershell
git -C 'D:\AIWORK\GPT_BROWSER_BRIDGE' status --short
git -C 'D:\AIWORK\GPT_BROWSER_BRIDGE' log -10 --oneline --decorate
git -C 'D:\AIWORK\GPT_BROWSER_BRIDGE' show --stat --oneline HEAD
```

Confirm every card commit starts with its card ID (for this card, `GBB-004 `),
contains only allowed paths, and does not include runtime files, credentials,
cookies, Chrome profiles, logs, `heartbeat.json`, or dispatch scratch files.

For an active worktree, use the path recorded in
`runs\<run_id>\dispatch.json`, then run:

```powershell
git -C 'D:\AIWORK_WT\GPT_BROWSER_BRIDGE\GBB-004-A1' status --short
git -C 'D:\AIWORK_WT\GPT_BROWSER_BRIDGE\GBB-004-A1' diff --name-only
```

Unknown dirt is `NEEDS_HUMAN / DIRTY_ATTRIBUTION_UNKNOWN`; never clean, stash,
or reset it.

## 3. Read test and role reports

```powershell
$State = Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\project_state.json' -Raw | ConvertFrom-Json
$Run = "D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\runs\$($State.active_run_id)"
Get-Content "$Run\test_report.json" -Raw -ErrorAction SilentlyContinue
Get-Content "$Run\worker_report.md" -Raw -ErrorAction SilentlyContinue
Get-Content "$Run\reviewer_report.md" -Raw -ErrorAction SilentlyContinue
Get-Content "$Run\recovery.log" -Tail 100 -ErrorAction SilentlyContinue
```

Check evidence, not the Worker summary:

- Test command is `npm test` (`node --test "tests/**/*.test.mjs"`) with zero
  failures.
- Every touched `.mjs` has a successful `node --check` record.
- Worker changed only card-allowed paths and committed locally.
- Reviewer used fresh context, inspected the actual diff/tests, and concluded
  exactly one of `通過` / `退修` / `受阻`.
- `退修` returns the smallest finding-scoped repair to Worker. Supervisor does
  not make that decision.

## 4. Verify ORCA and orchestration live state

Always re-list; do not trust handles copied from the summary:

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' status --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal list --worktree active --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration run-list --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration task-list --json
```

For each active task:

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration dispatch-show --task '<task_id>' --json
```

Verify the terminal title matches exactly one expected role:

```text
GBB-<TASK>-A<ATTEMPT>-control
GBB-<TASK>-A<ATTEMPT>-worker
GBB-<TASK>-A<ATTEMPT>-reviewer
GBB-<TASK>-A<ATTEMPT>-watcher
```

If the title exists with a new handle, that is an ORCA relink, not permission
to create a duplicate. If no title exists, verify `dispatch.json` before any
rebuild.

## 5. Verify browser job durability

List job directories, then inspect only `job.json` and `result.json` for the
active job (do not print credentials/profile data):

```powershell
Get-ChildItem 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\jobs' -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 10 Name,LastWriteTime
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\jobs\<job_id>\job.json' -Raw
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\jobs\<job_id>\result.json' -Raw -ErrorAction SilentlyContinue
```

- `result.json` present: the job reached a durable Watcher result.
- `reply.md` without `result.json`: non-terminal; resume the same Watcher job.
- `login_wall`: `NEEDS_HUMAN / AUTH_REQUIRED`; no auto-login.
- `cdp_unreachable`: look for `browser_recovery_required`; use only the
  approved Chrome start script, then recover by conversation URL.
- Never resend the ChatGPT prompt or press Continue automatically.

## 6. Verify Scheduler and keep-awake assumptions

```powershell
schtasks.exe /Query /TN 'GPT_BROWSER_BRIDGE_RESUME' /V /FO LIST
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\logs\scheduler.log' -Tail 50 -ErrorAction SilentlyContinue
```

Confirm the task runs every five minutes, only while the current user is
logged in, and at limited privilege. Keep-awake only suppresses system sleep
during a live session; it does not prevent display-off, lid-close, logout,
power loss, or restart and must not alter a permanent power plan.

## 7. Decide the morning action

Use exactly one branch:

1. `COMPLETED` plus green tests plus fresh Reviewer `通過`: hand the evidence
   package to the Control Tower/final gate; do not let Supervisor close it.
2. Running/waiting with fresh heartbeat and live matching terminal: leave it
   running; do not duplicate.
3. Stale heartbeat with non-terminal state: run the exact resume command:

   ```powershell
   & 'D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\resume.ps1' -Runtime 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE' -Orca 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe'
   ```

4. `退修` or failing tests: Control Tower creates the smallest Worker repair
   task within the same-card limit.
5. `NEEDS_HUMAN`, unknown dirt, authentication/CAPTCHA, missing checkpoint,
   three terminal crashes, or 20-minute ORCA outage: keep stopped, preserve
   evidence, and resolve manually.

Record the decision and evidence paths before changing project state.
