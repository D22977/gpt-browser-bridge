// GPT_BROWSER_BRIDGE - Watcher completion / CLI-gate tests (GBB-003)
// node:test only. No third-party test framework, no live browser: the
// Playwright CLI's `exec` transport is always injected with a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir as mkdirAsync, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

import {
  pickCandidateIndex,
  extractCandidateMessage,
  computeReplyHash,
  evaluateStability,
  detectAnomalies,
  decideState,
  containsEndMarker,
  runCliCommand,
  readConversationSnapshot,
  pollOnce,
  runWatchLoop,
  WatchInvalidationError,
  ALLOWED_CLI_SUBCOMMANDS,
  READONLY_SNAPSHOT_SCRIPT,
  REPLY_END_MARKER,
  parseTabList,
  extractConversationId,
  resolveSpawnTarget,
  withSessionMutex,
} from "../src/gpt_watch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures", "chatgpt");
const CONVERSATION_URL = "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949";

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8"));
}
async function loadReplyFixture(name) {
  return readFile(path.join(FIXTURES, name), "utf8");
}

function jsonStdout(value) {
  return { stdout: JSON.stringify({ result: value }), stderr: "" };
}

// ---------------------------------------------------------------------------
// Candidate indexing: the 5th and 6th answers must never be confused.
// ---------------------------------------------------------------------------

test("pickCandidateIndex mirrors baseline.assistant_count exactly", () => {
  assert.equal(pickCandidateIndex(5), 5);
  assert.equal(pickCandidateIndex(0), 0);
  assert.throws(() => pickCandidateIndex(-1));
  assert.throws(() => pickCandidateIndex(1.5));
});

test("extractCandidateMessage picks the 6th answer (index 5) and never the 5th (index 4)", async () => {
  const fixture = await loadFixture("six_answers_snapshot.json");
  const sixth = extractCandidateMessage(fixture.assistantMessages, pickCandidateIndex(5));
  const fifth = extractCandidateMessage(fixture.assistantMessages, pickCandidateIndex(4));
  assert.equal(sixth.ok, true);
  assert.equal(fifth.ok, true);
  assert.match(sixth.message, /^Answer 6:/);
  assert.match(fifth.message, /^Answer 5:/);
  assert.notEqual(sixth.message, fifth.message);
});

test("extractCandidateMessage reports not_yet_arrived when the candidate has not appeared yet", () => {
  const result = extractCandidateMessage(["a", "b"], 2);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_yet_arrived");
});

test("extractCandidateMessage reports baseline_invalid on malformed input rather than guessing", () => {
  assert.equal(extractCandidateMessage(null, 0).reason, "baseline_invalid");
  assert.equal(extractCandidateMessage(["a"], -1).reason, "baseline_invalid");
});

// ---------------------------------------------------------------------------
// Stability: >=3 identical hashes AND >=15s stable duration.
// ---------------------------------------------------------------------------

test("evaluateStability requires at least 3 samples", () => {
  const h = computeReplyHash("final text");
  const r = evaluateStability([
    { hash: h, atMs: 0 },
    { hash: h, atMs: 20_000 },
  ]);
  assert.equal(r.stable, false);
  assert.equal(r.reason, "insufficient_samples");
});

test("evaluateStability requires at least 15s of stable duration even with 3+ samples (fast replies are not missed, just confirmed)", () => {
  const h = computeReplyHash("final text");
  // A reply that finished instantly still needs the watcher to keep polling
  // long enough to confirm it, rather than declaring victory on read #1.
  const notLongEnough = evaluateStability([
    { hash: h, atMs: 0 },
    { hash: h, atMs: 3_000 },
    { hash: h, atMs: 6_000 },
  ]);
  assert.equal(notLongEnough.stable, false);
  assert.equal(notLongEnough.reason, "not_stable_long_enough");

  const longEnough = evaluateStability([
    { hash: h, atMs: 0 },
    { hash: h, atMs: 7_500 },
    { hash: h, atMs: 15_000 },
  ]);
  assert.equal(longEnough.stable, true);
});

