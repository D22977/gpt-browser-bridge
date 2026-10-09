# Windows Herdr agent and pane recovery

Use this runbook for Windows Herdr-native Codex workers. GitHub is the durable work
authority; live Herdr inventories establish current local identity and liveness.

## Managed start evidence and bounded recovery

The observed managed-start attempt built an argument-bearing
`Start-Process -FilePath codex` command and returned PowerShell
`InvalidOperationException: "%1 is not a valid Win32 application."` Herdr later
timed out without a named worker or native session. A separate no-profile check
reproduced failure for bare `codex --version`, while the fully qualified npm
`codex.cmd --version` succeeded as Codex CLI 0.161.0. This points to Windows
executable resolution on the argument-bearing managed path as the likely failure
boundary. The exact executable selected by bare `codex` is **UNKNOWN**: `where.exe`
ordering does not prove `Start-Process` selection. The POSIX shim explanation is an
inference, not an established fact, and there is no evidence that `codex.ps1` was
selected. The installed Herdr binary was reported as 0.8.2, but no binary hash or
build provenance ties it to the reviewed source.

The bounded recovery is an explicitly authorized launch through a freshly bound
Herdr pane, using the fully qualified `codex.cmd` path and only the model, effort,
arguments, cwd, and file scope allowed by that card. For example, the command shape
is:

```powershell
herdr pane run <pane-id> "& '<fully-qualified-codex.cmd>' --model <model> -c model_reasoning_effort=<effort> <card-authorized-arguments>"
```

Confirm the new native agent/session and exact pane tuple from live inventories
before sending one task pointer. This entry point was observed to host two detectable Codex sessions on the
recorded installation; it does not exercise managed executable selection, pending
name registration, exact terminal readiness, or managed failure reporting. It is
not a fix to the managed path. Any managed-start implementation change requires a
separate source work order, tests, and fresh independent review before runtime use.

Evidence: [architecture review #199/6079659712](https://github.com/D22977/gpt-browser-bridge/issues/199#issuecomment-6079659712), [explicit pane launch #195/6061704322](https://github.com/D22977/gpt-browser-bridge/issues/195#issuecomment-6061704322).

## Bind the live agent and pane

Before targeting, recovering, or considering cleanup of an agent, read both live
inventories for the current workspace:

```powershell
herdr agent list
herdr pane list --workspace $env:HERDR_WORKSPACE_ID
```

Repeat both reads immediately and require the exact candidate tuple to match. Use
`herdr agent get <pane-id>` to inspect that bound candidate. Record the GitHub card,
agent name, exact launch invocation (including model and reasoning effort), native
session ID, workspace, pane ID, terminal ID, cwd, status, and observation time.
Model labels, terminal titles, shell panes, stale receipts, raw PIDs, and absent
parent PIDs are not executor identity. A shell pane without a matching native
session is not a bound Worker.

## Reconcile states before reuse

- **WORKING:** a current agent/session is bound to the pane and its task is still
  active. Do not redirect or reuse it.
- **IDLE:** Herdr reports no active work in the pane. Idle alone does not mean stale
  or available: reconcile the exact pane/session against its durable card first.
- **TERMINAL:** the exact Worker terminal is durably recorded on GitHub. That does
  not prove the associated pane has closed; inspect the live inventory.
- **UNRESOLVED:** the pane, session, card, or terminal mapping is absent, stale, or
  conflicting. Preserve it and publish a typed Control-required blocker.

Reconcile every idle pane to its exact card before reuse or cleanup. Do not infer a
process leak from process counts or missing parent PIDs. A helper failure before
process creation is not evidence of a Herdr multi-agent limit. The inventory
correction in [#195/6080346532](https://github.com/D22977/gpt-browser-bridge/issues/195#issuecomment-6080346532)
records this distinction and the unresolved card mappings.

## Safe cleanup boundary

Never broadly terminate Codex, `node_repl`, or other processes, and never close an
existing pane as housekeeping. Cleanup is allowed only when all of these conditions
hold:

1. Two fresh matching inventories and the exact agent get bind the current pane,
   terminal, native session, and cwd.
2. The same card has an exact Worker terminal, and no same-session recovery remains
   authorized.
3. A durable Control card explicitly authorizes cleanup of that exact pane/session.

Then use only the exact native Herdr stop/close action named by that authority, and
read back the agent and pane inventories. If any condition is missing or conflicts,
preserve the pane and publish `CONTROL_REQUIRED`. Never substitute PID-based or
broad process cleanup. See [#195/6080489374](https://github.com/D22977/gpt-browser-bridge/issues/195#issuecomment-6080489374)
for a bounded exact-pane example.

## Dispatch and reboot recovery

Do not send a new prompt, retry, resume, elevate sandbox access, or replace a worker
from an idle or uncertain pane without explicit authority in that exact card. After
a reboot, reread the live GitHub card and receipts first, then acquire fresh matching
Herdr inventories and bind new pane/session identities. Do not reuse historical
panes or infer that a worker consumed a prompt from a dispatch receipt. A helper
failure before process creation is a helper blocker; it does not establish that
Herdr cannot run multiple agents. Keep `CLAIM_REQUESTED`, `CLAIM_ACCEPTED`,
`CONSUMED_STARTED`, and the exact terminal as separate durable states.
