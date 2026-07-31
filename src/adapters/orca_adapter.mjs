// GPT_BROWSER_BRIDGE - ORCA adapter (GBB-004)
// Spec: plans/GBB_PARENT_WORK_ORDER.md §15, docs/ORCA_RUNBOOK.md.
//
// Thin wrapper around the public `orca` CLI's `terminal ...` / `status`
// subcommands (verified against the real CLI on this machine 2026-08-01).
// Orca orchestration exists for Control Tower lifecycle/dispatch, while the
// deterministic Supervisor deliberately uses only terminal list/create/read/
// send/wait/stop and status. All process
// invocation goes through an injectable `exec` function so tests never
// shell out to the real binary or touch a live ORCA session/terminal.
//
// Real JSON envelope (observed): `{"id": "...", "ok": true|false,
// "result": {...}}`. `ok: false` or a rejected exec both surface as
// OrcaAdapterError so callers have one failure shape to branch on.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Resolve the orca executable. Prefer $ORCA_CLI_COMMAND when set (Orca
// exports it for managed sessions); otherwise fall back to the public CLI
// binary discovered on this machine (docs/ARCHITECTURE.md §5). Never guess
// beyond that; callers see a clear failure if the binary is missing.
export function resolveOrcaCli(env = process.env) {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  return "C:\\Users\\Lupun\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe";
}