test("evaluateStability only counts the trailing run of identical hashes (a text change resets the count)", () => {
  const hOld = computeReplyHash("draft");
  const hNew = computeReplyHash("final");
  const r = evaluateStability([
    { hash: hOld, atMs: 0 },
    { hash: hOld, atMs: 5_000 },
    { hash: hNew, atMs: 10_000 }, // text changed here
    { hash: hNew, atMs: 20_000 },
    { hash: hNew, atMs: 30_000 },
  ]);
  assert.equal(r.stable, true);
  assert.equal(r.hash, hNew);
  assert.equal(r.durationMs, 20_000);
});

// ---------------------------------------------------------------------------
// Detections
// ---------------------------------------------------------------------------

test("detectAnomalies flags an odd number of code fences", async () => {
  const text = await loadReplyFixture("reply_odd_code_fence.md");
  const detections = detectAnomalies({ text, stopVisible: false });
  assert.ok(detections.includes("odd_code_fence"));
});

test("detectAnomalies flags an abrupt tail only once generation has actually stopped", async () => {
  const text = await loadReplyFixture("reply_abrupt_tail.md");
  const whileStopped = detectAnomalies({ text, stopVisible: false });
  assert.ok(whileStopped.includes("abrupt_tail"));
  // Mid-stream (Stop still visible) an in-progress sentence must not be
  // flagged as an anomaly - it just has not finished yet.
  const whileGenerating = detectAnomalies({ text, stopVisible: true });
  assert.ok(!whileGenerating.includes("abrupt_tail"));
});

test("detectAnomalies flags a missing end marker only when the protocol requires one", async () => {
  const text = await loadReplyFixture("reply_missing_end_marker.md");
  assert.ok(!containsEndMarker(text));
  assert.ok(detectAnomalies({ text, stopVisible: false, requireEndMarker: true }).includes("missing_end_marker"));
  assert.ok(!detectAnomalies({ text, stopVisible: false, requireEndMarker: false }).includes("missing_end_marker"));
});

test("detectAnomalies reports no anomalies for a clean, well-formed reply", async () => {
  const text = await loadReplyFixture("reply_clean.md");
  const detections = detectAnomalies({ text, stopVisible: false, requireEndMarker: true });
  assert.deepEqual(detections, []);
});

test("detectAnomalies surfaces login_wall / network_error / continue_button / baseline_invalid", () => {
  assert.ok(detectAnomalies({ loginWall: true }).includes("login_wall"));
  assert.ok(detectAnomalies({ networkError: true }).includes("network_error"));
  assert.ok(detectAnomalies({ continueVisible: true }).includes("continue_button"));
  assert.ok(detectAnomalies({ baselineValid: false }).includes("baseline_invalid"));
});

// ---------------------------------------------------------------------------
// decideState: Stop button gating, terminal state selection.
// ---------------------------------------------------------------------------

test("decideState never returns DONE while the Stop button is visible, even if the hash looks stable (no false completion on a mid-generation pause)", () => {
  const stability = { stable: true, hash: "x" };
  const r = decideState({ stopVisible: true, stability, detections: [] });
  assert.equal(r.status, "WAITING");
  assert.equal(r.reason, "stop_visible");
});

test("decideState returns DONE once Stop is gone and the reply is stable with no anomalies", () => {
  const r = decideState({ stopVisible: false, stability: { stable: true }, detections: [] });
  assert.equal(r.status, "DONE");
});

test("decideState returns NEEDS_DECISION on a login wall immediately, without waiting for stability", () => {
  const r = decideState({ stopVisible: false, stability: { stable: false }, detections: ["login_wall"] });
  assert.equal(r.status, "NEEDS_DECISION");
  assert.equal(r.reason, "login_wall");
});

test("decideState returns NEEDS_DECISION for a stable reply that still carries a content anomaly", () => {
  const r = decideState({ stopVisible: false, stability: { stable: true }, detections: ["odd_code_fence"] });
  assert.equal(r.status, "NEEDS_DECISION");
});

test("decideState returns FAILED on a technical-failure detection (never guesses content state)", () => {
  const r = decideState({ stopVisible: false, stability: { stable: false }, detections: ["cdp_unreachable"] });
  assert.equal(r.status, "FAILED");
});

test("decideState waits when unstable and no blocking detection is present", () => {
  const r = decideState({ stopVisible: false, stability: { stable: false, reason: "insufficient_samples" }, detections: [] });
  assert.equal(r.status, "WAITING");
});

