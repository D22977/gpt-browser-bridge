# Control Tower Success Evidence Index

Status: CANDIDATE companion. This index is a success-evidence registry, not a general history or lessons archive.

## Admission rule

Only an exact durable source whose state is PASS or whose capability class is PROVEN_BOUNDED may be admitted here. Every entry must carry the repository-qualified source, exact receipt identity, executor or surface, task class, bounded properties, and explicit restrictions. Design, READY, FIX_REQUIRED, BLOCKED, HUMAN_REQUIRED, NO_OP, and unverified liveness are not success entries. Reuse never expands authority.

Read this index before FAILURE_ARCHIVE. Read the exact source receipt before relying on a claim, check for a newer invalidation, and perform only task-time target/liveness binding.

## Admitted bounded success evidence

### GBB #62 — overnight resume standard

- source: D22977/gpt-browser-bridge#62 comment 5232486623
- source_state: PASS
- capability_class: PROVEN_BOUNDED
- protocol: OVERNIGHT_RESUME_STANDARD_V1
- overnight_ready: true
- admitted_surfaces: CODEX_DESKTOP_AGENT via preserved receipt 5232324012 / CODEX-DESKTOP-WAKE-ENTRYPOINT-V1; CODEX_LUNA_CLI_AGENT via runtime canary 1786291883245 / CODEX-LUNA-CLI-WAKE-V1
- schema: OVERNIGHT_RESUME_EVENT_V2
- required_tuple: source_repo, source_issue, source_receipt_id, source_protocol, source_event_class, target_executor, target_family, target_model, control_generation, observed_generation, idempotency_key, legal_next_action
- target: CODEX_LUNA_CLI_AGENT / CODEX_OPENAI / gpt-5.6-luna
- source_event_classes: CONTROL and FRESH_REVIEWER
- duplicate_behavior: NO_OP
- stale_wrong_malformed_behavior: FAIL_CLOSED
- uncertain_send: NO_BLIND_RETRY
- runtime_root: D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/codex-luna-wake
- user_relay_count: 0
- tracked_repo_modified: false
- bounded_restriction: this is proof of the exact admitted resume mechanism and properties. It is not current project scheduler liveness, a reviewer verdict, or permission to select an unbound successor.

### GBB #83 — Desktop WebGPT transport

- source: D22977/gpt-browser-bridge#83 comments 5252595723 and 5252645117
- source_state: PASS
- capability_class: PROVEN_BOUNDED
- surface: CODEX_DESKTOP_AGENT_RUNTIME_OPERATOR / DESKTOP
- role: Browser TRANSPORT/SENDER
- mechanism: Codex app-managed In-app Browser / automation-owned isolated fresh ChatGPT-Web context
- bounded_properties: fresh NEW_CONVERSATION_EMPTY context, exactly-once minimal wake, GitHub-only rehydration, durable readback, user_relay_count=0, no product or tracked-repository mutation
- restriction: transport-only. This entry does not prove scheduled overnight continuation, Herdr/local Control decision consumption, independent Reviewer-dispatch orchestration, formal verdict authority, or universal current liveness. Route substitution is forbidden.

## Use and exclusion

An admitted success entry is selected only when its exact executor, surface, task class, repository/card scope, and restrictions match the current claim. Current liveness and target binding are checked at execution time without re-admitting the mechanism.

No other design, READY, FIX_REQUIRED, or nonterminal source is indexed as success. High-value non-PASS constraints belong in INVARIANTS_AND_LESSONS; diagnostics belong in the default-excluded FAILURE_ARCHIVE.

## Candidate amendment exclusion

`BIDIRECTIONAL_CONTROL_HERDR_HANDOFF_V1` is a candidate contract amendment, not
an admitted success entry. Its `CONTROL_IDLE_ALLOWED`, terminal-return,
capability/liveness, duplicate, and zero-courier rules must be verified against
the exact candidate head and current GitHub receipts. A Worker READY, transport
receipt, or consumed-start receipt does not enter this index as PASS and does not
authorize canonical Skill integration, review, merge, release, or successor
activation.

