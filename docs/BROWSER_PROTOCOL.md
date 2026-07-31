# GPT Browser Bridge — Browser Protocol (GBB-003)

This document is the GBB-003 implementation record: what `src/gpt_send.mjs`,
`src/gpt_watch.mjs` and `src/result_store.mjs` actually do, how the Gate A-H
conditions from `docs/GBB002_SPIKE_REPORT.md` map onto code, and the known
integration risks that could not be exercised against a live browser in this
sandboxed worktree. Authoritative rules remain
`plans/GBB_PARENT_WORK_ORDER.md` §14, `skills/browser-sender/SKILL.md`,
`skills/browser-watcher/SKILL.md`, `docs/SECURITY.md`.

## 1. Two independent files, two independent roles

`gpt_send.mjs` (write) and `gpt_watch.mjs` (read-only) do **not** share a CLI
runner. Each defines its own `runCliCommand`, its own subcommand whitelist,
and its own `*InvalidationError` class. This is deliberate: Gate F requires
the Watcher's *source* to contain no browser write API, and the cheapest way
to make that a structural guarantee (not a promise) is for the Watcher to
never import anything that could pull a write call into its module graph.
`tests/completion.test.mjs` asserts both that no forbidden method pattern
appears in `gpt_watch.mjs` and that it never imports `gpt_send`.

Both files only ever shell out through Playwright CLI (`@playwright/cli`
0.1.17, `playwright-core` per `docs/GBB002_SPIKE_REPORT.md`), invoked as:

```text
<cliPath> cli -s=<session> <subcommand> [...args] --json
```

`cliPath` defaults to the global install path recorded by the GBB-002 spike
(`%APPDATA%\npm\node_modules\@playwright\cli\node_modules\.bin\playwright.cmd`)
and can be overridden with `GBB_PLAYWRIGHT_CLI_PATH`. The actual `exec`
transport is always an injected parameter (default: `child_process.execFile`)
so every Gate A-H behavior in the test suite runs against a fake CLI, not a
live Chrome instance — this repo's automated tests never launch a browser.

## 2. Gate A — single controlled entry point

`runCliCommand()` is the *only* function in either file that calls `exec`.
Every other helper (`locateAndRead`, `readConversationSnapshot`,
`locateChatgptTab`, `sendPrompt`, `waitConversationUrl`, ...) goes through it.
It whitelists the subcommand (Gate F) before doing anything else.

## 3. Gate B — re-list and match on every operation

`gpt_watch.mjs`'s `locateAndRead()` always starts with a fresh `tab-list`
call. There is no tab-index cache anywhere in either file — every read walks
list → match-by-conversation-id → `tab-select` → verify, from scratch.
Matching requires **exactly one** tab whose `/c/<id>` path equals the job's
`conversation_url`; zero or multiple matches throw
`WatchInvalidationError("TAB_NOT_FOUND" | "TAB_AMBIGUOUS")` rather than
guessing (see `docs/GBB002_SPIKE_REPORT.md` Test 13, the confirmed FAIL that
made this gate mandatory).

## 4. Gate C — verify in the same read