// ---------------------------------------------------------------------------
// P1-6 (CONT_DISPATCH2): a missing selector / payload schema mismatch must
// surface NEEDS_DECISION/FAILED, never a stable-completion with an empty set.
// ---------------------------------------------------------------------------

test("decideState surfaces baseline_invalid immediately, even with zero samples (never hangs waiting for a stability that can never happen)", () => {
  const r = decideState({ stopVisible: false, stability: { stable: false, reason: "no_samples" }, detections: ["baseline_invalid"] });
  assert.equal(r.status, "NEEDS_DECISION");
  assert.equal(r.reason, "baseline_invalid");
});

test("pollOnce + decideState: a permanently malformed snapshot (selector no longer matches) surfaces NEEDS_DECISION, never a false empty DONE", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const job = { conversation_url: CONVERSATION_URL, baseline: { assistant_count: 0 } };
  // Live-DOM finding this guards against: if ChatGPT's markup changes and
  // `[data-message-author-role="assistant"]` stops matching anything, the
  // fixed eval script returns assistantMessages: undefined rather than an
  // array - a schema mismatch, not merely "no messages yet".
  const brokenExec = async (cliPath, args) => {
    const subcommand = args[2];
    if (subcommand === "tab-list") return jsonStdout(tabs);
    if (subcommand === "tab-select") return jsonStdout(null);
    if (subcommand === "eval") return jsonStdout({ url: CONVERSATION_URL, stopVisible: false });
    throw new Error("unexpected");
  };
  const outcome = await pollOnce(job, { history: [] }, { session: "s", exec: brokenExec, now: () => 0 });
  assert.equal(outcome.status, "NEEDS_DECISION");
  assert.equal(outcome.reason, "baseline_invalid");
});

// ---------------------------------------------------------------------------
// Gate F: whitelist + no browser write API anywhere in the Watcher source.
// ---------------------------------------------------------------------------

test("Gate F: the CLI whitelist excludes every write/dashboard subcommand", () => {
  for (const forbidden of ["click", "fill", "press", "tab-close", "tab-new", "run-code", "show", "navigate", "goto"]) {
    assert.ok(!ALLOWED_CLI_SUBCOMMANDS.includes(forbidden), `${forbidden} must not be whitelisted`);
  }
});

test("Gate F: runCliCommand rejects any subcommand outside the whitelist", async () => {
  await assert.rejects(() => runCliCommand("fill", ["#x", "y"], { session: "s", exec: async () => jsonStdout(null) }));
  await assert.rejects(() => runCliCommand("show", [], { session: "s", exec: async () => jsonStdout(null) }));
});

// ---------------------------------------------------------------------------
// Real CLI object-envelope parsing (P1-1 rework): fixtures/chatgpt/live_*.json
// were captured from the actual `@playwright/cli` 0.1.17 binary attached to
// a real CDP endpoint (127.0.0.1:9225), not hand-written. See each fixture's
// `_finding` field for what it proves.
// ---------------------------------------------------------------------------

test("parseTabList parses the real tab-list markdown shape (single tab, current)", async () => {
  const fixture = await loadFixture("live_tab_list_single.json");
  const parsed = JSON.parse(fixture.stdout);
  const tabs = parseTabList(parsed.result);
  assert.deepEqual(tabs, [
    { index: 0, current: true, title: "GBB-003 功能驗收結果", url: "https://chatgpt.com/c/6a6cefb4-b2f8-83ee-8237-c22cb949dba1" },
  ]);
});

test("parseTabList parses the real tab-list markdown shape (multiple tabs) and picks the right one by URL", async () => {
  const fixture = await loadFixture("live_tab_list_multi.json");
  const parsed = JSON.parse(fixture.stdout);
  const tabs = parseTabList(parsed.result);
  assert.equal(tabs.length, 2);
  const match = tabs.find((t) => extractConversationId(t.url) === "6a6cefb4-b2f8-83ee-8237-c22cb949dba1");
  assert.ok(match);
  assert.equal(match.index, 0);
  assert.equal(match.current, false);
});

