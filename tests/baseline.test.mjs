// GPT_BROWSER_BRIDGE - Sender / baseline tests (GBB-003)
// node:test only. No third-party test framework, no live browser: the
// Playwright CLI's `exec` transport is always injected with a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computePromptHash,
  readBaselineFromSnapshot,
  generateJobId,
  buildJob,
  resolveJobDir,
  writeJobFile,
  waitConversationUrl,
  locateChatgptTab,
  sendJob,
  SendInvalidationError,
} from "../src/gpt_send.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures", "chatgpt");

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8"));
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fakeExecFactory(handlers) {
  const calls = [];
  const counts = {};
  async function exec(cliPath, args, opts) {
    const subcommand = args[2];
    calls.push({ cliPath, args, opts });
    counts[subcommand] = (counts[subcommand] || 0) + 1;
    const handler = handlers[subcommand];
    if (!handler) throw new Error(`fakeExec: no handler registered for subcommand "${subcommand}"`);
    return handler(args, counts[subcommand]);
  }
  exec.calls = calls;
  exec.counts = counts;
  return exec;
}

function jsonStdout(value) {
  return { stdout: JSON.stringify({ result: value }), stderr: "" };
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

test("computePromptHash is a deterministic sha256 of the prompt", () => {
  const prompt = "review pack T2";
  assert.equal(computePromptHash(prompt), sha256(prompt));
  assert.equal(computePromptHash(prompt), computePromptHash(prompt));
});

test("computePromptHash rejects an empty prompt", () => {
  assert.throws(() => computePromptHash(""), /non-empty/);
});

test("readBaselineFromSnapshot reads assistant_count and last_assistant_hash for an existing conversation", async () => {
  const fixture = await loadFixture("six_answers_snapshot.json");
  // Baseline snapshot as it existed *before* the 6th prompt was sent: only
  // the first 5 assistant answers exist yet.
  const preSendSnapshot = { assistantMessages: fixture.assistantMessages.slice(0, 5) };
  const baseline = readBaselineFromSnapshot(preSendSnapshot);
  assert.equal(baseline.assistant_count, 5);
  assert.equal(baseline.last_assistant_hash, sha256(fixture.assistantMessages[4]));
  // The 5th answer's hash must differ from the 6th's - this is the guard
  // rail that keeps the Sender's baseline and the Watcher's candidate index
  // from ever being confused with each other.
  assert.notEqual(baseline.last_assistant_hash, sha256(fixture.assistantMessages[5]));
});

test("readBaselineFromSnapshot handles a brand-new conversation (zero assistant messages)", () => {
  const baseline = readBaselineFromSnapshot({ assistantMessages: [] });
  assert.equal(baseline.assistant_count, 0);
  assert.equal(baseline.last_assistant_hash, sha256(""));
});

test("generateJobId returns unique v4-style ids", () => {
  const a = generateJobId();
  const b = generateJobId();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f-]{36}$/i);
});

test("buildJob produces a schema-valid immutable job payload", () => {
  const job = buildJob({
    prompt: "review pack T2",
    attempt: 1,
    conversationUrl: "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949",
    sentAt: "2026-08-01T09:00:00+08:00",
    baseline: { assistant_count: 5, last_assistant_hash: sha256("Answer 5") },
  });
  assert.equal(job.prompt_hash, sha256("review pack T2"));
  assert.equal(job.baseline.assistant_count, 5);
  assert.match(job.job_id, /^[0-9a-f-]{36}$/i);
});

test("buildJob rejects a non-ChatGPT conversation URL (reuses contracts.mjs validation)", () => {
  assert.throws(() =>
    buildJob({
      prompt: "x",
      attempt: 1,
      conversationUrl: "https://example.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949",
      sentAt: "2026-08-01T09:00:00+08:00",
      baseline: { assistant_count: 0, last_assistant_hash: sha256("") },
    })
  );
});

// ---------------------------------------------------------------------------
// job.json immutability + path confinement
// ---------------------------------------------------------------------------

test("resolveJobDir confines output under <runtimeRoot>/jobs/<job_id>", () => {
  const dir = resolveJobDir("D:\\AIWORK_RUNTIME\\GPT_BROWSER_BRIDGE", "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(dir, path.resolve("D:\\AIWORK_RUNTIME\\GPT_BROWSER_BRIDGE", "jobs", "550e8400-e29b-41d4-a716-446655440000"));
});

test("resolveJobDir rejects path traversal and unsafe job ids", () => {
  assert.throws(() => resolveJobDir("D:\\RUNTIME", "../escape"));
  assert.throws(() => resolveJobDir("D:\\RUNTIME", "a/b"));
  assert.throws(() => resolveJobDir("D:\\RUNTIME", "a\\b"));
  assert.throws(() => resolveJobDir("D:\\RUNTIME", ""));
});

test("writeJobFile writes job.json and refuses to overwrite an existing immutable job", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb003-baseline-"));
  const job = buildJob({
    prompt: "review pack T2",
    attempt: 1,
    conversationUrl: "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949",
    sentAt: "2026-08-01T09:00:00+08:00",
    baseline: { assistant_count: 5, last_assistant_hash: sha256("Answer 5") },
  });
  const jobDir = resolveJobDir(runtimeRoot, job.job_id);

  const jobPath = await writeJobFile(jobDir, job, { existsCheck: async () => false });
  const written = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(written.job_id, job.job_id);

  await assert.rejects(
    () => writeJobFile(jobDir, job, { existsCheck: async () => true }),
    /refusing to overwrite/
  );
});