`READONLY_SNAPSHOT_SCRIPT` (the Watcher's one and only allowed `eval` body)
returns `{ url, title, assistantMessages, stopVisible, continueVisible,
loginWall, networkError }` in a single call. `locateAndRead()` compares the
returned `url`'s conversation id against the target *after* this single read,
not via a separate follow-up call — so there is no window between "verify"
and "read data" in which the tab could navigate. A mismatch raises
`VERIFY_URL_MISMATCH` and the data is discarded, never trusted.

The Sender's baseline/URL-wait reads (`BASELINE_SNAPSHOT_SCRIPT`) follow the
same one-call shape for the same reason.

## 5. Gate D — invalidate on any failure, always redo from scratch

`WatchInvalidationError` / `SendInvalidationError` are thrown for: CLI exec
failure (non-zero exit, spawn error, timeout — `CLI_EXEC_FAILED`), invalid
JSON (`CLI_INVALID_JSON`), zero/multiple tab matches, and URL-verify
mismatch. None of these are caught and "resumed" against the old selection;
`readConversationSnapshot()`'s retry loop calls `locateAndRead()` again in
full on every attempt, which — because Gate B never caches an index — always
re-lists and re-matches.

## 6. Gate E — per-session mutex

`withSessionMutex(session, task)` chains every operation for a given session
name onto a single promise queue (`sessionQueues: Map<session, Promise>`).
Two concurrent watch/send calls against the same session are guaranteed to
run their CLI calls back-to-back, never interleaved
(`tests/completion.test.mjs` "Gate E" test proves this with a slow fake exec
and a concurrency counter). Sessions are not shared mutable names across
agents by convention — each Sender/Watcher run should use its own session.

## 7. Gate F — read-only whitelist (Watcher)

`gpt_watch.mjs` `ALLOWED_CLI_SUBCOMMANDS = ["tab-list", "tab-select", "eval",
"snapshot"]`. `runCliCommand()` throws for anything else, and for `eval`
specifically requires the script to be `=== READONLY_SNAPSHOT_SCRIPT`
(reference equality on the fixed template — no interpolated/dynamic script is
ever accepted). `click`, `fill`, `press`, `tab-close`, `tab-new`, `run-code`
and `show` are absent from the whitelist and never called anywhere in the
file. `gpt_send.mjs` is the write-capable counterpart and additionally
whitelists `fill`/`press`.

## 8. Gate G — dashboard is never invoked

Neither file ever calls the `show` subcommand or constructs a URL for it.
There is no code path that could start a dashboard server.

## 9. Gate H — bounded retry, read-only, no auto-resend

`readConversationSnapshot(conversationUrl, { maxRetries })` retries a failed
*read* up to `maxRetries` times (default `DEFAULT_MAX_INVALIDATION_RETRIES =
3`), each attempt redoing the full Gate B/C flow. `runWatchLoop()` additionally
tracks `consecutiveFailures` across poll cycles; once it exceeds
`maxConsecutivePollFailures` (default 3) the job is persisted as
`FAILED` / `cdp_unreachable` rather than looping forever. The Sender
(`gpt_send.mjs`) has no retry/resend logic for `sendPrompt()` at all — Sender
failures are surfaced to the caller as thrown errors; nothing in this repo
automatically re-submits a prompt. `sendJob()` sends exactly once per call.

## 10. Candidate indexing (never "the last message")

`baseline.assistant_count` (captured by the Sender *before* sending) is the
fixed 0-based index of the new reply: if N assistant messages existed before
send, the reply is assistant message index N. `pickCandidateIndex()` /
`extractCandidateMessage()` implement this directly; see
`tests/completion.test.mjs` and `fixtures/chatgpt/six_answers_snapshot.json`
for the 5th-vs-6th-answer regression case this guards against.

## 11. Completion criteria

- While `stopVisible` is true → never `DONE` (`decideState()` checks this
  before stability, so a mid-generation pause that happens to repeat the same
  partial hash 3× cannot look finished).
- Once Stop disappears: at least `STABLE_MIN_SAMPLES` (3) consecutive
  identical-hash reads spanning at least `STABLE_MIN_MS` (15000ms) —
  `evaluateStability()`. A fast reply is not missed; it just still needs the
  watcher to keep sampling for the same 15s window before being confirmed.
- Poll cadence defaults to `DEFAULT_POLL_INTERVAL_MS` = 5000ms
  (`runWatchLoop()`), independently configurable per call.

## 12. Detections

`detectAnomalies()` surfaces (never silently resolves): `login_wall`,
`network_error`, `continue_button`, `baseline_invalid`, `odd_code_fence`
(unterminated ``` fence — odd count), `abrupt_tail` (reply text does not end
in sentence-terminating punctuation/marker, only checked once `stopVisible`
is false), and `missing_end_marker` (see §13). `decideState()` additionally
synthesizes two engine-level failure codes: `max_retries_exceeded` and
`cdp_unreachable`, both mapped to result state `FAILED`; every other
detection maps to `NEEDS_DECISION` once the reply is otherwise stable, or (for
`login_wall`) immediately.

## 13. Reply end-marker convention

Job prompts that want a positive "the model finished, not just stalled"
signal should ask ChatGPT to end its answer with the literal string
`<!-- GBB:END -->` (`REPLY_END_MARKER` in `gpt_watch.mjs`). When
`requireEndMarker: true` is passed to `detectAnomalies()`, a reply lacking
this marker is flagged `missing_end_marker`. This is opt-in per job, not
enforced unconditionally, so it does not misfire on prompts that never asked
for the marker.

## 14. Durable output order (strict, never reordered)

`result_store.mjs persistResult()`:

1. `write-file-atomic` write of `reply.md`.
2. `sha256Hex()` of the bytes just written.
3. `resultSchema.parse()` + `write-file-atomic` write of `result.json`.
4. One `process.stdout.write()` JSON event line.

Only step 3's file existing on disk means the job reached a terminal state
(`DONE` / `NEEDS_DECISION` / `FAILED`). `reply_hash` is always recomputable
by hashing the `reply.md` bytes at `reply_path` — `tests/result_store.test.mjs`
asserts this directly. `output_dir` is confined to `<runtimeRoot>/jobs/<job_id>/`
by `resolveJobDir()` (rejects `..`, path separators inside `job_id`, and any
resolved path outside the runtime root), per `docs/SECURITY.md` §4.

## 15. job.json immutability

`gpt_send.mjs writeJobFile()` accepts an injectable `existsCheck(jobPath)`
and refuses to write if it reports the file already exists. In production use
this should be backed by a real `fs.access`/`fs.stat` check; the injection
point exists purely so `tests/baseline.test.mjs` can exercise the
refuse-to-overwrite path without racing the filesystem. Because `job_id` is a
fresh UUID per send, collisions are not expected in practice — this is a
fail-closed backstop, not the primary uniqueness mechanism.

## 16. Known integration risks (not exercised against a live browser)

This worktree has no attached Chrome/CDP endpoint, so none of the above was
run against real `@playwright/cli` output. Two things should be double-checked
at first live run against the shared ChatGPT tab (`http://127.0.0.1:9225`,
per `docs/GBB002_SPIKE_REPORT.md`):

- **CLI `--json` envelope shape.** `unwrapCliResult()` assumes
  `{"result": <value>}`, unwrapping a JSON-encoded string `result` one level
  if needed. The GBB-002 spike only confirmed this for primitive string
  returns (`eval "() => document.title"`); the object-returning shape used
  here (`READONLY_SNAPSHOT_SCRIPT` / `BASELINE_SNAPSHOT_SCRIPT`) was not
  spiked and should be reconfirmed before first production use.
- **ChatGPT DOM selectors.** `READONLY_SNAPSHOT_SCRIPT`'s
  `[data-message-author-role="assistant"]` / stop-button / continue-button
  selectors and `gpt_send.mjs`'s `PROMPT_TEXTAREA_SELECTOR` /
  `SEND_BUTTON_SELECTOR` are based on commonly-documented ChatGPT UI
  attributes, not verified against the live DOM in this environment. If the
  UI has since changed, update only these constants — the gate logic around
  them does not need to change.