test("readConversationSnapshot works end to end against the real markdown tab-list envelope (not the hand-written array fixture)", async () => {
  const fixture = await loadFixture("live_tab_list_single.json");
  const url = "https://chatgpt.com/c/6a6cefb4-b2f8-83ee-8237-c22cb949dba1";
  const exec = async (cliPath, args) => {
    const subcommand = args[2];
    if (subcommand === "tab-list") return { stdout: fixture.stdout, stderr: "" };
    if (subcommand === "tab-select") return jsonStdout(null);
    if (subcommand === "eval") return jsonStdout({ url, assistantMessages: ["hi"], stopVisible: false });
    throw new Error("unexpected subcommand " + subcommand);
  };
  const data = await readConversationSnapshot(url, { session: "s", exec });
  assert.equal(data.url, url);
});

test("runCliCommand parses the real object-returning eval envelope (READONLY_SNAPSHOT_SCRIPT shape)", async () => {
  const fixture = await loadFixture("live_eval_object.json");
  const exec = async () => ({ stdout: fixture.stdout, stderr: "" });
  const result = await runCliCommand("eval", [READONLY_SNAPSHOT_SCRIPT], { session: "s", exec });
  assert.equal(result.url, "https://chatgpt.com/c/6a6cefb4-b2f8-83ee-8237-c22cb949dba1");
  assert.ok(Array.isArray(result.assistantMessages));
});

test("runCliCommand throws on the real isError:true / exit-0 error envelope instead of treating it as valid data", async () => {
  const fixture = await loadFixture("live_cli_error.json");
  const exec = async () => ({ stdout: fixture.stdout_eval_syntax_error, stderr: "" });
  await assert.rejects(
    () => runCliCommand("eval", [READONLY_SNAPSHOT_SCRIPT], { session: "s", exec }),
    (err) => err instanceof WatchInvalidationError && err.code === "CLI_ERROR_RESPONSE:eval"
  );
});

test("runCliCommand throws on a real tab-select-not-found isError response", async () => {
  const fixture = await loadFixture("live_cli_error.json");
  const exec = async () => ({ stdout: fixture.stdout_tab_select_not_found, stderr: "" });
  await assert.rejects(
    () => runCliCommand("tab-select", ["99"], { session: "s", exec }),
    (err) => err instanceof WatchInvalidationError && err.code === "CLI_ERROR_RESPONSE:tab-select"
  );
});

// ---------------------------------------------------------------------------
// P2: exit 0 with empty / truncated / mixed-non-JSON stdout must never be
// mistaken for valid data.
// ---------------------------------------------------------------------------

test("runCliCommand throws CLI_INVALID_JSON on exit-0-with-empty stdout", async () => {
  const exec = async () => ({ stdout: "", stderr: "" });
  await assert.rejects(
    () => runCliCommand("eval", [READONLY_SNAPSHOT_SCRIPT], { session: "s", exec }),
    (err) => err instanceof WatchInvalidationError && err.code === "CLI_INVALID_JSON:eval"
  );
});

test("runCliCommand throws CLI_INVALID_JSON on truncated JSON stdout", async () => {
  const exec = async () => ({ stdout: '{"result": {"url": "https://chatgpt.com/c/x", "assistantMes', stderr: "" });
  await assert.rejects(
    () => runCliCommand("eval", [READONLY_SNAPSHOT_SCRIPT], { session: "s", exec }),
    (err) => err instanceof WatchInvalidationError && err.code === "CLI_INVALID_JSON:eval"
  );
});

test("runCliCommand throws CLI_INVALID_JSON on mixed non-JSON stdout (e.g. a stray log line before the envelope)", async () => {
  const exec = async () => ({ stdout: 'warning: something\n{"result": null}', stderr: "" });
  await assert.rejects(
    () => runCliCommand("eval", [READONLY_SNAPSHOT_SCRIPT], { session: "s", exec }),
    (err) => err instanceof WatchInvalidationError && err.code === "CLI_INVALID_JSON:eval"
  );
});

test("Gate F: runCliCommand rejects any eval script other than the fixed read-only template", async () => {
  await assert.rejects(() =>
    runCliCommand("eval", ["() => document.location = 'https://evil.example/'"], {
      session: "s",
      exec: async () => jsonStdout(null),
    })
  );
  // The exact whitelisted template is still accepted.
  await assert.doesNotReject(() =>
    runCliCommand("eval", [READONLY_SNAPSHOT_SCRIPT], { session: "s", exec: async () => jsonStdout({ url: CONVERSATION_URL }) })
  );
});