export class OrcaAdapterError extends Error {
  constructor(code, message, options) {
    super(message ?? code, options);
    this.name = "OrcaAdapterError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Terminal naming (§15 "Terminal 命名"). Handles are never a permanent ID -
// after any ORCA restart, terminals must be re-found by title / run id.
// ---------------------------------------------------------------------------

export const TERMINAL_ROLES = Object.freeze(["control", "worker", "reviewer", "watcher"]);

export function buildTerminalTitle(task, attempt, role) {
  if (!task || !Number.isInteger(attempt) || attempt < 1 || !TERMINAL_ROLES.includes(role)) {
    throw new Error(`buildTerminalTitle: invalid arguments (task=${task}, attempt=${attempt}, role=${role})`);
  }
  return `GBB-${task}-A${attempt}-${role}`;
}

const TITLE_RE = /^GBB-(.+)-A(\d+)-(control|worker|reviewer|watcher)$/;

export function parseTerminalTitle(title) {
  if (typeof title !== "string") return null;
  const m = TITLE_RE.exec(title);
  if (!m) return null;
  return { task: m[1], attempt: Number(m[2]), role: m[3] };
}

// Finds the terminal matching a project-state `active_terminal` ref. Tries
// the handle first (cheap, common case: nothing crashed); falls back to an
// exact title match (post ORCA-restart case, §15 step 7). Never trusts a
// stale handle silently - the caller is told which method matched.
export function resolveActiveTerminal(terminals, ref) {
  if (!Array.isArray(terminals) || !ref) return { found: false, terminal: null, method: "none" };
  const byHandle = terminals.find((t) => t.handle === ref.handle);
  if (byHandle) return { found: true, terminal: byHandle, method: "handle" };
  const byTitle = terminals.find((t) => t.title === ref.title);
  if (byTitle) return { found: true, terminal: byTitle, method: "title" };
  return { found: false, terminal: null, method: "none" };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function defaultExec(orcaPath, args, { timeoutMs } = {}) {
  return execFileAsync(orcaPath, args, { timeout: timeoutMs ?? 15_000, windowsHide: true }).then(
    ({ stdout }) => stdout,
    (err) => {
      throw new OrcaAdapterError("EXEC_FAILED", `orca ${args.join(" ")} failed: ${err.message}`, { cause: err });
    }
  );
}

export class OrcaAdapter {
  constructor({ orcaPath = resolveOrcaCli(), runId, runtimeRoot, exec = defaultExec } = {}) {
    this.orcaPath = orcaPath;
    this.runId = runId;
    this.runtimeRoot = runtimeRoot;
    this._exec = exec;
  }

  // Every call goes through here: builds argv, always requests --json,
  // parses the envelope, and normalizes `ok:false` into a thrown error so
  // every public method below can just `return (await this._run(...)).result`.
  async _run(args, opts = {}) {
    let stdout;
    try {
      stdout = await this._exec(this.orcaPath, [...args, "--json"], opts);
    } catch (e) {
      if (e instanceof OrcaAdapterError) throw e;
      throw new OrcaAdapterError("EXEC_FAILED", `orca ${args.join(" ")} failed: ${e.message}`, { cause: e });
    }
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      throw new OrcaAdapterError("INVALID_JSON", `orca ${args.join(" ")} returned non-JSON output`, { cause: e });
    }
    if (!parsed || parsed.ok !== true) {
      throw new OrcaAdapterError(
        "CLI_ERROR",
        `orca ${args.join(" ")} reported failure: ${parsed?.error ?? "unknown error"}`
      );
    }
    return parsed.result;
  }

  // §15 step 5: is ORCA itself reachable and ready?
  async status(opts = {}) {
    try {
      const result = await this._run(["status"], opts);
      return {
        ok: Boolean(result?.runtime?.reachable) && result?.runtime?.state === "ready",
        state: result?.runtime?.state ?? "unknown",
        raw: result,
      };
    } catch (e) {
      return { ok: false, state: "unreachable", error: e.message, raw: null };
    }
  }

  // §15 step 7: re-list terminals (never cache across an ORCA restart).
  async listTerminals({ worktree, limit, ...opts } = {}) {
    const args = ["terminal", "list"];
    if (worktree) args.push("--worktree", worktree);
    if (limit) args.push("--limit", String(limit));
    const result = await this._run(args, opts);
    return Array.isArray(result?.terminals) ? result.terminals : [];
  }

  // §15 step 8: rebuild a role's terminal from checkpoint. `title` must
  // follow buildTerminalTitle() so future recovery can find it again.
  async createTerminal({ worktree, title, command, focus = false, ...opts } = {}) {
    if (!title) throw new Error("OrcaAdapter.createTerminal: title is required (GBB-<TASK>-A<ATTEMPT>-<role>)");
    const args = ["terminal", "create"];
    if (worktree) args.push("--worktree", worktree);
    args.push("--title", title);
    if (command) args.push("--command", command);
    if (focus) args.push("--focus");
    return this._run(args, opts);
  }

  async readTerminal({ handle, cursor, limit, ...opts } = {}) {
    const args = ["terminal", "read"];
    if (handle) args.push("--terminal", handle);
    if (cursor !== undefined && cursor !== null) args.push("--cursor", String(cursor));
    if (limit) args.push("--limit", String(limit));
    const result = await this._run(args, opts);
    return result?.terminal ?? result;
  }

  // §15 step 9: deliver the resume prompt. Never used to resend a ChatGPT
  // prompt or press Continue - callers are restricted by the Supervisor's
  // own policy, not by this adapter.
  async sendTerminal({ handle, text, enter = true, ...opts } = {}) {
    if (!handle) throw new Error("OrcaAdapter.sendTerminal: handle is required");
    const args = ["terminal", "send", "--terminal", handle, "--text", text ?? ""];
    if (enter) args.push("--enter");
    return this._run(args, opts);
  }

  async waitTerminal({ handle, for: forCondition, timeoutMs, ...opts } = {}) {
    if (!forCondition) throw new Error("OrcaAdapter.waitTerminal: `for` is required (exit|tui-idle)");
    const args = ["terminal", "wait"];
    if (handle) args.push("--terminal", handle);
    args.push("--for", forCondition);
    if (timeoutMs) args.push("--timeout-ms", String(timeoutMs));
    return this._run(args, opts);
  }

  async stopTerminals({ worktree, ...opts } = {}) {
    if (!worktree) throw new Error("OrcaAdapter.stopTerminals: worktree is required");
    return this._run(["terminal", "stop", "--worktree", worktree], opts);
  }
}
