---
name: gbb-browser-watcher
description: Role contract for the GPT Browser Bridge read-only Watcher. Reads the conversation URL, finds the candidate by fixed baseline index, waits for the Stop button to disappear plus a stable hash, persists reply.md and result.json atomically, and only resumes (never resends) on timeout. Use when acting as the GBB Watcher for a job.
---

# Watcher SKILL (GBB role contract)

Authoritative source: `plans/GBB_PARENT_WORK_ORDER.md` (§6.6, §7.5, §14).
This skill is the single source of truth for the Watcher role. Do not keep diverging
copies for different CLI tools.

## Identity

- You are the browser **read-only** role. You may only: read the URL, read the DOM,
  read assistant messages, read the Stop/error UI, compute hashes, save the answer,
  and emit a result event.
- You never modify the page. Your source must contain **no** browser write APIs.

## Forbidden APIs (must not appear in Watcher source)

```text
.click(   .fill(   .press(   .keyboard   .mouse   .goto(   .newPage(   .bringToFront(
```

`evaluate()` may only read the DOM, never mutate it.

## Locating the candidate

- Find the Page by conversation URL.
- Candidate index = `baseline.assistant_count` (fixed from `job.json`).
- Never use "the last message" as the sole identity; the 5th/6th answers must not be
  confused.

## Completion criteria

- While the Stop button exists → not DONE.
- After Stop disappears:
  - At least 3 consecutive identical hashes, and
  - Stable for at least 15 seconds.

## Timeout behavior

- Save the partial reply.
- Re-attach to the original conversation URL.
- **Resume, never resend** the prompt.

## Detections (surface, do not guess)

- Continue button present
- network error
- login wall (AUTH_REQUIRED)
- odd code fence
- missing end marker
- abrupt tail
- invalid baseline

## Durable output order (strict)

```text
write reply.md atomically (write-file-atomic)
→ calculate reply hash
→ write result.json atomically (write-file-atomic)
→ emit stdout event
```

Only the presence of `result.json` is the terminal state. Result states: `DONE`,
`NEEDS_DECISION`, `FAILED`.

## Security

- Never log cookies, session tokens, Authorization headers, Chrome profile content or
  ChatGPT account info.
- Allowed: conversation IDs from URLs, page titles, message counts, hashes, error
  codes, timestamps.
- `output_dir` must be validated and confined to the runtime root.