// ---------------------------------------------------------------------------
// Live-capture finding (fixtures/chatgpt/live_canary_send_watch.json,
// CMD_SHIM_SPAWN_EINVAL): see tests/baseline.test.mjs for the full rationale
// - duplicated here since gpt_watch.mjs keeps its own defaultExec (Gate F).
// ---------------------------------------------------------------------------

test("resolveSpawnTarget resolves a .cmd shim to `node <sibling cli.js>` (no shell)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gbb003-watch-spawn-target-"));
  const shimDir = path.join(root, "pkgA", "node_modules", ".bin");
  const entryDir = path.join(root, "pkgA", "node_modules", "playwright");
  await mkdirAsync(shimDir, { recursive: true });
  await mkdirAsync(entryDir, { recursive: true });
  const entry = path.join(entryDir, "cli.js");
  await writeFile(entry, "// stub");
  const cliPath = path.join(shimDir, "playwright.cmd");
  await writeFile(cliPath, "@ECHO off");

  const target = resolveSpawnTarget(cliPath);
  assert.equal(target.command, process.execPath);
  assert.deepEqual(target.prefixArgs, [entry]);
});

test("resolveSpawnTarget throws a clear error when the .cmd shim's sibling entry does not exist", () => {
  assert.throws(() => resolveSpawnTarget("C:\\nowhere\\playwright.cmd"), /cannot resolve/);
});

