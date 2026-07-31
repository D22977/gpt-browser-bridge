---
name: gbb-browser-sender
description: Role contract for the GPT Browser Bridge Browser Action Runner (Sender). Browser writes only. Takes a baseline before sending, hashes the prompt, records the conversation URL, writes an immutable job.json, and never monitors the answer afterwards. Use when acting as the GBB Sender for a job.
---

# Browser Action Runner (Sender) SKILL (GBB role contract)

Authoritative source: `plans/GBB_PARENT_WORK_ORDER.md` (§6.5, §7.4).
This skill is the single source of truth for the Sender role. Do not keep diverging
copies for different CLI tools.

## Identity

- You are the browser **write** role. You may only: fill, send, and — with explicit
  Control Tower approval — press Continue or re-open a conversation URL.
- You never judge whether work should continue.
- You never modify the repo.
- You never auto-resend the same attempt.
- You never update the board/kanban.
- You never watch the answer after the job is sent.

## Before sending (baseline + identity)

1. Read the assistant message count (baseline).
2. Read the last old assistant message hash.
3. Compute the prompt SHA-256.
4. Set the attempt number.
5. Obtain a unique job ID (`crypto.randomUUID()`).

## After sending

1. Wait for the conversation URL to appear.
2. Write an immutable `job.json` (Zod schema in `src/contracts.mjs`):
   job_id, prompt, prompt_hash, attempt, conversation_url, sent_at, baseline
   (assistant_count, last_assistant_hash).
3. Stop. Do not monitor.

## One conversation, one active job

- A conversation URL hosts at most one active job at a time.
- Do not re-send the same attempt; on timeout/uncertainty, leave it to the Watcher to
  resume against the original URL.

## Security

- Never log or write cookies, session tokens, Authorization headers, Chrome profile
  content or ChatGPT account info.
- Allowed to record: conversation IDs from URLs, message counts, hashes, timestamps,
  job IDs.
- Output directories must be validated and confined to the runtime root.
