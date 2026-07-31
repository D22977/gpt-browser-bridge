// GPT_BROWSER_BRIDGE - Read-only Watcher (GBB-003)
// Spec: plans/GBB_PARENT_WORK_ORDER.md §14, skills/browser-watcher/SKILL.md,
// docs/GBB002_SPIKE_REPORT.md (Gate A-H, ACCEPT conditions).
//
// This file is the Watcher's *only* boundary with the outside world (browser
// reads via the Playwright CLI) and the *only* place allowed to import the
// Playwright CLI process. It must never contain a browser write API (see the
// forbidden-method list in docs/SECURITY.md §6, deliberately not repeated
// here so a literal source scan for those substrings never matches this
// file, comments included) or a CLI subcommand that mutates the page (click
// / fill / press / tab-close / tab-new / run-code / navigate / show).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { isChatgptConversationUrl } from "./contracts.mjs";
import { sha256Hex, persistResult } from "./result_store.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Gate F: whitelist of Playwright CLI subcommands the Watcher may invoke.
// Notably absent: click, fill, press, tab-close, tab-new, run-code, show,
// navigate — see docs/GBB002_SPIKE_REPORT.md Test 6/10/14.
export const ALLOWED_CLI_SUBCOMMANDS = Object.freeze(["tab-list", "tab-select", "eval", "snapshot"]);

// Gate F: the *only* eval script the Watcher is allowed to run. Fixed,
// read-only, and returns the conversation URL together with the data in one
// call so a verify-then-read race (TOCTOU) cannot slip a stale read past
// Gate C. See docs/BROWSER_PROTOCOL.md.
export const READONLY_SNAPSHOT_SCRIPT = `() => {
  const stopButton = document.querySelector('[data-testid="stop-button"], button[aria-label*="stop" i]');
  const continueButton = Array.from(document.querySelectorAll('button'))
    .find((b) => /continue generating|^continue$/i.test((b.textContent || '').trim()));
  const turns = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  const assistantMessages = turns.map((t) => t.innerText || '');
  const bodyText = document.body ? document.body.innerText || '' : '';
  const loginWall = turns.length === 0 && /log ?in|sign ?in/i.test(bodyText);
  const networkError = /network error|something went wrong/i.test(bodyText);
  return {
    url: location.href,
    title: document.title,
    assistantMessages,
    stopVisible: Boolean(stopButton),
    continueVisible: Boolean(continueButton),
    loginWall: Boolean(loginWall),
    networkError: Boolean(networkError),
  };
}`;

export const DEFAULT_CLI_PATH =
  process.env.GBB_PLAYWRIGHT_CLI_PATH ||
  "C:\\Users\\Lupun\\AppData\\Roaming\\npm\\node_modules\\@playwright\\cli\\node_modules\\.bin\\playwright.cmd";

export const STABLE_MIN_SAMPLES = 3;
export const STABLE_MIN_MS = 15_000;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_MAX_INVALIDATION_RETRIES = 3;
export const DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES = 3;

// Reply template convention (docs/BROWSER_PROTOCOL.md): job prompts ask the
// model to end its answer with this literal marker so the Watcher can tell a
// clean finish from a silently truncated one.
export const REPLY_END_MARKER = "<!-- GBB:END -->";

const FAILURE_DETECTIONS = new Set(["max_retries_exceeded", "cdp_unreachable"]);
const DECISION_DETECTIONS = new Set([
  "login_wall",
  "baseline_invalid",
  "continue_button",
  "odd_code_fence",
  "missing_end_marker",
  "abrupt_tail",
]);

// ---------------------------------------------------------------------------
// Gate A: single controlled entry point to the Playwright CLI.
// ---------------------------------------------------------------------------

export class WatchInvalidationError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "WatchInvalidationError";
    this.code = code;
  }
}