test("Gate F / SECURITY.md §6: gpt_watch.mjs source contains no browser write API and never imports the Sender", async () => {
  const source = await readFile(path.join(__dirname, "..", "src", "gpt_watch.mjs"), "utf8");
  const forbiddenPatterns = [/\.click\(/, /\.fill\(/, /\.press\(/, /\.keyboard\b/, /\.mouse\b/, /\.goto\(/, /\.newPage\(/, /\.bringToFront\(/];
  for (const pattern of forbiddenPatterns) {
    assert.ok(!pattern.test(source), `forbidden pattern ${pattern} found in gpt_watch.mjs`);
  }
  assert.ok(!source.includes("gpt_send"), "gpt_watch.mjs must never import the Sender - it can never resend a prompt");
});

// ---------------------------------------------------------------------------
// Gate B/C/D/E/H: the CLI wrapper (fake exec, no live browser required).
// ---------------------------------------------------------------------------

test("Gate B/C: locates the single matching tab, selects it, and verifies the URL in the same read", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const snapshot = { url: CONVERSATION_URL, assistantMessages: ["hi"], stopVisible: false };
  const exec = async (cliPath, args) => {
    const subcommand = args[2];
    if (subcommand === "tab-list") return jsonStdout(tabs);
    if (subcommand === "tab-select") return jsonStdout(null);
    if (subcommand === "eval") return jsonStdout(snapshot);
    throw new Error("unexpected subcommand " + subcommand);
  };
  const data = await readConversationSnapshot(CONVERSATION_URL, { session: "s", exec });
  assert.equal(data.url, CONVERSATION_URL);
});

test("Gate B: zero matching tabs fails closed rather than guessing", async () => {
  const tabs = await loadFixture("tab_list_no_match.json");
  const exec = async (cliPath, args) => (args[2] === "tab-list" ? jsonStdout(tabs) : jsonStdout(null));
  await assert.rejects(
    () => readConversationSnapshot(CONVERSATION_URL, { session: "s", exec, maxRetries: 0 }),
    (err) => err instanceof WatchInvalidationError && err.code === "MAX_RETRIES_EXCEEDED"
  );
});

test("Gate B: multiple matching tabs fails closed rather than guessing", async () => {
  const tabs = await loadFixture("tab_list_multi_match.json");
  const exec = async (cliPath, args) => (args[2] === "tab-list" ? jsonStdout(tabs) : jsonStdout(null));
  await assert.rejects(
    () => readConversationSnapshot(CONVERSATION_URL, { session: "s", exec, maxRetries: 0 }),
    (err) => err instanceof WatchInvalidationError && err.code === "MAX_RETRIES_EXCEEDED"
  );
});

test("Gate C: a post-select navigation (URL mismatch) is discarded, not trusted", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const exec = async (cliPath, args) => {
    const subcommand = args[2];
    if (subcommand === "tab-list") return jsonStdout(tabs);
    if (subcommand === "tab-select") return jsonStdout(null);
    if (subcommand === "eval") return jsonStdout({ url: "https://chatgpt.com/c/00000000-0000-0000-0000-000000000000" });
    throw new Error("unexpected");
  };
  await assert.rejects(() => readConversationSnapshot(CONVERSATION_URL, { session: "s", exec, maxRetries: 0 }));
});

// ---------------------------------------------------------------------------
// P1-5 (CONT_DISPATCH2): a second-verify (Gate C) mismatch must discard the
// WHOLE round - no partial reuse of the stale selection - and the retry must
// redo list -> match -> select -> verify completely from scratch.
// ---------------------------------------------------------------------------

test("Gate C/H: a URL-verify mismatch discards the whole round; the retry re-lists, re-matches, re-selects, re-verifies from scratch and succeeds on fresh data", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const goodSnapshot = { url: CONVERSATION_URL, assistantMessages: ["real answer"], stopVisible: false };
  let tabListCalls = 0;
  let tabSelectCalls = 0;
  let evalCalls = 0;
  const exec = async (cliPath, args) => {
    const subcommand = args[2];
    if (subcommand === "tab-list") {
      tabListCalls += 1;
      return jsonStdout(tabs);
    }
    if (subcommand === "tab-select") {
      tabSelectCalls += 1;
      return jsonStdout(null);
    }
    if (subcommand === "eval") {
      evalCalls += 1;
      // First round: the tab navigated away between select and read (Gate C
      // mismatch). Second round: a clean, matching read.
      if (evalCalls === 1) return jsonStdout({ url: "https://chatgpt.com/c/00000000-0000-0000-0000-000000000000" });
      return jsonStdout(goodSnapshot);
    }
    throw new Error("unexpected subcommand " + subcommand);
  };
  const data = await readConversationSnapshot(CONVERSATION_URL, { session: "s", exec, maxRetries: 1 });
  assert.equal(data.url, CONVERSATION_URL);
  assert.deepEqual(data.assistantMessages, ["real answer"]);
  // Full redo, not a partial resume: list/select/eval must each have run
  // twice (once per round), proving nothing from the mismatched round was
  // cached or reused.
  assert.equal(tabListCalls, 2, "retry must re-list from scratch");
  assert.equal(tabSelectCalls, 2, "retry must re-select from scratch");
  assert.equal(evalCalls, 2, "retry must re-verify from scratch");
});

test("Gate D/H: a transient disconnect invalidates the selection; retry redoes list -> match -> select -> verify from scratch (never resends anything)", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const snapshot = { url: CONVERSATION_URL, assistantMessages: ["hi"], stopVisible: false };
  let tabListCalls = 0;
  const exec = async (cliPath, args) => {
    const subcommand = args[2];
    if (subcommand === "tab-list") {
      tabListCalls += 1;
      if (tabListCalls === 1) throw new Error("ECONNRESET");
      return jsonStdout(tabs);
    }
    if (subcommand === "tab-select") return jsonStdout(null);
    if (subcommand === "eval") return jsonStdout(snapshot);
    throw new Error("unexpected subcommand " + subcommand);
  };
  const data = await readConversationSnapshot(CONVERSATION_URL, { session: "s", exec, maxRetries: 2 });
  assert.equal(data.url, CONVERSATION_URL);
  assert.equal(tabListCalls, 2, "retry must re-list from scratch, not resume a cached selection");
});

test("Gate E: operations against the same session never interleave (mutex-serialized)", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const snapshot = { url: CONVERSATION_URL, assistantMessages: ["hi"], stopVisible: false };
  let active = 0;
  let maxActive = 0;
  const exec = async (cliPath, args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    const subcommand = args[2];
    if (subcommand === "tab-list") return jsonStdout(tabs);
    if (subcommand === "tab-select") return jsonStdout(null);
    if (subcommand === "eval") return jsonStdout(snapshot);
    throw new Error("unexpected");
  };
  await Promise.all([
    readConversationSnapshot(CONVERSATION_URL, { session: "gate-e", exec }),
    readConversationSnapshot(CONVERSATION_URL, { session: "gate-e", exec }),
  ]);
  assert.equal(maxActive, 1);
});

// ---------------------------------------------------------------------------
// P1-3 (CONT_DISPATCH2): mutex rejection recovery. A rejected task must not
// permanently jam the per-session queue, and unrelated sessions must never
// be serialized against each other.
// ---------------------------------------------------------------------------

test("Gate E: a rejected task does not deadlock the session mutex - the next task on the same session still runs", async () => {
  await assert.rejects(() => withSessionMutex("gate-e-reject", () => Promise.reject(new Error("boom"))), /boom/);
  const second = await withSessionMutex("gate-e-reject", () => Promise.resolve("still runs"));
  assert.equal(second, "still runs");
  // And a third, to prove the queue keeps working rather than just recovering once.
  const third = await withSessionMutex("gate-e-reject", () => Promise.resolve("still runs again"));
  assert.equal(third, "still runs again");
});

test("Gate E: same-session tasks never overlap even when an earlier one rejects mid-flight", async () => {
  let active = 0;
  let maxActive = 0;
  const track = async (fn) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      return await fn();
    } finally {
      active -= 1;
    }
  };
  const results = await Promise.allSettled([
    withSessionMutex("gate-e-overlap", () => track(() => new Promise((_, reject) => setTimeout(() => reject(new Error("first fails")), 10)))),
    withSessionMutex("gate-e-overlap", () => track(() => new Promise((resolve) => setTimeout(() => resolve("second ok"), 10)))),
    withSessionMutex("gate-e-overlap", () => track(() => new Promise((resolve) => setTimeout(() => resolve("third ok"), 10)))),
  ]);
  assert.equal(maxActive, 1, "tasks on the same session must never run concurrently, rejection or not");
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[1].value, "second ok");
  assert.equal(results[2].status, "fulfilled");
  assert.equal(results[2].value, "third ok");
});

