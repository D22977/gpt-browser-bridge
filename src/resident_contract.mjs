import path from "node:path";

function required(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") throw new Error(`${name} is required`);
  return String(value);
}

export function buildResidentIdentity({ host, pid, startedAt }) {
  const safeHost = required(host, "host");
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");
  return { consumer_id: `g13-${safeHost}-${pid}`, host: safeHost, pid, started_at: required(startedAt, "startedAt") };
}

export function buildTaskDefinition({ scriptPath, runtimeRoot, taskName, user }) {
  const script = required(scriptPath, "scriptPath");
  const root = required(runtimeRoot, "runtimeRoot");
  if (!path.isAbsolute(script) || !path.isAbsolute(root)) throw new Error("scriptPath and runtimeRoot must be absolute");
  return { task_name: required(taskName, "taskName"), user: required(user, "user"), action: { executable: "pwsh.exe", arguments: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] }, runtime_root: root, multiple_instances: "IgnoreNew", wake_to_run: true };
}

export function nextRestartAction({ exitCode, restartCount, maxRestarts = 3 }) {
  if (exitCode === 0) return { action: "STOP", reason: "CLEAN_EXIT" };
  if (!Number.isInteger(restartCount) || restartCount < 0 || restartCount >= maxRestarts) return { action: "BLOCKED", reason: "RESTART_CAP_EXCEEDED" };
  return { action: "RESTART", delayMs: 10000 };
}
