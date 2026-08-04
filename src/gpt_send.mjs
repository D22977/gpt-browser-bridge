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
import { mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { isChatgptConversationUrl, jobSchema, SCHEMA_VERSION } from "./contracts.mjs";
import { sha256Hex } from "./result_store.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Gate A: whitelist of Playwright CLI subcommands the Sender may invoke.
// fill/click/press/upload are legitimate here (the Sender is the write
// role); tab-close, tab-new, run-code and show are still never used. `click`
// is the actual send-button trigger (see sendPrompt below); `press` is kept
// whitelisted for key-based input (e.g. Enter into a focused editor) even
// though the current sendPrompt() does not use it. `upload` attaches
// pre-validated local file paths (see validateAttachments) for an approved
// web-chat file-upload send, and is always invoked before `fill`.
export const ALLOWED_CLI_SUBCOMMANDS = Object.freeze(["tab-list", "tab-select", "eval", "fill", "click", "press", "upload"]);

// Fixed read-only eval used to take the pre-send baseline (assistant count +
// last assistant message + page visibility) and, after sending, to poll for
// the new conversation URL. Read-only by construction; the Sender's only
// *write* happens through the dedicated fill/click CLI subcommands below.
export const BASELINE_SNAPSHOT_SCRIPT = `() => {
  const turns = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  return {
    url: location.href,
    assistantMessages: turns.map((t) => t.innerText || ''),
    visibilityState: document.visibilityState,
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

// Live-capture finding (2026-08-01 canary): recent Node refuses to spawn a
// `.cmd` shim directly without `shell: true` (EINVAL - see Node's April 2024
// batch-file CVE fix), and `shell: true` would require re-implementing
// cmd.exe's argument-escaping ourselves for every CLI arg (including the
// user-supplied prompt text) to stay injection-safe. Instead, resolve npm's
// `.cmd` shim to the real node entry point it wraps (`..\playwright\cli.js`,
// exactly what the shim itself invokes - see its `%dp0%\..\playwright\cli.js`
// line) and spawn that directly via `node`: a plain executable + argv array,
// no shell, no escaping needed. Non-`.cmd` paths (already a `.js`/real exe)
// are spawned unchanged.
export function resolveSpawnTarget(cliPath) {
  if (!/\.cmd$/i.test(cliPath)) {
    return { command: cliPath, prefixArgs: [] };
  }
  const entry = path.join(path.dirname(cliPath), "..", "playwright", "cli.js");
  if (!existsSync(entry)) {
    throw new Error(`gpt_send: cannot resolve the .cmd shim at ${cliPath} to a node entry point (expected ${entry})`);
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
  // Live-capture finding (fixtures/chatgpt/live_cli_error.json): the real CLI
  // exits 0 and reports failures as `{isError: true, error: "..."}` on
  // stdout rather than a non-zero exit / exec rejection. Must be checked
  // explicitly - otherwise a real error silently falls through as "valid"
  // JSON with no result/url/array shape.
  if (parsed && typeof parsed === "object" && parsed.isError === true) {
    throw new SendInvalidationError(`CLI_ERROR_RESPONSE:${subcommand}`, {
      cause: new Error(typeof parsed.error === "string" ? parsed.error : "unknown CLI error"),
    });
  }
  return unwrapCliResult(parsed);
}

// Live-capture finding (fixtures/chatgpt/live_tab_list_*.json): `tab-list
// --json` does NOT return a JSON array of tab objects. It returns a markdown
// bullet-list STRING under `result`: `- <index>: [(current) ]?[title](url)`.
// See gpt_watch.mjs's parseTabList for the full rationale (duplicated here,
// not imported, so the two files keep no shared CLI runner per Gate F).
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
  const list = parseTabList(tabs);

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

// Fail-closed guard: a hidden tab (document.visibilityState !== "visible")
// cannot reliably receive a click - the real CLI's rAF-based actionability
// check hangs against a background tab and Enter does not submit either.
// Rather than hang or silently no-op, refuse the send outright by default.
//
// `allowBackgroundTab` (default false) is an explicit, per-call authorization
// for approved web-chat channels (e.g. ChatGPT) where Control Tower has
// accepted the background-tab risk for a review/question send. It does not
// authorize CLI/local-model sends, and every other gate (unique target tab,
// domain matching, send action, conversation URL wait, immutable job
// evidence) still applies unchanged.
export function assertPageVisible(snapshot, { allowBackgroundTab = false } = {}) {
  if (allowBackgroundTab) return;
  if (snapshot?.visibilityState && snapshot.visibilityState !== "visible") {
    throw new SendInvalidationError("PAGE_HIDDEN");
  }
}

export async function readBaseline(conversationUrl, opts) {
  await locateChatgptTab(conversationUrl, opts);
  const snapshot = await runCliCommand("eval", [BASELINE_SNAPSHOT_SCRIPT], opts);
  assertPageVisible(snapshot, { allowBackgroundTab: opts?.allowBackgroundTab });
  return readBaselineFromSnapshot(snapshot);
}

// Validates that every attachment path is an explicit, existing regular
// file before any browser mutation happens. Fails closed with a structured
// SendInvalidationError on a missing path or a non-file (directory, socket,
// etc.) - never reads or logs file contents, only stats the path. A
// nullish/empty `attachments` is a no-op (the caller skips the upload step).
export async function validateAttachments(attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) {
    throw new SendInvalidationError("ATTACHMENT_INVALID_PATH");
  }
  for (const attachmentPath of attachments) {
    if (typeof attachmentPath !== "string" || attachmentPath.length === 0) {
      throw new SendInvalidationError("ATTACHMENT_INVALID_PATH");
    }
    let stats;
    try {
      stats = await stat(attachmentPath);
    } catch (e) {
      throw new SendInvalidationError("ATTACHMENT_NOT_FOUND", { cause: e });
    }
    if (!stats.isFile()) {
      throw new SendInvalidationError("ATTACHMENT_NOT_A_FILE");
    }
  }
  return attachments;
}

// Sends the prompt: upload any attachments (approved web-chat file-upload
// review, per-call opt-in via sendJob's `attachments`), fill the editor,
// then click the send button. Attachments are pre-validated by
// validateAttachments before this runs, so this is a direct CLI call with no
// further path checks or file reads. (Not `press SEND_BUTTON_SELECTOR` -
// `press` takes a key name like "Enter", not a CSS selector; clicking is the
// correct way to activate the send button.)
export async function sendPrompt(prompt, opts) {
  const { attachments, ...cliOpts } = opts || {};
  if (Array.isArray(attachments) && attachments.length > 0) {
    await runCliCommand("upload", attachments, cliOpts);
  }
  await runCliCommand("fill", [PROMPT_TEXTAREA_SELECTOR, prompt], cliOpts);
  await runCliCommand("click", [SEND_BUTTON_SELECTOR], cliOpts);
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
// prompt, send (optionally uploading attachments first, for the approved
// web-chat file-upload review path), wait for the conversation URL, write
// immutable job.json, and stop. Never monitors the answer afterwards (that
// is the Watcher's job). Attachments are validated before any browser
// mutation - an invalid attachment path fails the whole job closed, before
// the baseline is even read.
export async function sendJob({
  prompt,
  attempt,
  conversationUrl,
  runtimeRoot,
  attachments,
  now = () => Date.now(),
  existsCheck,
  ...cliOpts
}) {
  const validAttachments = await validateAttachments(attachments);
  const baseline = await readBaseline(conversationUrl, cliOpts);
  await sendPrompt(prompt, { attachments: validAttachments, ...cliOpts });
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
