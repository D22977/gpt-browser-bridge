# G13 parallel lanes

## Lane 1 — resident lifecycle and installer

Lane 1 owns the resident contract, deferred Windows installer, resident tests,
and resident runbook from Task 1. It does not register a Scheduled Task or
adopt the runtime.

## Lane 2 — contributor-contract documents

Lane 2 owns `docs/WEBGPT_CODE_CONTRIBUTOR.md` and this document. It defines a
bounded WebGPT code-contributor role and does not become Control, Reviewer, or
physical Transport.

## Shared terminal gate

Both lanes end at `READY_FOR_FRESH_REVIEW`. Only a fresh formal review followed
by an explicit Control ACK may adopt the runtime or unlock a physical wake.