// ---------------------------------------------------------------------------
// Gate A/B-style CLI wrapper (fake exec, no live browser)
// ---------------------------------------------------------------------------

test("locateChatgptTab selects the single matching conversation tab", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
  });
  const match = await locateChatgptTab("https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949", {
    session: "gbb-send-test",
    exec,
  });
  assert.equal(match.index, 0);
  assert.equal(exec.counts["tab-select"], 1);
});

test("locateChatgptTab fails closed on zero matches", async () => {
  const tabs = await loadFixture("tab_list_no_match.json");
  const exec = fakeExecFactory({ "tab-list": () => jsonStdout(tabs) });
  await assert.rejects(
    () => locateChatgptTab("https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949", { session: "s", exec }),
    (err) => err instanceof SendInvalidationError && err.code === "TAB_NOT_FOUND"
  );
});

test("locateChatgptTab fails closed on multiple matches (never guesses)", async () => {
  const tabs = await loadFixture("tab_list_multi_match.json");
  const exec = fakeExecFactory({ "tab-list": () => jsonStdout(tabs) });
  await assert.rejects(
    () => locateChatgptTab("https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949", { session: "s", exec }),
    (err) => err instanceof SendInvalidationError && err.code === "TAB_AMBIGUOUS"
  );
});

test("waitConversationUrl polls until the conversation URL appears", async () => {
  const urls = ["https://chatgpt.com/", "https://chatgpt.com/", "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949"];
  let i = 0;
  const exec = fakeExecFactory({
    eval: () => jsonStdout({ url: urls[Math.min(i++, urls.length - 1)] }),
  });
  const sleeps = [];
  const url = await waitConversationUrl({
    session: "s",
    exec,
    sleep: async (ms) => sleeps.push(ms),
    now: () => 0,
  });
  assert.equal(url, "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949");
  assert.equal(sleeps.length, 2);
});

test("waitConversationUrl times out rather than waiting forever", async () => {
  const exec = fakeExecFactory({ eval: () => jsonStdout({ url: "https://chatgpt.com/" }) });
  let t = 0;
  await assert.rejects(
    () =>
      waitConversationUrl({
        session: "s",
        exec,
        timeoutMs: 5_000,
        pollIntervalMs: 1_000,
        sleep: async () => {
          t += 1_000;
        },
        now: () => t,
      }),
    (err) => err instanceof SendInvalidationError && err.code === "WAIT_CONVERSATION_URL_TIMEOUT"
  );
});

// ---------------------------------------------------------------------------
// Full Sender flow: send once, write job.json, stop (never watches).
// ---------------------------------------------------------------------------

test("sendJob reads baseline, sends, waits for URL, writes job.json, and never reads assistant replies afterwards", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const conversationUrl = "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949";
  const fixture = await loadFixture("six_answers_snapshot.json");
  const preSend = { url: conversationUrl, assistantMessages: fixture.assistantMessages.slice(0, 5) };

  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
    eval: (args, callIndex) => (callIndex === 1 ? jsonStdout(preSend) : jsonStdout({ url: conversationUrl })),
    fill: () => jsonStdout(null),
    press: () => jsonStdout(null),
  });

  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb003-sendjob-"));
  const { job, jobPath } = await sendJob({
    prompt: "review pack T2",
    attempt: 1,
    conversationUrl,
    runtimeRoot,
    session: "gbb-send-test",
    exec,
    sleep: async () => {},
    now: () => Date.parse("2026-08-01T09:00:00+08:00"),
    existsCheck: async () => false,
  });

  assert.equal(job.baseline.assistant_count, 5);
  assert.equal(job.conversation_url, conversationUrl);
  const written = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(written.job_id, job.job_id);

  // Only Sender-legal subcommands were used, and no polling loop for
  // assistant replies happened (that is exclusively the Watcher's job).
  assert.deepEqual(Object.keys(exec.counts).sort(), ["eval", "fill", "press", "tab-list", "tab-select"]);
  assert.equal(exec.counts.fill, 1);
  assert.equal(exec.counts.press, 1);
});
