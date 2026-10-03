# Handoff documentation revision — validation record

card_id: GBB-HANDOFF-DOCS-01
scope: documentation candidate only
source_authority: owner's direct request to inspect and rewrite the Web GPT and desktop Herdr reading documents
base_commit: a542a216ef05f7bc72ff4782474a14014c998c1a
candidate_branch: docs/gbb-handoff-role-guides
related_work: https://github.com/D22977/gpt-browser-bridge/issues/124
formal_review: NOT_PERFORMED
runtime_acceptance: NOT_CLAIMED

## What the inspection found

The existing AGENTS entry primarily addressed early build agents. README and
Architecture still called local runtime the progress authority, while Control skill
required current GitHub authority. Herdr had no dedicated reading entry. Worker
inputs assumed a local dispatch and start-time HEAD; outputs ended at a report/commit.
Supervisor recovery text did not bind GitHub event consumption or a terminal-return
guard. Some retry and human-escalation text conflicted with later bounded cards.

The revision introduces one shared contract and two role runbooks, linked from
AGENTS and the six existing role skills. Historical plans/ORCA procedures remain
available with their scope made explicit. It aligns authority, first-send versus
uncertain-send handling, Worker-owned start receipts, Control-owned continuation,
guard lifetime, independent bootstrap and human escalation.

Changed scope: AGENTS.md, README.md; docs/ARCHITECTURE.md, HANDOFF_CONTRACT.md,
WEB_CONTROL_RUNBOOK.md, HERDR_RUNBOOK.md, RECOVERY_RUNBOOK.md, ORCA_RUNBOOK.md,
MORNING_CHECKLIST.md, SECURITY.md and this record; plans/GBB_PARENT_WORK_ORDER.md;
the existing browser-sender, browser-watcher, control-tower, recovery-supervisor,
reviewer and worker SKILL.md files. No source, workflow, runtime, package or test
implementation changes are included.

## Scenario walkthrough

An internal helper read the original local-role documents before the revision,
then applied the same five cases to the candidate. This is instruction-usability
preflight, not a formal independent project review or a live execution test.

| Scenario | Baseline gap | Candidate answer |
| --- | --- | --- |
| Dispatch exists, no current exact pane | Local ORCA checkpoint procedure did not bind GitHub to Herdr | Herdr inventories eligible executors; Control binds an authorized alternate/bootstrap if absent. |
| Child workflow fails before terminal comment | No run/job observation or missing-terminal reporting owner | Bound guard observes job and receipts, reports original transport failure to Control without impersonating the child. |
| Wake exists, physical send positively proven absent | No first-send rule or wake-consumer identity | Reconcile complete evidence and admission, retain logical identity and perform only the first send. |
| Send ambiguous, process restarts | Process restart policy did not guard Herdr send-bearing steps | Preserve uncertainty; resume observation/publication, not physical send; independent authorized repair can continue. |
| Worker READY, Web Control turn ends | No explicit future-consumer/ACK responsibility | Worker parks; guard returns terminal; Control owns next authorized phase. A checkpoint alone is not unattended continuity. |

The helper identified remaining historical automatic-human-escalation wording.
It was tightened to distinguish local runtime holds from Control's semantic
escalation decision. The hold cannot be cleared automatically and the failed lane
cannot exceed its retry ceiling.

One separate Web-side baseline helper could not run because of account usage limits.
No alternate paid model or reset was used. Web-side authority/role/phase scenarios
were inspected locally; they are not claimed as an independent agent test.

## Checks and limits

- `npm ci --ignore-scripts --no-audit --no-fund`: completed.
- `npm test`: 175 tests passed, 0 failed. No executable files changed; this protects
  the existing suite but does not validate a live handoff or guarantee model behavior.
- Markdown structural check: document-only scope, local link targets, paired fenced
  blocks, role frontmatter, UTF-8 replacement-character scan and no current exact
  generation/conversation/head hardcoded into the three reusable runbooks:
  18 Markdown files checked, 60 relative links resolved, no errors.
- `git diff --check`: passed before commit; CRLF/LF differences normalized only
  in edited Markdown files.
- No workflow dispatch, browser prompt, Herdr task activation, Control switch,
  production adoption, merge, release or local adapter installation performed.

## Required adoption and loading evidence

1. A NEW independent reviewer reads the exact candidate bytes and issues its own
   durable/read-back verdict under the current review contract. This preflight is
   not that verdict. Any finding yields a new candidate identity and fresh review.
2. Active Control binds the accepted head and explicit integration/adoption decision.
   Do not interpret branch presence or this document's existence as acceptance.
3. The authorized maintainer updates only the Web Project/desktop adapter pointers
   selected by that decision. Use the Web runbook's short entry, not full copied
   rules. Do not overwrite other local skills or settings implicitly.
4. Web Control and the exact local executor each demonstrate direct GitHub
   rehydration and record which accepted ref/blobs they read; adapters additionally
   prove canonical byte equality. Missing loading evidence remains a deployment gap.
5. Under separate runtime authority, prove real consumer/guard restart, exact target
   delivery, Control reread/ACK/decision and next-step continuation. Documentation
   acceptance must not close #124's implementation or E2E obligations.
