# GPT Browser Bridge ORCA Runbook

This runbook is for the operator and Control Tower. The Supervisor is a
deterministic recovery process: it may repair terminal routing, but it never
decides `通過` / `退修`, edits source, or resends a ChatGPT prompt.

## Fixed paths and names

```text
Repo:       D:\AIWORK\GPT_BROWSER_BRIDGE
Runtime:    D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE
ORCA CLI:   C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe
Task:       GPT_BROWSER_BRIDGE_RESUME
```

Terminal titles use the numeric task portion once (for example, task `004`):

```text
GBB-004-A1-control
GBB-004-A1-worker
GBB-004-A1-reviewer
GBB-004-A1-watcher
```

The title plus `run_id` is durable identity. A terminal handle is only a
runtime-scoped route and must be re-acquired after an ORCA restart.

The 2026-08-01 live canary is recorded in
`fixtures/orca/LIVE_CANARY_20260801.md`. On the installed CLI, terminal
commands are top-level (`orca terminal ...`), not
`orca orchestration terminal ...`. From a shell whose cwd is not recognized
by the runtime, `--worktree active` can fail even when `worktree list` contains
the checkout; use the exact `path:<forward-slash-path>` selector captured by
`orca worktree list --json`.

## Preflight

Run in PowerShell as the logged-in project user. These commands are read-only:

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' skills get orca-cli
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' skills get orchestration
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' status --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' worktree current --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal list --worktree active --json
```

If `status` says the runtime is not ready, do not guess terminal state. Record
the time and let the Supervisor use the 30/60/180/300-second policy. After 20
continuous minutes it must stop at `NEEDS_HUMAN / ORCA_UNAVAILABLE`.

## Start or resume the Supervisor

Create the runtime directories once, then start through the checked-in script:

```powershell
$Runtime = 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE'
New-Item -ItemType Directory -Force -Path "$Runtime\state", "$Runtime\locks", "$Runtime\jobs", "$Runtime\runs", "$Runtime\events", "$Runtime\logs" | Out-Null
& 'D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\start-supervisor.ps1' -Runtime $Runtime -Orca 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe'
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\heartbeat.json' -Raw
Get-ChildItem 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\logs\supervisor-*.log' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 |
  Get-Content -Tail 50
```

`heartbeat.json` should refresh every 15 seconds. A second invocation exits
when the lock names another live PID. A stale lock is reclaimed only after its
PID is confirmed dead.

The scheduled/manual idempotent entry point is:

```powershell
& 'D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\resume.ps1' -Runtime 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE' -Orca 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe'
```

It starts the Supervisor only when the heartbeat is absent or older than 45
seconds; `supervisor.lock` is the second duplicate-process guard.

## Control Tower orchestration flow

The Control Tower owns decisions and structured task lifecycle. The Supervisor
does not run these commands on its behalf.

Create/bind a Run, create the Task, create a correctly named fresh terminal,
and attach the Dispatch:

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration run-create --objective 'Complete and review GBB-004 serially' --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration task-create --spec 'GBB-004 Worker: implement only the allowed paths, test, report, and commit' --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal create --worktree active --title 'GBB-004-A1-worker' --command 'codex' --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal wait --terminal '<worker_handle>' --for tui-idle --timeout-ms 60000 --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration dispatch --task '<task_id>' --to '<worker_handle>' --inject --json
```

Wait for durable lifecycle messages, process every message in the returned
Delivery, then acknowledge that Delivery before waiting again:

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration check --ack '<delivery_id>' --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

Before claiming a dispatch exists or is complete:

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration task-list --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration dispatch-show --task '<task_id>' --json
```

Reviewer dispatch must use a new terminal and a different agent/model family.
Never inject an unfinished Reviewer conclusion into the replacement prompt:

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal create --worktree active --title 'GBB-004-A1-reviewer' --command 'claude' --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal wait --terminal '<reviewer_handle>' --for tui-idle --timeout-ms 60000 --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration dispatch --task '<review_task_id>' --to '<reviewer_handle>' --inject --json
```

## Terminal recovery checks

Never send to a remembered handle until it appears in a fresh list:

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal list --worktree active --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal show --terminal '<fresh_handle>' --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal read --terminal '<fresh_handle>' --limit 200 --json
```

If the old handle is absent but the exact title exists, relink
`project_state.json` to the listed handle. Do not create another terminal. If
the title is absent, use `runs\<run_id>\dispatch.json`; never invent the
worktree, title, or command from memory.

If duplicate exact-title candidates exist, the adapter ignores disconnected,
read-only or orphaned entries, then chooses newest `lastOutputAt` with a stable
handle tie-breaker and records the ambiguity. A fresh `terminal list` remains
authoritative. The installed CLI was also observed to remove a terminal while
`terminal close` returned exit 1 / `runtime_error: tab_not_found`; always
re-list before concluding that cleanup or invalidation failed.

Supervisor recovery output is durable in:

```text
D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\events\events.ndjson
D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\runs\<run_id>\recovery.log
D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\project_state.json
```

## Task Scheduler

Register exactly one current-user, non-elevated task that runs every five
minutes:

```powershell
& 'D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\register-resume-task.ps1' -TaskName 'GPT_BROWSER_BRIDGE_RESUME' -ResumeScript 'D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\resume.ps1'
schtasks.exe /Query /TN 'GPT_BROWSER_BRIDGE_RESUME' /V /FO LIST
```

`register-resume-task.ps1` also accepts `-Runtime` and `-Orca`. It omits the
Orca argument from the scheduled action when it equals the fixed default, to
stay below the Windows 261-character `/TR` limit. `Get-ScheduledTask` may be
unavailable under PowerShell 7; `schtasks.exe /Query` is the verified fallback.
The executed register/stale-start/duplicate-lock/unregister transcript is
`fixtures/orca/WINDOWS_RESUME_SMOKE_20260801.md`.

Remove it only when intentionally disabling automatic resume:

```powershell
& 'D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\unregister-resume-task.ps1' -TaskName 'GPT_BROWSER_BRIDGE_RESUME'
```

The task runs only while this user is logged in, uses limited privileges, and
must not alter global `PATH`, Windows Update, antivirus, or power plans.

## Keep-awake constraints

`keep-awake.ps1` requests `ES_SYSTEM_REQUIRED` for a Supervisor session and
releases it on exit. It does not keep the display on and does not change the
permanent power plan.

```powershell
& 'D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\keep-awake.ps1'
& 'D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\keep-awake.ps1' -Release
```

This is not a durability guarantee: laptop lid close, logout, power loss, OS
restart, or a killed process can still interrupt work. Recovery depends on
durable state and checkpoints, not on keep-awake.

## Hard stops

Stop and set a concrete `NEEDS_HUMAN` reason for authentication walls,
CAPTCHA, unknown Git dirt, missing checkpoint/worktree, insufficient
permission, three failed terminal restarts, or 20 minutes of ORCA outage.
Never use `git reset --hard`, `git clean`, `git stash`, automatic login,
automatic Continue, or ChatGPT prompt resend as recovery.
