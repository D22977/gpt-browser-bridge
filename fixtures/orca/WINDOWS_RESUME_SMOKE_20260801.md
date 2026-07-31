# GBB-004 Windows resume-chain live smoke transcript

- Date/time: 2026-08-01 04:41-04:47 Asia/Taipei
- Task name: `GPT_BROWSER_BRIDGE_RESUME`
- Worktree scripts: `C:\Users\Lupun\orca\workspaces\GPT_BROWSER_BRIDGE\gbb-004-a1\scripts`
- Isolated runtime: `C:\Users\Lupun\AppData\Local\Temp\GBB-004-RESUME-CANARY-20260801-044700-CODEX`
- Result: PASS; final task query failed as expected, both canary processes were
  gone, and the isolated runtime was removed.

## Preflight and registration

```text
COMMAND: Get-ScheduledTask -TaskName GPT_BROWSER_BRIDGE_RESUME -ErrorAction SilentlyContinue
EXIT_CODE: command unavailable in this PowerShell 7 installation
STDOUT_STDERR: Get-ScheduledTask is not recognized.

COMMAND: schtasks.exe /Query /TN GPT_BROWSER_BRIDGE_RESUME /FO LIST /V
EXIT_CODE: 0
STDOUT_STDERR: a task left by the prior attempt existed, Interactive only,
  Run As User=Lupun, with a malformed quoted action pointing at
  D:\AIWORK\GPT_BROWSER_BRIDGE\scripts\resume.ps1.
PARSE_RESULT: use the allowed `schtasks /query` fallback; overwrite this
  project-specific leftover, then unregister it at the end as required.

COMMAND: register-resume-task.ps1 -TaskName GPT_BROWSER_BRIDGE_RESUME -ResumeScript <worktree>\scripts\resume.ps1 -Runtime <isolated runtime> -Orca <real default Orca>
EXIT_CODE: 1
STDOUT_STDERR: ERROR: Value for '/TR' option cannot be more than 261 character(s).
PARSE_RESULT: repeated default Orca path made the action too long; script was
  repaired to omit `-Orca` only when it equals resume.ps1's fixed default.

COMMAND: register-resume-task.ps1 -TaskName GPT_BROWSER_BRIDGE_RESUME -ResumeScript <worktree>\scripts\resume.ps1 -Runtime <isolated runtime> -Orca <real default Orca>
EXIT_CODE: 0
STDOUT_STDERR:
SUCCESS: The scheduled task "GPT_BROWSER_BRIDGE_RESUME" has successfully been created.
registered: GPT_BROWSER_BRIDGE_RESUME

COMMAND: schtasks.exe /Query /TN GPT_BROWSER_BRIDGE_RESUME /FO LIST /V
EXIT_CODE: 0
STDOUT_STDERR (relevant fields):
TaskName:      \\GPT_BROWSER_BRIDGE_RESUME
Status:        Ready
Logon Mode:    Interactive only
Task To Run:   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Lupun\orca\workspaces\GPT_BROWSER_BRIDGE\gbb-004-a1\scripts\resume.ps1" -Runtime "C:\Users\Lupun\AppData\Local\Temp\GBB-004-RESUME-CANARY-20260801-044700-CODEX"
Run As User:   Lupun
Repeat:        Every 0 Hour(s), 5 Minute(s)
PARSE_RESULT: task_present=True action_has_worktree=True action_has_runtime=True
  interactive_only=True; registration used `/RL LIMITED /IT` from a normal,
  non-elevated shell.
```

## Stale heartbeat and duplicate lock

The isolated runtime contained a schema-valid RUNNING `project_state.json` and
this intentionally stale heartbeat before invocation:

```json
{"at":"2000-01-01T00:00:00+08:00","pid":99999,"state":"RUNNING"}
```

```text
COMMAND: resume.ps1 -Runtime <isolated runtime> -Orca <real Orca>
EXIT_CODE: 0
STDOUT_STDERR: start path launched the worktree supervisor; scheduler.log says
  `heartbeat stale ...; restarting supervisor`.

COMMAND: read <isolated runtime>\state\heartbeat.json and supervisor.lock
EXIT_CODE: 0
STDOUT_STDERR:
HEARTBEAT: {"at":"2026-08-01T04:45:45+08:00","pid":50656,"state":"RUNNING"}
LOCK:      {"pid":50656,"at":"2026-08-01T04:45:45+08:00"}
PARSE_RESULT: stale_heartbeat_started=True heartbeat_pid=50656 lock_pid=50656 alive=True

COMMAND: write the heartbeat stale again, then resume.ps1 -Runtime <isolated runtime> -Orca <real Orca>
EXIT_CODE: 0
STDOUT_STDERR:
supervisor_start pid=59208 stdout=<isolated runtime>\logs\supervisor-20260801-044623-122-c33d60dd.log stderr=<isolated runtime>\logs\supervisor-20260801-044623-122-c33d60dd.err.log

COMMAND: inspect exact PIDs, heartbeat, lock and duplicate stdout
EXIT_CODE: 0
STDOUT_STDERR:
HEARTBEAT: {"at":"2026-08-01T04:46:30+08:00","pid":50656,"state":"RUNNING"}
LOCK:      {"pid":50656,"at":"2026-08-01T04:46:30+08:00"}
DUPLICATE_STDOUT:
[boot] GBB supervisor starting (pid=59208) runtime=<isolated runtime>
[exit] GBB supervisor stopped: LOCK_NOT_OWNED
PARSE_RESULT: original_pid=50656 duplicate_pid=59208 original_alive=True
  duplicate_alive=False lock_pid=50656 duplicate_prevented=True
```

