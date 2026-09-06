# GBB124 G11 P2 External Advisory Review Pack

## Review role

You are a NEW/fresh independent **external advisory reviewer**, not Control, Worker, Herdr coordinator, or the formal acceptance Reviewer for candidate `38da7377f9b9d1610dd44aa869b861bb8500ccc9`.

This review is advisory only. Do not mutate repository files, merge/release, run live acceptance, create Control generation012, or claim candidate acceptance. GitHub is durable authority.

Publish/read back exactly one `GBB_HANDOFF_CONTINUITY_EXTERNAL_ADVISORY_RESULT_V1` on Issue #124 if your route has authenticated GitHub write. If you cannot self-publish, return an explicit `READ_PASS_WRITE_BLOCKED` capability result; do not ask an operator to proxy-author your findings as if they were reviewer-owned.

## Project outcome

Repair the GBB/Herdr handoff path so a one-person operator does not have to courier task/result state. The desired chain is:

`durable event -> admitted transport -> exact executor/reviewer -> durable terminal -> Control reread/ACK -> bounded decision -> legal successor`, including Web turn end/process restart/Control rotation and zero owner result relay.

## Current completion work package

Issue #124 work package: `GBB-HANDOFF-CONTINUITY-E2E-COMPLETION-G11`.

Key authority/evidence:

- Completion ownership: Issue #124 comment `5559953075`.
- Main Worker dispatch: `5559637021`.
- Bootstrap outbound transport integration authority: Issue #125 `5559841184`.
- Integrated outbound transport base supersession: `5559851827`.
- Worker wake: `5559853971`.
- Physical Herdr Worker delivery: `5559855796`.
- Worker-owned consume receipt: `5559871158`.
- Worker consume guard PASS: `5559871770`.
- Worker READY terminal: `5560002300`.
- Candidate head: `38da7377f9b9d1610dd44aa869b861bb8500ccc9`.
- Formal review request: `5560026863` / `GBB124-G11-R1-38DA7377-20260906`.
- One-shot formal-review launcher exception: `5560048086`.
- Exact transient launcher integration authority: `5560084696`.
- Formal-review wake: `5560088261`.
- Herdr coordinator physical delivery: `5560090943`.
- Launcher Actions run: `34041048956`.
- Guard terminal: `5560123283 / BLOCKED_LAUNCH_RESULT_TIMEOUT`.
- Control return: `5560123516`.
- Read-only reconciliation authority: `5562546371`.
- Read-only observation: `5562555052 / CONTROL_REQUIRED / SETTLED_NO_LAUNCH_EVIDENCE`.
- Advisory escalation authority: `5562567305`.

## Facts already proven

### A. Control -> Herdr Worker dispatch is no longer the blocker

The outbound Worker edge is proven for the current G11 repair:

- exactly one physical Herdr prompt was delivered,
- Worker self-published `CONSUMED_STARTED` before tracked mutation,
- exact pane/session was bound,
- Worker completed implementation and published READY.

Do not recommend reopening the earlier `DISPATCH_REQUEST_WRITTEN -> Worker CONSUMED_STARTED` problem unless new evidence contradicts those receipts.

### B. Formal-review launcher crossed its coordinator send boundary

Actions run `34041048956`, job `101507750917`, ran on interactive self-hosted runner `gbb-reviewer-win-01` and completed successfully.

The workflow:

1. validated Issue #124 / review request / exact candidate head / ACTIVE Control;
2. fresh-enumerated an eligible generic Codex coordinator;
3. persisted SENDING state;
4. called `herdr agent prompt` exactly once;
5. verified returned pane/session identity;
6. persisted SENT;
7. published `5560090943 / HERDR_FRESH_REVIEW_COORDINATOR_DELIVERY_V1`.

Bound coordinator:

- pane: `w2:p1`
- session: `01a0513f-4e68-7573-bf38-72e2120ebe1d`
- prompt SHA-256: `d7c631d1bae4756b19dfedb5c26fcfb3351653069b957cd6ee226ac6fd650f6e`
- physical prompt count: 1
- second prompt: false
- user relay: 0

The coordinator was instructed to be transport-only, perform current access admission, create exactly one NEW/fresh independent ChatGPT Web Reviewer if a currently admitted route existed, and publish either a typed DELIVERED launch result with fresh conversation binding or typed BLOCKED with first missing capability. It was explicitly forbidden to self-review or blind retry ambiguity.

### C. No launch terminal was published in the guard window

`5560123283` is `GBB_HANDOFF_CONTINUITY_FRESH_REVIEW_GUARD_V1 / BLOCKED_LAUNCH_RESULT_TIMEOUT`.

