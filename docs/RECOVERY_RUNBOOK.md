# GPT Browser Bridge Recovery Runbook

Use this after any Supervisor, ORCA, role terminal, Chrome/CDP, network, Git,
or host interruption. The order is deliberate: read durable evidence before
touching a terminal.

## First five minutes

```powershell
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\morning_summary.md' -Raw
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\project_state.json' -Raw
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\events\events.ndjson' -Tail 100
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\heartbeat.json' -Raw
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' status --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal list --worktree active --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration task-list --json
```

Then inspect the active run and worktree without modifying either:

```powershell
$State = Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\project_state.json' -Raw | ConvertFrom-Json
Get-Content "D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\runs\$($State.active_run_id)\dispatch.json" -Raw
git -C 'D:\AIWORK_WT\GPT_BROWSER_BRIDGE\GBB-004-A1' status --short
git -C 'D:\AIWORK_WT\GPT_BROWSER_BRIDGE\GBB-004-A1' diff --name-only
```

If `project_state` is `COMPLETED`, `CANCELLED`, or `NEEDS_HUMAN`, do not start
a new agent. `NEEDS_HUMAN` can return to `RUNNING` only after the human and
Control Tower resolve the recorded blocker.

## Retry ceilings

| Failure | Automatic retry | Escalation |
| --- | --- | --- |
| Same role terminal/process | 10s, 30s, 120s; at most 3 creates | `NEEDS_HUMAN / REPEATED_TERMINAL_CRASH` |
| ORCA unavailable | 30s, 60s, 180s, then 300s cap | 20 continuous minutes: `NEEDS_HUMAN / ORCA_UNAVAILABLE` |
| Worker rework on same card | Control Tower may dispatch at most 2 repair attempts | Third: `NEEDS_HUMAN / REPEATED_REWORK` |
| Chrome login wall | none | `NEEDS_HUMAN / AUTH_REQUIRED` |

The 15-second Supervisor tick is not permission to call ORCA every 15 seconds;
it must honor the persisted ORCA retry deadline.

## Crash recovery matrix

| Fault | Required action | Evidence | Never |
| --- | --- | --- | --- |
| Supervisor killed / stale heartbeat | `resume.ps1`; dead-owner lock takeover | new heartbeat PID/time | start duplicate loops |
| Worker CLI crash | same worktree and command from `dispatch.json`; read checkpoint | `terminal_rebuilt`, recovery log | reset/clean/stash |
| Reviewer crash | new terminal, fresh context, independent review | new handle; no stale conclusion in prompt | reuse unfinished verdict |
| Control Tower crash | rebuild control terminal; deliver resume prompt | state unchanged except handle/checkpoint | decide for Control Tower |
| Watcher crash | restart command for the same `job_id` | same job directory and URL | resend prompt |
| ORCA restart | fresh `terminal list`; exact title/run match | `terminal_relinked` old/new handle | trust cached handle |
| Chrome/CDP crash | request approved Chrome start; reattach by conversation URL | `browser_recovery_required` event | auto-login/resend |
| Network outage | bounded read reattach after wait | retry events/result; same job | resend |
| Unknown Git dirt | pause and write `dirty_attribution_report.md` | report lists status/diff | clean/stash/reset |
| Test failure | Control Tower sends the smallest repair back to Worker | test + Worker/Reviewer reports | ignore or Supervisor verdict |
| Three terminal failures | stop in `NEEDS_HUMAN` | exhausted event and blocker | fourth create/infinite loop |
| `reply.md` exists, `result.json` absent | treat job as non-terminal; resume Watcher | no `job_result` event yet | mark DONE |

## Role-specific procedures

### Supervisor crash or stale heartbeat

The heartbeat is stale after 45 seconds. Use the idempotent entry point:

```powershell
& 'D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\resume.ps1' -Runtime 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE' -Orca 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe'
Start-Sleep -Seconds 3
Get-Content 'D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\heartbeat.json' -Raw
```

If another live PID owns `supervisor.lock`, the new process must exit. Do not
delete the lock merely because its timestamp looks old; PID liveness is the
ownership check.

