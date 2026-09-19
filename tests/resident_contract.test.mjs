import test from "node:test";
import assert from "node:assert/strict";
import { buildResidentIdentity, buildTaskDefinition, nextRestartAction } from "../src/resident_contract.mjs";

test("identity is deterministic for one process", () => {
  assert.deepEqual(buildResidentIdentity({ host: "HOST", pid: 42, startedAt: "2026-09-19T00:00:00.000Z" }), {
    consumer_id: "g13-HOST-42",
    host: "HOST",
    pid: 42,
    started_at: "2026-09-19T00:00:00.000Z"
  });
});

test("task definition rejects relative paths", () => {
  assert.throws(() => buildTaskDefinition({ scriptPath: "run.ps1", runtimeRoot: "D:/runtime", taskName: "G13", user: "Lupun" }), /absolute/i);
});

test("restart is bounded and then fail-closed", () => {
  assert.deepEqual(nextRestartAction({ exitCode: 1, restartCount: 0, maxRestarts: 3 }), { action: "RESTART", delayMs: 10000 });
  assert.deepEqual(nextRestartAction({ exitCode: 1, restartCount: 3, maxRestarts: 3 }), { action: "BLOCKED", reason: "RESTART_CAP_EXCEEDED" });
});