There was no durable:

- `GBB_HANDOFF_CONTINUITY_FRESH_REVIEW_LAUNCH_RESULT_V1`,
- `GBB_HANDOFF_CONTINUITY_FRESH_REVIEW_RESULT_V1`,
- fresh reviewer conversation binding,
- typed coordinator BLOCKED result.

The old formal-review wake `5560088261` MUST NOT be replayed.

### D. Later read-only exact-session reconciliation found no recoverable launch evidence

A separate transient observer used **only** `herdr agent list` and `herdr agent read`; it did not prompt the agent and did not perform browser actions.

Receipt `5562555052` reports:

- `state: CONTROL_REQUIRED`
- `classification: SETTLED_NO_LAUNCH_EVIDENCE`
- exact prior coordinator matched and was `idle`
- terminal read exit: 0
- terminal output SHA-256: `22d49fb1a63ad23a8373d49b01098afe2bad6504b65376a6522eb0fd39efd56d`
- launch marker: false
- formal review marker: false
- fresh reviewer URL: absent
- BLOCKED marker: false
- first missing capability/gate: absent
- publication-error pattern: false
- raw terminal output was not published
- agent prompt performed: false
- browser action performed: false
- user relay: 0

Therefore there is no durable or observed evidence that the original coordinator created a Reviewer, reached a typed blocker, or merely failed result publication.

## Architecture constraints

- GitHub is the only durable authority.
- Control != Worker != Formal Reviewer.
- Herdr is deterministic transport/coordinator only.
- Formal Reviewer must be a NEW/fresh independent context when the formal gate is retried under new Control authority.
- Never blind-retry SENDING/CLICK/UNCERTAIN or an already-SENT logical action.
- PASS does not imply merge.
- Terminal does not imply successor.
- No second persistent Control plane / authority DB / reasoning daemon / hidden scheduler.
- Prefer existing admitted tools and thin deterministic transport.
- One-person team: minimize token use, bespoke infrastructure, and human relay.

## Historical fresh-WebGPT capability

Issue #81 records that `Codex In-app Browser / automation-owned isolated fresh tab` was historically `PROVEN_BOUNDED` via Issue #83, but every later use requires fresh runtime admission; historical reachability must not be assumed.

Issue #81 also records Grok/xAI external GitHub review was historically proven at least once via Issue #50 receipt `5230984658`, but a later external session had GitHub access unavailable. Treat this only as historical capability evidence, not current liveness.

## Questions for the advisory reviewer

1. Given successful `herdr agent prompt` delivery followed by no typed coordinator terminal and later idle/no-evidence reconciliation, what root-cause classes remain plausible? Rank them by evidence and state what additional **read-only** evidence would discriminate them.
2. What is the smallest bounded repair that guarantees every accepted coordinator prompt reaches exactly one durable terminal: `DELIVERED`, `BLOCKED_PRESEND/ACCESS`, `UNCERTAIN`, or a typed post-send failure?
3. Should the durable lifecycle be moved so that the external-browser sub-action is itself a child job/process with an independently observable terminal rather than relying on the prompted coordinator to publish prose/receipts?
4. How should the system distinguish these cases without duplicate reviewer creation: coordinator crash/exit, browser launch failure before conversation creation, Reviewer created but wake not delivered, Reviewer delivered but result publication failed, no currently admitted route?
5. Can this be made restart/turn-end safe using GitHub durable state + thin deterministic worker/observer only, without creating a second persistent Control plane?
6. What exact negative tests and fail-closed checks must pass before P2 is considered repaired?
7. Given one-person-team cost/token constraints, recommend one option among: repair current Herdr coordinator path, use a direct deterministic fresh-WebGPT launcher, use a different external review lane, or redesign the review transport boundary. Explain opportunity cost.

## Required advisory result schema

Publish one result with:

- protocol: `GBB_HANDOFF_CONTINUITY_EXTERNAL_ADVISORY_RESULT_V1`
- state: `ADVISORY_COMPLETE | BLOCKED`
- reviewer_type / reviewer_identity / fresh context identity
- evidence_checked
- ranked_root_causes, each with evidence_for/evidence_against
- recommended_bounded_repair
- alternative_options
- exact_allowed_paths_or_components_if_known
- acceptance_tests
- retry/idempotency rules
- human/auth requirements, if any
- risks and rollback
- whether the recommendation requires Control architecture/scope decision
- readback_verified

This advisory result cannot substitute for formal review request `GBB124-G11-R1-38DA7377-20260906`.