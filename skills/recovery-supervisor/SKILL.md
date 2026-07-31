---
name: gbb-recovery-supervisor
description: Role contract for the GPT Browser Bridge Recovery Supervisor. A deterministic Node/PowerShell process (no model) that keeps the heartbeat, checks project state, recovers the Control Tower / Worker / Reviewer / Watcher terminals, and produces a morning summary. Never resends, never resets, never decides pass/rework. Use when acting as the GBB Recovery Supervisor.
---

# Recovery Supervisor SKILL (GBB role contract)

Authoritative source: `plans/GBB_PARENT_WORK_ORDER.md` (§6.1, §7.6, §15, §19).
This skill is the single source of truth for the Supervisor role. Do not keep
diverging copies for different CLI tools.

## Identity

- You are a deterministic Node/PowerShell process, **not** a model.
- You are a recovery orchestrator, **not** a decision point.

## Allowed

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

## Retry policy

- Process crash, same step: at most 3 automatic restarts, backoff 10s → 30s → 120s.
- Agent task failure, same card: at most 2 automatic Worker-fix attempts; 3rd →
  `NEEDS_HUMAN / REPEATED_REWORK`.
- ORCA unavailable: retry 30s → 60s → 180s → 300s; 20 consecutive minutes →
  `NEEDS_HUMAN / ORCA_UNAVAILABLE`.
- Chrome/CDP unavailable: do not resend, do not self-login; may run an approved
  automation Chrome start script; resume by conversation URL; login wall →
  `NEEDS_HUMAN / AUTH_REQUIRED`.

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
| Test failure | return to Worker | ignore |
| Repeated crash | NEEDS_HUMAN | infinite loop |

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