The checked-in scripts resolve `src/supervisor.mjs` from their own
`$PSScriptRoot`, so a worktree smoke test cannot silently launch the main-repo
copy. Each launch uses unique stdout/stderr files, allowing the duplicate
process to record `LOCK_NOT_OWNED` without competing for one redirected log.
See `fixtures/orca/WINDOWS_RESUME_SMOKE_20260801.md` for the live PID/lock
evidence and final no-task/no-runtime cleanup checks.

### Worker terminal crash

1. Read `runs\<run_id>\dispatch.json`.
2. Run `git status --short` and `git diff --name-only` in the checkpointed
   worktree.
3. If clean, rebuild exactly that worktree/title/command.
4. Deliver the deterministic resume prompt and read checkpoint files first.
5. If dirty attribution is unknown, write the report and stop.

Manual diagnostic commands (normally the Supervisor performs the rebuild):

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal create --worktree 'path:D:\AIWORK_WT\GPT_BROWSER_BRIDGE\GBB-004-A1' --title 'GBB-004-A1-worker' --command 'codex' --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal wait --terminal '<new_handle>' --for tui-idle --timeout-ms 60000 --json
```

### Reviewer terminal crash

Create a new terminal/session. Its first instruction must say to start from a
fresh context and not reuse an incomplete/stale conclusion. It may read the
work order and artifacts, but only a newly performed review can produce
`通過` / `退修` / `受阻`.

### Control Tower terminal crash

Relist before rebuilding:

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal list --worktree active --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration run-list --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration inbox --limit 50 --json
```

If the title is absent, rebuild `GBB-<TASK>-A<ATTEMPT>-control` from the
checkpoint and deliver the resume prompt. The Supervisor leaves the project
phase/verdict untouched.

### Watcher, network, and half-committed result

The immutable `job.json` supplies the original `job_id`, baseline, and
conversation URL. Restart the Watcher command from `dispatch.json`; it
reattaches and reads. Never invoke `gpt_send.mjs` during recovery.

Only `result.json` makes a browser job terminal. `reply.md`, a temporary file,
or terminal text alone is insufficient. A crash between atomic renames is
therefore resumable and must not be reported as DONE.

### ORCA restart and stale handle

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' status --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' terminal list --worktree active --json
```

Match the exact title/run. Relink if found; create only when no title match
exists. Never send to both old and new handles.

### Chrome/CDP crash and login wall

The Supervisor emits a `browser_recovery_required` event containing the
`job_id`, original `conversation_url`, and fixed flags `resend:false` and
`auto_login:false`. The Control Tower may run only a human-approved fixed
script. This card does not invent or approve one:

```powershell
$ApprovedChromeStart = 'D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\start-automation-chrome.ps1'
if (-not (Test-Path -LiteralPath $ApprovedChromeStart)) { throw 'NEEDS_HUMAN: approved automation Chrome start script is absent' }
& $ApprovedChromeStart
```

After Chrome is reachable, restart the same Watcher job so it resolves the tab
by `conversation_url`. If ChatGPT presents a login wall, stop at
`NEEDS_HUMAN / AUTH_REQUIRED`; a human logs in. Never capture or log cookies,
tokens, credentials, or profile contents.

### Unknown Git dirt

The only permitted Git probes are read-only. Preserve their exact output in:

```text
D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\runs\<run_id>\dirty_attribution_report.md
```

Do not start the replacement Worker until the human attributes the files.

### Test failure and rework

The Supervisor forwards durable report events only. The Control Tower reads the
actual test output and Reviewer report, then creates the smallest Worker repair
task. Example lifecycle inspection:

```powershell
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration dispatch-show --task '<review_task_id>' --json
& 'C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe' orchestration task-create --spec 'Repair only the Reviewer-listed GBB-004 findings; add regression tests; do not broaden scope' --json
```

The Supervisor never converts a Reviewer conclusion into a state transition.

## Recovery acceptance check

After any automatic recovery, verify all five:

1. `project_state.json` still names the same run/checkpoint unless the Control
   Tower intentionally changed it.
2. `recovery.log` records reason, timestamp, old handle, and new handle.
3. No Sender command ran and no prompt was resent.
4. Terminal creates did not exceed three for the same role/step.
5. `events.ndjson` and `morning_summary.md` reflect the recovery or blocker.
