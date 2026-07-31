// GPT_BROWSER_BRIDGE - Browser Action Runner / Sender (GBB-003)
// Spec: plans/GBB_PARENT_WORK_ORDER.md §14, skills/browser-sender/SKILL.md.
//
// Browser writes only: fill + send (and, with explicit Control Tower
// approval elsewhere, Continue / re-open). Never watches the answer after
// sending, never judges pass/rework, never re-sends the same attempt. This
// file is kept independent from gpt_watch.mjs (no shared CLI runner) so the
// Watcher's read-only source never pulls in write-capable code.

import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { isChatgptConversationUrl, jobSchema, SCHEMA_VERSION } from "./contracts.mjs";
import { sha256Hex } from "./result_store.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Gate A: whitelist of Playwright CLI subcommands the Sender may invoke.
// fill/press are legitimate here (the Sender is the write role); tab-close,
// tab-new, run-code and show are still never used.
export const ALLOWED_CLI_SUBCOMMANDS = Object.freeze(["tab-list", "tab-select", "eval", "fill", "press"]);

// Fixed read-only eval used to take the pre-send baseline (assistant count +
// last assistant message) and, after sending, to poll for the new
// conversation URL. Read-only by construction; the Sender's only *write*
// happens through the dedicated fill/press CLI subcommands below.
export const BASELINE_SNAPSHOT_SCRIPT = `() => {
  const turns = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  return {
    url: location.href,
    assistantMessages: turns.map((t) => t.innerText || ''),
  };
}`;

export const PROMPT_TEXTAREA_SELECTOR = '#prompt-textarea';
export const SEND_BUTTON_SELECTOR = '[data-testid="send-button"]';

export const DEFAULT_CLI_PATH =
  process.env.GBB_PLAYWRIGHT_CLI_PATH ||
  "C:\\Users\\Lupun\\AppData\\Roaming\\npm\\node_modules\\@playwright\\cli\\node_modules\\.bin\\playwright.cmd";

export const DEFAULT_WAIT_URL_TIMEOUT_MS = 30_000;
export const DEFAULT_WAIT_URL_POLL_MS = 1_000;

// ---------------------------------------------------------------------------
// Pure logic (fully unit-testable without a browser).
// ---------------------------------------------------------------------------

export function computePromptHash(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("computePromptHash: prompt must be a non-empty string");
  }
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

// Baseline is read *before* sending: assistant message count + hash of the
// last existing assistant message (sha256("") for a brand-new conversation).
export function readBaselineFromSnapshot(snapshot) {
  const assistantMessages = Array.isArray(snapshot?.assistantMessages) ? snapshot.assistantMessages : [];
  const assistantCount = assistantMessages.length;
  const lastText = assistantCount > 0 ? assistantMessages[assistantCount - 1] : "";
  return {
    assistant_count: assistantCount,
    last_assistant_hash: sha256Hex(lastText),
  };
}

export function generateJobId() {
  return randomUUID();
}

// Builds and schema-validates the immutable job.json payload. Throws (via
// Zod) rather than writing a malformed job.
export function buildJob({ prompt, attempt, conversationUrl, sentAt, baseline, jobId = generateJobId() }) {
  return jobSchema.parse({
    schema_version: SCHEMA_VERSION,
    job_id: jobId,
    prompt,
    prompt_hash: computePromptHash(prompt),
    attempt,
    conversation_url: conversationUrl,
    sent_at: sentAt,
    baseline,
  });
}

// ---------------------------------------------------------------------------
// job.json durable write (immutable: refuses to overwrite an existing file).
// ---------------------------------------------------------------------------

export function resolveJobDir(runtimeRoot, jobId) {
  if (typeof jobId !== "string" || jobId.length === 0 || /[\\/]/.test(jobId) || jobId.includes("..")) {
    throw new Error(`resolveJobDir: unsafe job_id ${JSON.stringify(jobId)}`);
  }
  const root = path.resolve(runtimeRoot);
  const dir = path.resolve(root, "jobs", jobId);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error(`resolveJobDir: resolved path escapes runtime root: ${dir}`);
  }
  return dir;
}

export async function writeJobFile(jobDir, job, { existsCheck } = {}) {
  await mkdir(jobDir, { recursive: true });
  const jobPath = path.join(jobDir, "job.json");
  if (typeof existsCheck === "function" && (await existsCheck(jobPath))) {
    throw new Error(`writeJobFile: refusing to overwrite immutable job.json at ${jobPath}`);
  }
  await writeFileAtomic(jobPath, JSON.stringify(job, null, 2) + "\n");
  return jobPath;
}

// ---------------------------------------------------------------------------
// Gate A: single controlled entry point to the Playwright CLI.
// ---------------------------------------------------------------------------

export class SendInvalidationError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "SendInvalidationError";
    this.code = code;
  }
}

