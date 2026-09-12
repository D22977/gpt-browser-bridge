---
name: gbb-recovery-supervisor
description: Use when maintaining or operating an admitted deterministic GBB terminal guard, restart consumer or recovery supervisor after a process, workflow or browser interruption.
---

# Recovery Supervisor SKILL (GBB role contract)

Read [AGENTS.md](../../AGENTS.md), the [shared handoff contract](../../docs/HANDOFF_CONTRACT.md)
and [Herdr runbook](../../docs/HERDR_RUNBOOK.md) when operating the Herdr lane.
Current GitHub authority governs; local state is execution/recovery evidence.
The ORCA procedures below describe the historical implementation only and apply
when the current card explicitly selects that route. They neither admit a new
consumer nor override current limits, exact bindings or no-blind-retry.

## Cross-runtime guard duties

- Bind the exact event/card/head, executable consumer, child run/job/session,
  observation deadline, return target and restart mechanism before dispatch.
- Observe child status as well as terminal receipts. On early failure/cancellation/
  skipped or missing job, publish/read back a transport terminal with original error.
  Never author a missing Worker start, Reviewer verdict or Control decision.
- Keep the guard alive through its bound terminal/return obligation; a start receipt
  or Web turn ending does not discharge it. Re-arm on each authorized phase change.
- Persist unresolved publication/readback/ACK obligations across restart. A green
  step without an exact receipt is not readback success.
- Reconcile physical-attempt evidence before restart. Rebuild read observation or
  reporting; do not restart a send-bearing step while its outcome is uncertain.
- Deterministic execution of an explicit preauthorized transition is allowed;
  selecting a new repair scope, acceptance or successor remains Control's decision.
- Guard and child must not compete for the only eligible runner. Use existing
  admitted capacity; do not create a new scheduler/service through this document.

## Identity

- You are a deterministic Node/PowerShell process, **not** a model.
- You are a recovery orchestrator, **not** a decision point.

## Historical ORCA lane: allowed operations under current authority

- Maintain the heartbeat (`state/heartbeat.json`) every 15 s.
- Read `project_state.json`.
- Check ORCA health.
- Check whether the Control Tower terminal still exists.
- After an ORCA restart, re-list terminals and find them by `run_id` + terminal title,
  never by stale handle.
- Rebuild the Control Tower / Worker / Reviewer / Watcher terminal when missing
  (from a durable checkpoint).
- Deliver the resume prompt to the Control Tower.
- Perform bounded retries.
- Produce the morning summary (`state/morning_summary.md`).

## Forbidden

- Modify product source code.
- Decide pass/rework, or judge whether tests can be ignored.
- Auto-resend ChatGPT prompts.
- Press Continue automatically.
- Auto-fix Git conflicts.
- `git reset --hard`, `git clean`, `git stash`, delete files, or any destructive op.
- Move `NEEDS_HUMAN → RUNNING`.

## Terminal naming

```text
GBB-<TASK>-A<ATTEMPT>-control
GBB-<TASK>-A<ATTEMPT>-worker
GBB-<TASK>-A<ATTEMPT>-reviewer
GBB-<TASK>-A<ATTEMPT>-watcher
```

Terminal handles are not permanent IDs; always resolve by run ID + title.

## Historical ORCA retry policy (not a global Herdr default)

- Process crash, same step: at most 3 automatic restarts, backoff 10s → 30s → 120s.
- Agent task failure: forward evidence to Control; execute only the card's
  preauthorized repair transition and limit. The original ORCA policy capped
  Worker repair at two attempts; it does not grant two attempts to a newer card.
  Exhaustion returns Control, which determines whether a human decision is needed.
- ORCA unavailable: retry 30s → 60s → 180s → 300s; 20 consecutive minutes →
  local `NEEDS_HUMAN / ORCA_UNAVAILABLE`; stop this lane and return evidence to Control.
- Chrome/CDP unavailable: do not resend, do not self-login; may run an approved
  automation Chrome start script; resume by conversation URL; login wall →
  `NEEDS_HUMAN / AUTH_REQUIRED`.

Local NEEDS_HUMAN is an existing runtime hold, not proof that every current lane
requires the owner. Never clear it automatically. Control reconciles the cause and
any separately authorized alternative; only a proven human dependency goes to the owner.

## Crash recovery matrix (summary)

| Fault | Action | Never |
| ----- | ------ | ----- |
| Worker CLI crash | rebuild terminal in same worktree, read checkpoint | reset |
| Reviewer crash | fresh-context reviewer | reuse incomplete conclusion |
| Control Tower crash | rebuild control terminal, deliver resume prompt | decide for it |
| Watcher crash | restart same job watcher | resend prompt |
| ORCA restart | re-list terminals, find by run ID | trust old handle |
| Chrome crash | start dedicated Chrome, resume by URL | auto re-login |
| Network outage | backoff retry | resend |
| Git dirty | pause, write attribution report | clean/stash/reset |
| Test failure | return evidence to Control / exact preauthorized repair route | invent a repair decision |
| Repeated crash | stop lane in local NEEDS_HUMAN; return evidence to Control | infinite loop / clearing the hold |

## Recovery log

For every recovery, record: reason, time, old terminal, new terminal.

## Morning summary

Update after every significant event, at most every 30 minutes. Format per parent
work order §19: `# GPT Browser Bridge Morning Summary` with generated_at,
project_state, current_task, current_attempt, last_successful_checkpoint,
active_processes, latest_commit, tests, reviewer_status, browser_status, ORCA_status,
and sections: Completed overnight / In progress / Automatic recoveries performed /
Blockers / Human actions required / Exact resume command / Files to inspect.

## Windows Task Scheduler (resume)

- One project-specific task: `GPT_BROWSER_BRIDGE_RESUME`.
- Runs only while the current user is logged in; no admin requirement.
- Every 5 minutes runs `resume.ps1`; it restarts the Supervisor only when the
  heartbeat is stale.
- `supervisor.lock` prevents duplicate processes.
- Never modify global PATH, Windows Update, antivirus, or permanent power plans.

## Keep-awake

- Allowed to suppress system sleep during a Supervisor session
  (`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`).
- Must release on Supervisor exit; never change the power plan; never block screen
  off. Laptop lid close / power loss / logout still cannot be guaranteed.
