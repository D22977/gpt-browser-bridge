# G13 Resident Runbook

## Deferred installation

The installer is intentionally print-only unless `-Apply` is supplied. The
definition targets the exact runtime launcher:

`D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\runtime\control-doorbell\run.ps1`

Preview the JSON definition without registering a task:

```powershell
pwsh -NoProfile -File .\scripts\register-g13-resident-task.ps1
```

Do not use `-Apply` during Task 1. A separate adoption decision must authorize
any Scheduled Task registration.

## Adoption boundary

Installation is not runtime adoption. Adoption requires a fresh independent
formal review, an explicit Control ACK, and a later physical canary. Until
those gates are satisfied, do not mutate the runtime, Scheduled Task, process,
browser, workflow, or physical Herdr transport.

The resident contract provides a deterministic process identity, an absolute
path-bound task definition, and a bounded restart policy. Reaching the restart
cap returns `RESTART_CAP_EXCEEDED` and is fail-closed.