function defaultExec(cliPath, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(cliPath, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
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
    throw new Error(`gpt_send: "${subcommand}" is not in the allowed CLI whitelist`);
  }
}

export function unwrapCliResult(parsed) {
  if (parsed && typeof parsed === "object" && "result" in parsed) {
    let r = parsed.result;
    if (typeof r === "string") {
      try {
        r = JSON.parse(r);
      } catch {
        // leave as string
      }
    }
    return r;
  }
  return parsed;
}

export async function runCliCommand(subcommand, rest, opts = {}) {
  const { session, exec = defaultExec, cliPath = DEFAULT_CLI_PATH, timeoutMs = 15_000 } = opts;
  if (!session) throw new Error("gpt_send: runCliCommand requires a session name");
  assertAllowedSubcommand(subcommand);

  const args = ["cli", `-s=${session}`, subcommand, ...rest, "--json"];
  let stdout;
  try {
    ({ stdout } = await exec(cliPath, args, { timeoutMs }));
  } catch (e) {
    throw new SendInvalidationError(`CLI_EXEC_FAILED:${subcommand}`, { cause: e });
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new SendInvalidationError(`CLI_INVALID_JSON:${subcommand}`, { cause: e });
  }
  return unwrapCliResult(parsed);
}

// ---------------------------------------------------------------------------
// Gate B/C-style locate: find the single ChatGPT tab to operate on.
// - If `conversationUrl` is given (resuming an existing conversation for a
//   new attempt), require exactly one tab whose conversation id matches.
// - Otherwise (brand new conversation), require exactly one tab whose origin
//   is chatgpt.com. Zero or multiple matches fail closed.
// ---------------------------------------------------------------------------

function extractConversationId(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const m = parsed.pathname.match(/^\/c\/([0-9a-f-]+)$/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function isChatgptOrigin(url) {
  try {
    return new URL(url).hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

export async function locateChatgptTab(conversationUrl, opts) {
  const tabs = await runCliCommand("tab-list", [], opts);
  const list = Array.isArray(tabs) ? tabs : Array.isArray(tabs?.tabs) ? tabs.tabs : [];

  const matches = conversationUrl
    ? list.filter((t) => extractConversationId(t?.url) === extractConversationId(conversationUrl))
    : list.filter((t) => isChatgptOrigin(t?.url));

  if (matches.length !== 1) {
    throw new SendInvalidationError(matches.length === 0 ? "TAB_NOT_FOUND" : "TAB_AMBIGUOUS");
  }
  const [match] = matches;
  const index = match.index ?? match.tabIndex ?? match.id;
  if (index === undefined || index === null) {
    throw new SendInvalidationError("TAB_INDEX_MISSING");
  }
  await runCliCommand("tab-select", [String(index)], opts);
  return match;
}

// ---------------------------------------------------------------------------
// Sender flow
// ---------------------------------------------------------------------------

export async function readBaseline(conversationUrl, opts) {
  await locateChatgptTab(conversationUrl, opts);
  const snapshot = await runCliCommand("eval", [BASELINE_SNAPSHOT_SCRIPT], opts);
  return readBaselineFromSnapshot(snapshot);
}

export async function sendPrompt(prompt, opts) {
  await runCliCommand("fill", [PROMPT_TEXTAREA_SELECTOR, prompt], opts);
  await runCliCommand("press", [SEND_BUTTON_SELECTOR], opts);
}

export async function waitConversationUrl(opts = {}) {
  const {
    timeoutMs = DEFAULT_WAIT_URL_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_WAIT_URL_POLL_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = opts;
  const deadline = now() + timeoutMs;
  for (;;) {
    const snapshot = await runCliCommand("eval", [BASELINE_SNAPSHOT_SCRIPT], opts);
    if (isChatgptConversationUrl(snapshot?.url)) {
      return snapshot.url;
    }
    if (now() >= deadline) {
      throw new SendInvalidationError("WAIT_CONVERSATION_URL_TIMEOUT");
    }
    await sleep(pollIntervalMs);
  }
}

// Orchestrates the full "send" job per §14 Sender 必做: read baseline, hash
// prompt, send, wait for the conversation URL, write immutable job.json, and
// stop. Never monitors the answer afterwards (that is the Watcher's job).
export async function sendJob({
  prompt,
  attempt,
  conversationUrl,
  runtimeRoot,
  now = () => Date.now(),
  existsCheck,
  ...cliOpts
}) {
  const baseline = await readBaseline(conversationUrl, cliOpts);
  await sendPrompt(prompt, cliOpts);
  const finalUrl = await waitConversationUrl({ ...cliOpts, now });

  const job = buildJob({
    prompt,
    attempt,
    conversationUrl: finalUrl,
    sentAt: new Date(now()).toISOString(),
    baseline,
  });

  const jobDir = resolveJobDir(runtimeRoot, job.job_id);
  const jobPath = await writeJobFile(jobDir, job, { existsCheck });
  return { job, jobPath };
}
