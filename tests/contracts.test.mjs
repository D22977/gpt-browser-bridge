// GPT_BROWSER_BRIDGE - contract tests (GBB-001)
// node:test only. No third-party test framework.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  jobSchema,
  resultSchema,
  projectStateSchema,
  workerReportSchema,
  reviewerReportSchema,
  agentReportSchema,
} from "../src/contracts.mjs";

const uuid = "550e8400-e29b-41d4-a716-446655440000";
const sha64 = "a".repeat(64);
const sha7 = "a".repeat(7);
const ts = "2026-07-31T23:10:00+08:00";

function validJob(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    job_id: uuid,
    prompt: "review pack T2",
    prompt_hash: sha64,
    attempt: 1,
    conversation_url: `https://chatgpt.com/c/${uuid}`,
    sent_at: ts,
    baseline: { assistant_count: 3, last_assistant_hash: sha64 },
    ...overrides,
  };
}

function validResult(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    job_id: uuid,
    state: "DONE",
    reply_path: "D:\\AIWORK_RUNTIME\\GPT_BROWSER_BRIDGE\\jobs\\j1\\reply.md",
    reply_hash: sha64,
    baseline: { assistant_count: 3, last_assistant_hash: sha64 },
    started_at: ts,
    completed_at: "2026-07-31T23:20:00+08:00",
    ...overrides,
  };
}

function validProjectState(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: "GBB-PKG-01",
    state: "RUNNING",
    current_task: "GBB-001",
    current_phase: "BOOTSTRAP",
    attempt: 1,
    base_commit: sha7,
    active_run_id: "GBB-001-A1",
    active_terminal: { role: "worker", handle: "term_1", title: "GBB-001-A1-worker" },
    last_checkpoint: ts,
    last_successful_step: "CONTRACTS_CREATED",
    next_action: "CREATE_SKILLS",
    retry_count: 0,
    blocked_reason: null,
    updated_at: ts,
    ...overrides,
  };
}

test("job.json schema accepts a valid job", () => {
  const parsed = jobSchema.parse(validJob());
  assert.equal(parsed.job_id, uuid);
});

test("job.json rejects a non-ChatGPT conversation URL", () => {
  assert.throws(() => jobSchema.parse(validJob({ conversation_url: "https://example.com/x" })), /conversation_url/);
});

test("job.json rejects a bad prompt hash", () => {
  assert.throws(() => jobSchema.parse(validJob({ prompt_hash: "not-a-hash" })), /prompt_hash/);
});

test("job.json rejects a missing baseline", () => {
  assert.throws(() => jobSchema.parse(validJob({ baseline: undefined })), /baseline/);
});

test("result.json accepts DONE / NEEDS_DECISION / FAILED", () => {
  for (const state of ["DONE", "NEEDS_DECISION", "FAILED"]) {
    assert.equal(resultSchema.parse(validResult({ state })).state, state);
  }
});

test("result.json rejects an invalid state", () => {
  assert.throws(() => resultSchema.parse(validResult({ state: "PARTIAL" })), /state/);
});

test("result.json requires reply_hash", () => {
  assert.throws(() => resultSchema.parse(validResult({ reply_hash: "zzz" })), /reply_hash/);
});

test("project_state.json accepts a RUNNING state", () => {
  const parsed = projectStateSchema.parse(validProjectState());
  assert.equal(parsed.current_task, "GBB-001");
});

test("project_state.json accepts all legal states", () => {
  for (const state of [
    "INITIALIZING",
    "RUNNING",
    "WAITING_WORKER",
    "WAITING_REVIEWER",
    "WAITING_BROWSER",
    "REWORK",
    "NEEDS_HUMAN",
    "COMPLETED",
    "CANCELLED",
  ]) {
    const overrides =
      state === "NEEDS_HUMAN" ? { state, blocked_reason: "AUTH_REQUIRED" } : { state };
    assert.equal(projectStateSchema.parse(validProjectState(overrides)).state, state);
  }
});

test("project_state.json rejects an illegal state", () => {
  assert.throws(() => projectStateSchema.parse(validProjectState({ state: "RUNNING_FAST" })), /state/);
});

test("project_state.json rejects NEEDS_HUMAN with an empty blocked_reason", () => {
  const st = validProjectState({ state: "NEEDS_HUMAN", blocked_reason: "" });
  assert.throws(() => projectStateSchema.parse(st), /blocked_reason/);
});

test("worker report schema accepts a valid report", () => {
  const report = {
    run_id: "GBB-001-A1",
    worker: "deepseek-v4-flash-free",
    base_commit: sha7,
    completed_at: ts,
    task_id: "GBB-001",
    commits: [{ sha: sha7, message: "GBB-001 bootstrap" }],
    changed_files: ["README.md", "src/contracts.mjs"],
    acceptance_gates: ["contracts test passes"],
    blockers: [],
    role: "worker",
  };
  const parsed = workerReportSchema.parse(report);
  assert.equal(parsed.run_id, "GBB-001-A1");
});

test("worker report rejects a worker report claiming reviewer role", () => {
  const report = {
    run_id: "GBB-001-A1",
    worker: "deepseek-v4-flash-free",
    base_commit: sha7,
    completed_at: ts,
    task_id: "GBB-001",
    commits: [],
    changed_files: [],
    acceptance_gates: [],
    blockers: [],
    role: "reviewer",
  };
  assert.throws(() => workerReportSchema.parse(report), /role/);
});

test("reviewer report schema accepts only 通過 / 退修 / 受阻", () => {
  const base = {
    run_id: "GBB-001-A1",
    reviewer: "fresh-context",
    base_commit: sha7,
    completed_at: ts,
    task_id: "GBB-001",
    findings: [],
    role: "reviewer",
  };
  for (const conclusion of ["通過", "退修", "受阻"]) {
    assert.equal(reviewerReportSchema.parse({ ...base, conclusion }).conclusion, conclusion);
  }
  assert.throws(() => reviewerReportSchema.parse({ ...base, conclusion: "PASS" }), /conclusion/);
});

test("agentReportSchema discriminates on role", () => {
  const worker = {
    run_id: "GBB-001-A1",
    worker: "w",
    base_commit: sha7,
    completed_at: ts,
    task_id: "GBB-001",
    commits: [],
    changed_files: [],
    acceptance_gates: [],
    blockers: [],
    role: "worker",
  };
  const reviewer = {
    run_id: "GBB-001-A1",
    reviewer: "r",
    base_commit: sha7,
    completed_at: ts,
    task_id: "GBB-001",
    conclusion: "通過",
    findings: [],
    role: "reviewer",
  };
  assert.equal(agentReportSchema.parse(worker).role, "worker");
  assert.equal(agentReportSchema.parse(reviewer).role, "reviewer");
});
