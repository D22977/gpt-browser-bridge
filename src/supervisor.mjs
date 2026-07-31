// GPT_BROWSER_BRIDGE - Supervisor minimal skeleton (GBB-004 will extend).
// Deterministic Node process, NO model. Responsibilities (skeleton):
//   - heartbeat every 15s
//   - read project_state.json
//   - check ORCA status
//   - write morning_summary.md
// It does NOT decide pass/rework, does NOT resend, does NOT press Continue.

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const RUNTIME = process.env.GBB_RUNTIME || "D:\\AIWORK_RUNTIME\\GPT_BROWSER_BRIDGE";
const STATE_FILE = path.join(RUNTIME, "state", "project_state.json");
const HEARTBEAT_FILE = path.join(RUNTIME, "state", "heartbeat.json");
const SUMMARY_FILE = path.join(RUNTIME, "state", "morning_summary.md");
const LOCK_FILE = path.join(RUNTIME, "locks", "supervisor.lock");
const EVENTS_FILE = path.join(RUNTIME, "events", "events.ndjson");

const HEARTBEAT_INTERVAL_MS = 15_000;
const ORCA = process.env.GBB_ORCA || "C:\\Users\\Lupun\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe";

function now() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}+08:00`;
}

async function appendEvent(evt) {
  try {
    await writeFile(EVENTS_FILE, JSON.stringify({ at: now(), ...evt }) + "\n", { flag: "a" });
  } catch (e) {
    console.error("appendEvent failed:", e.message);
  }
}

async function acquireLock() {
  try {
    const cur = JSON.parse(await readFile(LOCK_FILE, "utf8"));
    if (cur.pid !== process.pid) {
      const alive = await isAlive(cur.pid);
      if (alive) return false;
    }
  } catch {}
  await writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, at: now() }, null, 2));
  return true;
}

async function isAlive(pid) {
  try {
    await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`]);
    return true;
  } catch {
    return false;
  }
}

async function orcaStatus() {
  try {
    const { stdout } = await execFileAsync(ORCA, ["status", "--json"], { timeout: 10_000 });
    const parsed = JSON.parse(stdout);
    return { ok: Boolean(parsed.ok), state: parsed.result?.runtime?.state ?? "unknown" };
  } catch (e) {
    return { ok: false, state: "unreachable", error: e.message };
  }
}

async function writeHeartbeat(state) {
  await writeFile(HEARTBEAT_FILE, JSON.stringify({ at: now(), pid: process.pid, state: state?.state ?? "UNKNOWN" }, null, 2));
}

async function writeMorningSummary(state, orca) {
  const md = [
    "# GPT Browser Bridge Morning Summary",
    "",
    `- generated_at: ${now()}`,
    `- project_state: ${state?.state ?? "UNKNOWN"}`,
    `- current_task: ${state?.current_task ?? "UNKNOWN"}`,
    `- current_attempt: ${state?.attempt ?? "UNKNOWN"}`,
    `- last_successful_checkpoint: ${state?.last_successful_step ?? "none"}`,
    `- active_processes: supervisor(pid=${process.pid})`,
    `- latest_commit: ${state?.base_commit ?? "none"}`,
    `- tests: n/a (skeleton)`,
    `- reviewer_status: n/a (skeleton)`,
    `- browser_status: n/a (skeleton)`,
    `- ORCA_status: ${orca?.state ?? "unknown"} (${orca?.ok ? "ok" : "unreachable"})`,
    "",
    "## Blockers",
    state?.blocked_reason ? `- ${state.blocked_reason}` : "- none",
    "",
    "## Human actions required",
    state?.state === "NEEDS_HUMAN" ? "- yes (see blocked_reason)" : "- none",
    "",
    "## Exact resume command",
    "`pwsh scripts\\resume.ps1` (or `pwsh D:\\AIWORK\\GPT_BROWSER_BRIDGE\\scripts\\resume.ps1`)",
    "",
  ].join("\n");
  await writeFile(SUMMARY_FILE, md);
}

async function loop() {
  let state = null;
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (e) {
    state = { state: "UNKNOWN", current_task: "UNKNOWN", attempt: 0, blocked_reason: "project_state.json unreadable" };
  }
  await writeHeartbeat(state);
  const orca = await orcaStatus();
  await writeMorningSummary(state, orca);
  const terminalState = state.state ?? "UNKNOWN";
  console.log(`[${now()}] heartbeat state=${terminalState} task=${state.current_task ?? "UNKNOWN"} orca=${orca.state}`);
}

const locked = await acquireLock();
if (!locked) {
  console.error(`[${now()}] supervisor.lock held by another process. Exiting.`);
  process.exit(0);
}
console.log(`[${now()}] GBB supervisor skeleton started (pid=${process.pid})`);

await loop();
setInterval(loop, HEARTBEAT_INTERVAL_MS);