// Live-capture finding (2026-08-01 canary): recent Node refuses to spawn a
// `.cmd` shim directly without `shell: true` (EINVAL - see Node's April 2024
// batch-file CVE fix), and `shell: true` would require re-implementing
// cmd.exe's argument-escaping ourselves for every CLI arg to stay
// injection-safe. Instead, resolve npm's `.cmd` shim to the real node entry
// point it wraps (`..\playwright\cli.js`, exactly what the shim itself
// invokes - see its `%dp0%\..\playwright\cli.js` line) and spawn that
// directly via `node`: a plain executable + argv array, no shell, no
// escaping needed. Non-`.cmd` paths (already a `.js`/real exe) are spawned
// unchanged. Duplicated from the Sender module deliberately (Gate F: no
// shared CLI runner between Sender and Watcher).
export function resolveSpawnTarget(cliPath) {
  if (!/\.cmd$/i.test(cliPath)) {
    return { command: cliPath, prefixArgs: [] };
  }
  const entry = path.join(path.dirname(cliPath), "..", "playwright", "cli.js");
  if (!existsSync(entry)) {
    throw new Error(`gpt_watch: cannot resolve the .cmd shim at ${cliPath} to a node entry point (expected ${entry})`);
  }
  return { command: process.execPath, prefixArgs: [entry] };
}

function defaultExec(cliPath, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const { command, prefixArgs } = resolveSpawnTarget(cliPath);
    execFile(command, [...prefixArgs, ...args], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(new Error(err.message), { cause: err, stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function assertAllowedSubcommand(subcommand) {
  if (!ALLOWED_CLI_SUBCOMMANDS.includes(subcommand)) {
    throw new Error(`gpt_watch: "${subcommand}" is not in the Gate F read-only whitelist`);
  }
}

function assertReadonlyEvalScript(subcommand, script) {
  if (subcommand === "eval" && script !== READONLY_SNAPSHOT_SCRIPT) {
    throw new Error("gpt_watch: eval script must be the fixed read-only snapshot template (Gate F)");
  }
}

// Unwraps the Playwright CLI `--json` envelope. Observed shape (GBB-002
// spike): `{"result": <value>}`, where <value> may itself be a JSON-encoded
// string for primitive returns. Defensive: falls back to the raw parsed
// value if there is no `result` key.
export function unwrapCliResult(parsed) {
  if (parsed && typeof parsed === "object" && "result" in parsed) {
    let r = parsed.result;
    if (typeof r === "string") {
      try {
        r = JSON.parse(r);
      } catch {
        // Leave as a plain string; caller decides what to do with it.
      }
    }
    return r;
  }
  return parsed;
}

// The sole function in this file allowed to shell out to the Playwright CLI.
// Every other helper below must call through this one.
export async function runCliCommand(subcommand, rest, opts = {}) {
  const { session, exec = defaultExec, cliPath = DEFAULT_CLI_PATH, timeoutMs = 15_000 } = opts;
  if (!session) throw new Error("gpt_watch: runCliCommand requires a session name");
  assertAllowedSubcommand(subcommand);
  assertReadonlyEvalScript(subcommand, rest[0]);

  const args = ["cli", `-s=${session}`, subcommand, ...rest, "--json"];
  let stdout;
  try {
    ({ stdout } = await exec(cliPath, args, { timeoutMs }));
  } catch (e) {
    throw new WatchInvalidationError(`CLI_EXEC_FAILED:${subcommand}`, { cause: e });
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new WatchInvalidationError(`CLI_INVALID_JSON:${subcommand}`, { cause: e });
  }
  // Live-capture finding (fixtures/chatgpt/live_cli_error.json): the real CLI
  // exits 0 and reports failures as `{isError: true, error: "..."}` on
  // stdout rather than a non-zero exit / exec rejection. Must be checked
  // explicitly - otherwise a real error silently falls through as "valid"
  // JSON with no result/url/array shape (fail-closed by accident, mislabeled).
  if (parsed && typeof parsed === "object" && parsed.isError === true) {
    throw new WatchInvalidationError(`CLI_ERROR_RESPONSE:${subcommand}`, {
      cause: new Error(typeof parsed.error === "string" ? parsed.error : "unknown CLI error"),
    });
  }
  return unwrapCliResult(parsed);
}

// Live-capture finding (fixtures/chatgpt/live_tab_list_*.json): `tab-list
// --json` does NOT return a JSON array of tab objects. It returns a markdown
// bullet-list STRING under `result`: `- <index>: [(current) ]?[title](url)`.
// Parses that real shape into the `{index, current, title, url}[]` shape the
// rest of this file expects. Also tolerates an already-structured
// array/`{tabs:[...]}` input (used by the pre-existing fixture-based tests)
// so neither shape silently produces the wrong tab. Any unparseable line is
// skipped rather than guessed at; an empty/garbled result naturally yields
// zero matches downstream, which Gate B already treats as fail-closed
// (TAB_NOT_FOUND), never a guess.
const TAB_LIST_LINE_RE = /^-\s*(\d+):\s*(\(current\)\s*)?\[(.*)\]\((.+)\)$/;

export function parseTabList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.tabs)) return raw.tabs;
  if (typeof raw !== "string") return [];
  const tabs = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = TAB_LIST_LINE_RE.exec(line);
    if (!m) continue;
    tabs.push({ index: Number(m[1]), current: Boolean(m[2]), title: m[3], url: m[4] });
  }
  return tabs;
}

