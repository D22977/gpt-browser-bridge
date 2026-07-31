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
whitelists `fill`/`click`/`press`. `sendPrompt()` fills the editor then
`click`s `SEND_BUTTON_SELECTOR` — not `press <selector>`: the CLI's `press`
subcommand takes a key name (e.g. `"Enter"`), not a CSS selector, so pressing
a selector as if it were a key never actually activated Send. `press` stays
whitelisted for future key-based input but is not currently called.

### 7a. Page-hidden fail-closed (Sender)

Live-capture finding: when the ChatGPT tab is not the visible/foreground tab
(`document.visibilityState !== "visible"`), the real CLI's `click` hangs
(its actionability check waits on `requestAnimationFrame`, which browsers
throttle/suspend on hidden tabs) and pressing Enter does not submit either.
`BASELINE_SNAPSHOT_SCRIPT` now also returns `visibilityState`, and
`readBaseline()` calls `assertPageVisible(snapshot)` immediately after
reading it — before `sendPrompt()` is ever invoked. A hidden page throws
`SendInvalidationError("PAGE_HIDDEN")` and no `fill`/`click` call is made.

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

## 15a. `.cmd` shim spawning (live-canary finding, 2026-08-01)

Both files' `defaultExec()` originally called `execFile(cliPath, args, {...})`
directly on the npm `.cmd` shim path. Recent Node refuses to spawn a
`.bat`/`.cmd` file that way ("spawn EINVAL" - Node's April 2024 batch-file
command-injection CVE fix requires an explicit `shell: true`), which this
repo's test suite never caught because every test injects a fake `exec` and
never exercises the real spawn path. `resolveSpawnTarget(cliPath)` (exported
from both files, duplicated per Gate F) resolves a `.cmd` path to the node
entry point it wraps (`playwright.cmd`'s own body invokes
`%dp0%\..\playwright\cli.js`) and `defaultExec` spawns `node <entry> <args>`
directly - a plain executable + argv array, no shell, so no argument-escaping
or injection risk is introduced. Verified against the real shared Chrome; see
`fixtures/chatgpt/live_canary_send_watch.json`.

## 15b. `baseline_invalid` surfaces immediately (P1-6 fail-closed fix)

`decideState()` now checks `detections.includes("baseline_invalid")` before
the stability gate, returning `NEEDS_DECISION` right away. Previously it was
only checked *after* `stability.stable`, but a malformed payload (e.g. a
selector that no longer matches anything live) makes
`extractCandidateMessage()` report `baseline_invalid` on every poll and never
push a hash sample - so stability could never become true and the Watcher
would poll `WAITING` forever instead of ever surfacing the problem. It never
produced a false empty-set `DONE` (the bug the acceptance criteria call out
explicitly), but it also never resolved. Matches the existing `login_wall`
precedent of deciding immediately regardless of stability.

## 16. Live canary results (P1-2, 2026-08-01)

A real end-to-end run against the shared ChatGPT tab (`http://127.0.0.1:9225`)
has since resolved the two risks this section used to flag as unexercised;
see `fixtures/chatgpt/live_canary_send_watch.json` for the full transcript
(job.json / result.json / reply.md, hashes, timings).

- **CLI `--json` envelope shape.** Confirmed for the object-returning shape
  (`READONLY_SNAPSHOT_SCRIPT` / `BASELINE_SNAPSHOT_SCRIPT`) as well as the
  primitive-string and array-returning shapes and the `isError: true` /
  exit-0 error shape - all captured as `fixtures/chatgpt/live_*.json` and
  consumed directly by `tests/baseline.test.mjs` / `tests/completion.test.mjs`.
- **ChatGPT DOM selectors.** `PROMPT_TEXTAREA_SELECTOR` (`#prompt-textarea`),
  `SEND_BUTTON_SELECTOR` (`[data-testid="send-button"]`), and
  `READONLY_SNAPSHOT_SCRIPT`'s `[data-message-author-role="assistant"]` /
  stop-button selectors all matched the live DOM in this run. If the UI
  changes in the future, update only these constants — the gate logic around
  them does not need to change.
- **What a full live run additionally required and fixed:** the `.cmd` shim
  spawn issue (§15a) and the `sendPrompt()` `press`-with-a-selector bug (§7)
  both only surfaced once actually run against the real CLI/DOM - neither
  was, or could have been, caught by the fake-`exec` unit test suite alone.
