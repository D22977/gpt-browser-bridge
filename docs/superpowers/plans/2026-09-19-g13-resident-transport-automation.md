# G13 Resident Transport Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Control Tower-013 restartable and GitHub-addressable through one minimal resident launcher, while giving WebGPT a bounded, reviewable code-contributor contract.

**Architecture:** Reuse the existing `runtime/control-doorbell/watcher.mjs` and its durable state machine. Add only a pure resident contract plus a PowerShell installer that can be applied later at the adoption gate. Keep WebGPT as a bounded branch/card contributor; it never becomes Control, Reviewer, or physical Transport.

**Tech Stack:** Node.js 20 ESM, built-in `node:test`, PowerShell 7, Windows Task Scheduler, existing GitHub comment protocol.

## Global Constraints

- Base commit is exactly `c542d968ac8a2cc984f002d46f16715ba72dd085`.
- Work only in `D:\AIWORK_WT\GPT_BROWSER_BRIDGE\g13-resident-transport-automation-01`.
- Do not mutate `D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\control-doorbell` during implementation.
- Do not register or change a Scheduled Task during implementation; installer code is static until a separate adoption card.
- Do not add npm dependencies.
- Physical/browser sends, workflow dispatches, and runtime adoption remain forbidden in this plan.
- Maximum two implementation lanes; each lane owns disjoint files. They are architecturally parallel but implementation is serialized by the mandatory per-task review gate, so no two agents mutate the worktree at once.
- Every production behavior change follows RED → GREEN → full `npm test`.

---

### Task 1: Resident contract and deferred Windows installer

**Files:**
- Create: `src/resident_contract.mjs`
- Create: `tests/resident_contract.test.mjs`
- Create: `scripts/register-g13-resident-task.ps1`
- Create: `docs/G13_RESIDENT_RUNBOOK.md`

**Interfaces:**
- `buildResidentIdentity({ host, pid, startedAt })` returns `{ consumer_id, host, pid, started_at }`.
- `buildTaskDefinition({ scriptPath, runtimeRoot, taskName, user })` returns a JSON-safe Task Scheduler definition and rejects relative paths.
- `nextRestartAction({ exitCode, restartCount, maxRestarts })` returns `{ action: "RESTART", delayMs }` for bounded restart or `{ action: "BLOCKED", reason }` after the cap.
- The PowerShell installer accepts `-Apply`; without it, it prints the definition and performs no registration.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/resident_contract.test.mjs`

Expected: FAIL because `src/resident_contract.mjs` does not exist.

- [ ] **Step 3: Implement the minimum pure contract**

```js
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
```

- [ ] **Step 4: Run the focused test and full suite**

Run: `node --test tests/resident_contract.test.mjs` and then `npm test`.

Expected: focused tests pass and the full suite reports zero failures.

- [ ] **Step 5: Add the deferred installer and runbook**

The installer must print the definition by default, require `-Apply` before calling `Register-ScheduledTask`, use the exact `runtime/control-doorbell/run.ps1` path, and fail if the path is not absolute. The runbook must state that installation is not runtime adoption; adoption requires a fresh review, Control ACK, and a later physical canary.

- [ ] **Step 6: Commit**

```powershell
git add src/resident_contract.mjs tests/resident_contract.test.mjs scripts/register-g13-resident-task.ps1 docs/G13_RESIDENT_RUNBOOK.md
git commit -m "feat: add bounded G13 resident contract"
```

### Task 2: WebGPT bounded code-contributor contract

**Files:**
- Create: `docs/WEBGPT_CODE_CONTRIBUTOR.md`
- Create: `docs/G13_PARALLEL_LANES.md`

**Interfaces:**
- The prompt template consumes an exact GitHub Issue/card comment ID, base SHA, branch name, file allowlist, test command, and terminal state.
- The contributor may create commits only on its named branch and must stop at `READY_FOR_FRESH_REVIEW`.
- The contributor may not send browser messages, mutate runtime, register tasks, approve itself, or merge/release.

- [ ] **Step 1: Write the contributor prompt document**

The document must include this exact operational prompt skeleton:

```text
You are the bounded WebGPT code contributor for repository D22977/gpt-browser-bridge.
Read only GitHub Issue #162 comment <CARD_COMMENT_ID> and checkout branch <BRANCH> at base <BASE_SHA>.
Modify only: <ALLOWLIST>.
Run exactly: <TEST_COMMAND>.
Do not touch runtime state, Scheduled Tasks, browser UI, credentials, workflow dispatch, merge, release, or review conclusions.
Return a durable report with changed paths, commit SHA, test output summary, and either READY_FOR_FRESH_REVIEW or BLOCKED.
```

- [ ] **Step 2: Document the parallel DAG**

Lane 1 owns resident lifecycle/installer files from Task 1. Lane 2 owns the two contributor-contract documents. Both terminate at fresh formal review; only Control can adopt or unlock a physical wake.

- [ ] **Step 3: Verify documentation-only scope**

Run: `git diff --check` and confirm `git diff --name-only` contains only the two Task 2 documents.

- [ ] **Step 4: Commit**

```powershell
git add docs/WEBGPT_CODE_CONTRIBUTOR.md docs/G13_PARALLEL_LANES.md
git commit -m "docs: bound WebGPT as a code contributor"
```

## Final verification

- Run `npm test` from the isolated worktree.
- Run `git diff --check`.
- Confirm runtime `D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\control-doorbell` is unchanged.
- Generate a review package from the V18 base to the implementation head.
- Request a fresh GPT-5.6 Sol High formal review; do not merge or adopt runtime until Control ACK is durable.