// ---------------------------------------------------------------------------
// Gate E: mutex — serialize all operations for a given session name.
// ---------------------------------------------------------------------------

const sessionQueues = new Map();

export function withSessionMutex(session, task) {
  const prev = sessionQueues.get(session) || Promise.resolve();
  const settle = () => {};
  const run = prev.then(task, task);
  sessionQueues.set(
    session,
    run.then(settle, settle)
  );
  return run;
}

// ---------------------------------------------------------------------------
// Gate B/C: locate the single matching tab, select it, then verify identity
// in the same read as the data (avoids a verify/read TOCTOU race).
// ---------------------------------------------------------------------------

export function extractConversationId(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const m = parsed.pathname.match(/^\/c\/([0-9a-f-]+)$/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

async function locateAndRead(conversationUrl, opts) {
  if (!isChatgptConversationUrl(conversationUrl)) {
    throw new WatchInvalidationError("TARGET_URL_INVALID");
  }
  const targetId = extractConversationId(conversationUrl);

  // Gate B: always re-list; never cache a tab index across calls.
  const tabs = await runCliCommand("tab-list", [], opts);
  const list = parseTabList(tabs);
  const matches = list.filter((t) => extractConversationId(t?.url) === targetId);
  if (matches.length !== 1) {
    throw new WatchInvalidationError(matches.length === 0 ? "TAB_NOT_FOUND" : "TAB_AMBIGUOUS");
  }
  const [match] = matches;
  const index = match.index ?? match.tabIndex ?? match.id;
  if (index === undefined || index === null) {
    throw new WatchInvalidationError("TAB_INDEX_MISSING");
  }

  await runCliCommand("tab-select", [String(index)], opts);

  // Gate C: one fixed read-only eval call returns URL + data together.
  const data = await runCliCommand("eval", [READONLY_SNAPSHOT_SCRIPT], opts);
  const readId = extractConversationId(data?.url);
  if (readId !== targetId) {
    // Fail closed: discard the result rather than trust a possibly-navigated tab.
    throw new WatchInvalidationError("VERIFY_URL_MISMATCH");
  }
  return data;
}

// Gate D + H: any invalidation forces a full list -> match -> select ->
// verify redo (never a partial resume of the old selection), bounded retries
// for read operations only.
export async function readConversationSnapshot(conversationUrl, opts = {}) {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_INVALIDATION_RETRIES;
  const session = opts.session;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withSessionMutex(session, () => locateAndRead(conversationUrl, opts));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new WatchInvalidationError("MAX_RETRIES_EXCEEDED", { cause: lastErr });
}

// ---------------------------------------------------------------------------
// Pure decision logic (fully unit-testable without a browser).
// ---------------------------------------------------------------------------

// Candidate index = baseline.assistant_count (fixed, never "the last
// message"). If N assistant messages existed before send, the new reply is
// the (N+1)th assistant message, i.e. 0-based index N.
export function pickCandidateIndex(baselineAssistantCount) {
  if (!Number.isInteger(baselineAssistantCount) || baselineAssistantCount < 0) {
    throw new Error("pickCandidateIndex: baseline.assistant_count must be a non-negative integer");
  }
  return baselineAssistantCount;
}

export function extractCandidateMessage(assistantMessages, candidateIndex) {
  if (!Array.isArray(assistantMessages) || !Number.isInteger(candidateIndex) || candidateIndex < 0) {
    return { ok: false, reason: "baseline_invalid" };
  }
  if (candidateIndex >= assistantMessages.length) {
    return { ok: false, reason: "not_yet_arrived" };
  }
  return { ok: true, message: assistantMessages[candidateIndex] };
}

export function computeReplyHash(text) {
  return sha256Hex(text ?? "");
}

// sampleHistory: chronological array of { hash, atMs }. Requires the most
// recent run of identical hashes to be >= STABLE_MIN_SAMPLES long AND to
// span >= STABLE_MIN_MS between its first and last sample.
export function evaluateStability(sampleHistory, opts = {}) {
  const minSamples = opts.minSamples ?? STABLE_MIN_SAMPLES;
  const minStableMs = opts.minStableMs ?? STABLE_MIN_MS;
  if (!Array.isArray(sampleHistory) || sampleHistory.length === 0) {
    return { stable: false, reason: "no_samples" };
  }
  const last = sampleHistory[sampleHistory.length - 1];
  let runStart = sampleHistory.length - 1;
  while (runStart > 0 && sampleHistory[runStart - 1].hash === last.hash) {
    runStart -= 1;
  }
  const runLength = sampleHistory.length - runStart;
  if (runLength < minSamples) {
    return { stable: false, reason: "insufficient_samples", runLength };
  }
  const durationMs = last.atMs - sampleHistory[runStart].atMs;
  if (durationMs < minStableMs) {
    return { stable: false, reason: "not_stable_long_enough", runLength, durationMs };
  }
  return { stable: true, reason: "stable", hash: last.hash, runLength, durationMs };
}

function hasOddCodeFence(text) {
  const matches = text.match(/```/g);
  return Boolean(matches) && matches.length % 2 !== 0;
}

const SENTENCE_END_RE = /[.!?。！？:;：；\]\)`"'"'】》]\s*$/u;

function hasAbruptTail(text) {
  const trimmed = text.replace(/\s+$/u, "");
  if (!trimmed) return false;
  if (trimmed.includes(REPLY_END_MARKER)) return false;
  return !SENTENCE_END_RE.test(trimmed);
}

export function containsEndMarker(text) {
  return typeof text === "string" && text.includes(REPLY_END_MARKER);
}

// Surfaces anomalies rather than guessing; the caller (decideState) turns
// these into NEEDS_DECISION / FAILED rather than silently resolving them.
export function detectAnomalies({
  text,
  stopVisible = false,
  continueVisible = false,
  loginWall = false,
  networkError = false,
  baselineValid = true,
  requireEndMarker = false,
} = {}) {
  const detections = [];
  if (loginWall) detections.push("login_wall");
  if (networkError) detections.push("network_error");
  if (continueVisible) detections.push("continue_button");
  if (!baselineValid) detections.push("baseline_invalid");
  if (typeof text === "string" && text.length > 0) {
    if (hasOddCodeFence(text)) detections.push("odd_code_fence");
    if (requireEndMarker && !containsEndMarker(text)) detections.push("missing_end_marker");
    if (!stopVisible && hasAbruptTail(text)) detections.push("abrupt_tail");
  }
  return detections;
}

// Combines the Stop-button gate, the hash-stability gate, and any surfaced
// detections into a single WAITING / DONE / NEEDS_DECISION / FAILED verdict.
export function decideState({ stopVisible, stability, detections = [] }) {
  const failure = detections.find((d) => FAILURE_DETECTIONS.has(d));
  if (failure) {
    return { status: "FAILED", reason: failure };
  }
  if (detections.includes("login_wall")) {
    return { status: "NEEDS_DECISION", reason: "login_wall" };
  }
  // P1-6 fail-closed fix: a malformed payload (e.g. a DOM selector that no
  // longer matches anything live - assistantMessages missing/not an array)
  // makes extractCandidateMessage() report baseline_invalid every poll and
  // never push a hash sample (see pollOnce). Left ungated behind the
  // stability check below, that combination can never become "stable" and
  // would poll WAITING forever instead of ever surfacing - never a false
  // empty-set DONE, but also never resolved. Surface it immediately, the
  // same way login_wall is, rather than hanging indefinitely.
  if (detections.includes("baseline_invalid")) {
    return { status: "NEEDS_DECISION", reason: "baseline_invalid" };
  }
  // Stop button existing always blocks DONE, regardless of apparent hash
  // stability (protects against a mid-generation pause looking "stable").
  if (stopVisible) {
    return { status: "WAITING", reason: "stop_visible" };
  }
  if (!stability?.stable) {
    return { status: "WAITING", reason: stability?.reason ?? "not_stable" };
  }
  const decisionBlocker = detections.find((d) => DECISION_DETECTIONS.has(d));
  if (decisionBlocker) {
    return { status: "NEEDS_DECISION", reason: decisionBlocker };
  }
  return { status: "DONE", reason: "stable" };
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

// One read + decision cycle. `pollState.history` accumulates hash samples
// across calls so evaluateStability can see the run of identical hashes.
export async function pollOnce(job, pollState, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const data = await readConversationSnapshot(job.conversation_url, opts);

  const candidateIndex = pickCandidateIndex(job.baseline.assistant_count);
  const extraction = extractCandidateMessage(data.assistantMessages, candidateIndex);

  if (!extraction.ok && extraction.reason === "not_yet_arrived") {
    return {
      status: "WAITING",
      reason: "not_yet_arrived",
      data,
      extraction,
      detections: [],
      stability: { stable: false, reason: "not_yet_arrived" },
    };
  }

  const text = extraction.ok ? extraction.message : "";
  if (extraction.ok) {
    pollState.history.push({ hash: computeReplyHash(text), atMs: now() });
  }
  const stability = evaluateStability(pollState.history, opts.stabilityOpts);
  const detections = detectAnomalies({
    text,
    stopVisible: data.stopVisible,
    continueVisible: data.continueVisible,
    loginWall: data.loginWall,
    networkError: data.networkError,
    baselineValid: extraction.ok,
    requireEndMarker: opts.requireEndMarker,
  });
  const decision = decideState({ stopVisible: data.stopVisible, stability, detections });

  return { ...decision, data, extraction, detections, stability, text };
}

// Drives pollOnce until a terminal decision, then persists it via
// result_store.persistResult. Never resends the prompt: on repeated
// connection failure it just keeps re-attaching (readConversationSnapshot
// always redoes list -> match -> select -> verify) until
// maxConsecutivePollFailures is exceeded, at which point it gives up with a
// FAILED/cdp_unreachable result rather than looping forever.
export async function runWatchLoop(job, opts = {}) {
  const {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxConsecutivePollFailures = DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    persist = persistResult,
    jobDir,
    ...pollOpts
  } = opts;

  const pollState = { history: [] };
  let consecutiveFailures = 0;
  let lastGoodText = "";
  const startedAt = new Date(now()).toISOString();

  for (;;) {
    let outcome;
    try {
      outcome = await pollOnce(job, pollState, { ...pollOpts, now });
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures += 1;
      if (consecutiveFailures > maxConsecutivePollFailures) {
        return persist({
          jobDir,
          job,
          state: "FAILED",
          replyText: lastGoodText,
          startedAt,
          completedAt: new Date(now()).toISOString(),
          error: e?.code ?? e?.message ?? "cdp_unreachable",
          detections: ["cdp_unreachable"],
        });
      }
      await sleep(pollIntervalMs);
      continue;
    }

    if (outcome.extraction?.ok) lastGoodText = outcome.text;

    if (outcome.status === "WAITING") {
      await sleep(pollIntervalMs);
      continue;
    }

    return persist({
      jobDir,
      job,
      state: outcome.status,
      replyText: lastGoodText,
      startedAt,
      completedAt: new Date(now()).toISOString(),
      detections: outcome.detections,
    });
  }
}
