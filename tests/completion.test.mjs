// GPT_BROWSER_BRIDGE - Watcher completion / CLI-gate tests (GBB-003)
// node:test only. No third-party test framework, no live browser: the
// Playwright CLI's `exec` transport is always injected with a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
