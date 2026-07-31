# GPT Browser Bridge — Security

This is the repo-local security policy for GPT Browser Bridge. The authoritative
policy is `plans/GBB_PARENT_WORK_ORDER.md` §18. Rules here apply to all roles and to
any code committed to this repository.

## 1. CDP (Chrome DevTools Protocol)

- Bind **only** to `127.0.0.1`.
- Never use `0.0.0.0`.
- Never open Windows Firewall inbound rules for CDP.
- Never send a CDP URL to any external service.

## 2. Credentials & account data

Never log, write to disk (in or out of the repo), or commit:

- Cookies
- Session tokens
- `Authorization` headers
- Chrome profile contents
- ChatGPT account identifiers or credentials
- Personal API keys

The `.gitignore` excludes `*Cookies*`, `*Login Data*`, `*Session*`, `*profile*`,
`chrome-profile/`, `.env*`, `*.pem`, `*.key`.

## 3. What may be logged

Allowed in logs/events/reports:

- Conversation IDs as they appear in URLs
- Page titles
- Message counts
- Hashes (reply hash, prompt hash)
- Error codes
- Timestamps

Do **not** save full HTML by default.

## 4. File paths

- `output_dir` values must be validated and must resolve inside
  `D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\`.
- Reject path traversal (`..`, absolute paths outside the allowed root, drive-letter
  escapes, `\\?\` prefixes).

## 5. Git hygiene

- Never commit runtime state, heartbeat, cookies, Chrome profiles, or logs.
- Review `git status --short` before every commit.
- Stop and report `NEEDS_HUMAN / DIRTY_ATTRIBUTION_UNKNOWN` if the tree is dirty
  with unknown attribution; do not `git clean`/`reset --hard`/`stash`.

## 6. Watcher read-only enforcement

The Watcher is a browser read-only role. Its source must not contain browser write
APIs:

```text
.click(   .fill(   .press(   .keyboard   .mouse   .goto(   .newPage(   .bringToFront(
```

`evaluate()` in Watcher code may only read the DOM, never mutate it. The Reviewer
checks for these forbidden APIs on every review.

## 7. Sender / Watcher separation

- Sender performs browser writes (fill/send/approved continue/re-open) and must not
  monitor answers.
- Watcher only reads and never resends a prompt; after timeout it re-attaches to the
  original conversation URL and resumes watching.

## 8. Fail closed

On any login wall, CAPTCHA, unknown dirty attribution, insufficient permission or
repeated crash, stop and leave `NEEDS_HUMAN` with a concrete blocker reason rather
than guessing, retrying indefinitely, or resetting state.