// ---------------------------------------------------------------------------
// P1-4 (CONT_DISPATCH2): real subprocess termination evidence. Spawns actual
// hanging node child processes (not a fake exec) to prove the timeout->kill
// mechanics and the mutex's no-overlap guarantee hold against a real OS
// process, not just a resolved/rejected Promise.
// ---------------------------------------------------------------------------

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("P1-4: a real hanging child is killed on timeout and confirmed dead, and the session mutex never overlaps real children", async () => {
  function spawnHangingChild() {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { timeout: 300, windowsHide: true },
        (err) => (err ? reject(Object.assign(err, { pid: child.pid })) : resolve({ pid: child.pid }))
      );
    });
  }

  let active = 0;
  let maxActive = 0;
  const deadPids = [];

  async function task() {
    active += 1;
    maxActive = Math.max(maxActive, active);
    let pid;
    try {
      await spawnHangingChild();
      assert.fail("a deliberately hanging child must be killed by the timeout, not resolve cleanly");
    } catch (e) {
      pid = e.pid;
    } finally {
      active -= 1;
    }
    // execFile's callback (and so this task's own promise) only fires after
    // Node's 'close' event - i.e. once the real OS process has actually
    // exited (stdout/stderr fully drained), not merely once SIGTERM was
    // sent. A still-draining stream must not be mistaken for completion.
    assert.equal(isAlive(pid), false, "the real child must already be dead by the time the task settles");
    deadPids.push(pid);
  }

  await Promise.all([
    withSessionMutex("p1-4-real-child", task),
    withSessionMutex("p1-4-real-child", task),
    withSessionMutex("p1-4-real-child", task),
  ]);

  assert.equal(maxActive, 1, "no two real children for the same session may run concurrently");
  assert.equal(deadPids.length, 3);
  assert.equal(new Set(deadPids).size, 3, "each task spawned its own distinct real child process");
});

test("Gate E: different sessions are not globally serialized against each other", async () => {
  let active = 0;
  let maxActive = 0;
  const track = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return "ok";
  };
  const results = await Promise.all([
    withSessionMutex("session-a", track),
    withSessionMutex("session-b", track),
  ]);
  assert.deepEqual(results, ["ok", "ok"]);
  assert.equal(maxActive, 2, "different session names must be able to run concurrently");
});