## Unregister and cleanup

```text
COMMAND: unregister-resume-task.ps1 -TaskName GPT_BROWSER_BRIDGE_RESUME
EXIT_CODE: 0
STDOUT_STDERR:
SUCCESS: The scheduled task "GPT_BROWSER_BRIDGE_RESUME" was successfully deleted.
unregistered: GPT_BROWSER_BRIDGE_RESUME

COMMAND: schtasks.exe /Query /TN GPT_BROWSER_BRIDGE_RESUME /FO LIST /V
EXIT_CODE: 1
STDOUT_STDERR: ERROR: The system cannot find the file specified.
PARSE_RESULT: task_absent=True

COMMAND: Stop-Process -Id 50656
EXIT_CODE: 0
PARSE_RESULT: exact_canary_pid=50656 alive_after=False

COMMAND: resolve and validate isolated runtime path (read only)
EXIT_CODE: 0
PARSE_RESULT: inside_temp=True exact_leaf=True exists=True

COMMAND: [System.IO.Directory]::Delete(<exact isolated runtime>, true)
EXIT_CODE: 0
PARSE_RESULT: runtime_absent=True

COMMAND: schtasks.exe /Query /TN GPT_BROWSER_BRIDGE_RESUME /FO LIST /V
EXIT_CODE: 1
STDOUT_STDERR: ERROR: The system cannot find the file specified.
FINAL_PARSE_RESULT: task_absent=True
```

No permanent PATH, power-plan, Windows Update, antivirus, credential, Chrome
profile or non-canary process was modified.

## Final continuation audit and cleanup

A continuation audit found that a later smoke attempt (created after the run
above) had recreated the same project task and left its isolated Supervisor
running. The task action pointed to this worktree and the isolated runtime
`C:\Users\Lupun\AppData\Local\Temp\GBB004R2`; it did not target the project
runtime.

```text
COMMAND: schtasks.exe /Query /TN GPT_BROWSER_BRIDGE_RESUME /FO LIST /V
EXIT_CODE: 0
STDOUT_STDERR (relevant fields):
TaskName:    \\GPT_BROWSER_BRIDGE_RESUME
Status:      Ready
Logon Mode:  Interactive only
Task To Run: powershell.exe ... <worktree>\scripts\resume.ps1 -Runtime <Temp>\GBB004R2
Last Run:    2026-08-01 04:52:48 +08:00
PARSE_RESULT: a later canary side effect remained and required exact cleanup.

COMMAND: unregister-resume-task.ps1 -TaskName GPT_BROWSER_BRIDGE_RESUME
EXIT_CODE: 0
STDOUT_STDERR: task successfully deleted; unregistered.

COMMAND: schtasks.exe /Query /TN GPT_BROWSER_BRIDGE_RESUME /FO LIST /V
EXIT_CODE: 1
STDOUT_STDERR: ERROR: The system cannot find the file specified.
PARSE_RESULT: task_absent=True

COMMAND: read <Temp>\GBB004R2 heartbeat/lock and inspect exact PID 40772
EXIT_CODE: 0
STDOUT_STDERR: heartbeat_pid=40772; lock_pid=40772; process=node.exe;
  command line=<worktree>\src\supervisor.mjs; start=2026-08-01 04:51:19 +08:00.
PARSE_RESULT: PID 40772 was the isolated smoke Supervisor, not a Control Tower
  or worker process.

COMMAND: Stop-Process -Id 40772 -Force; verify exact PID absent
EXIT_CODE: 0
PARSE_RESULT: PID_40772_STOPPED

COMMAND: resolve <Temp>\GBB004R2, validate Temp parent and exact leaf, then
  [System.IO.Directory]::Delete(resolvedPath, true)
EXIT_CODE: 0
PARSE_RESULT: inside_temp=True leaf=GBB004R2 runtime_absent=True
```

Final continuation state: the scheduled task, isolated runtime, and its exact
canary Supervisor process are all absent. The deletion was limited to the
validated disposable runtime and is not recoverable; no project/runtime data
or unrelated process was removed.