// ---------------------------------------------------------------------------
// pollOnce / runWatchLoop: end-to-end decision making with a fake clock.
// ---------------------------------------------------------------------------

function makeWatchExec(tabs, evalResponses) {
  let calls = 0;
  return async (cliPath, args) => {
    const subcommand = args[2];
    if (subcommand === "tab-list") return jsonStdout(tabs);
    if (subcommand === "tab-select") return jsonStdout(null);
    if (subcommand === "eval") {
      const r = evalResponses[Math.min(calls, evalResponses.length - 1)];
      calls += 1;
      return jsonStdout({
        url: CONVERSATION_URL,
        assistantMessages: [...Array(5).fill("old answer"), r.text],
        stopVisible: r.stopVisible,
        continueVisible: false,
        loginWall: false,
        networkError: false,
      });
    }
    throw new Error("unexpected subcommand " + subcommand);
  };
}

test("pollOnce waits while the Stop button is visible and while the candidate has not arrived yet", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const job = { conversation_url: CONVERSATION_URL, baseline: { assistant_count: 5 } };

  const notArrivedExec = async (cliPath, args) => {
    const subcommand = args[2];
    if (subcommand === "tab-list") return jsonStdout(tabs);
    if (subcommand === "tab-select") return jsonStdout(null);
    if (subcommand === "eval")
      return jsonStdout({ url: CONVERSATION_URL, assistantMessages: ["a", "b"], stopVisible: false });
    throw new Error("unexpected");
  };
  const notArrived = await pollOnce(job, { history: [] }, { session: "s", exec: notArrivedExec, now: () => 0 });
  assert.equal(notArrived.status, "WAITING");
  assert.equal(notArrived.reason, "not_yet_arrived");

  const stopExec = makeWatchExec(tabs, [{ stopVisible: true, text: "still typing" }]);
  const stopStill = await pollOnce(job, { history: [] }, { session: "s", exec: stopExec, now: () => 0 });
  assert.equal(stopStill.status, "WAITING");
  assert.equal(stopStill.reason, "stop_visible");
});

test("runWatchLoop: a fast, clean reply is confirmed DONE only after Stop disappears and the hash is stable for >=3 samples / >=15s, and never resends", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const evalResponses = [
    { stopVisible: true, text: "Partial 1" },
    { stopVisible: true, text: "Partial 2" }, // mid-stream pause: must not look done
    { stopVisible: false, text: "Final text." },
    { stopVisible: false, text: "Final text." },
    { stopVisible: false, text: "Final text." },
    { stopVisible: false, text: "Final text." },
  ];
  const exec = makeWatchExec(tabs, evalResponses);
  const job = { schema_version: 1, job_id: "j1", conversation_url: CONVERSATION_URL, baseline: { assistant_count: 5 } };

  let clock = 0;
  const persisted = [];
  const persist = async (args) => {
    persisted.push(args);
    return args;
  };

  await runWatchLoop(job, {
    session: "s",
    exec,
    jobDir: "irrelevant-for-this-test",
    pollIntervalMs: 5_000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    persist,
  });

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].state, "DONE");
  assert.equal(persisted[0].job.job_id, "j1");
  assert.equal(persisted[0].replyText, "Final text.");
  assert.deepEqual(persisted[0].detections, []);
});

test("runWatchLoop: repeated disconnects surface FAILED/cdp_unreachable instead of looping forever or resending", async () => {
  const exec = async () => {
    throw new Error("ECONNREFUSED");
  };
  const job = { schema_version: 1, job_id: "j2", conversation_url: CONVERSATION_URL, baseline: { assistant_count: 0 } };
  let clock = 0;
  const persisted = [];
  const persist = async (args) => {
    persisted.push(args);
    return args;
  };

  await runWatchLoop(job, {
    session: "s",
    exec,
    jobDir: "irrelevant-for-this-test",
    pollIntervalMs: 1_000,
    maxConsecutivePollFailures: 2,
    maxRetries: 0,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    persist,
  });

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].state, "FAILED");
  assert.deepEqual(persisted[0].detections, ["cdp_unreachable"]);
});
