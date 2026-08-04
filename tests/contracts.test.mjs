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
  isChatgptConversationUrl,
  extractConversationId,
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

test("job.json accepts a conversation URL with query/hash tolerance", () => {
  const parsed = jobSchema.parse(
    validJob({ conversation_url: `https://chatgpt.com/c/${uuid}?utm_source=x#top` })
  );
  assert.equal(parsed.conversation_url, `https://chatgpt.com/c/${uuid}?utm_source=x#top`);
});

test("job.json rejects look-alike hostnames", () => {
  for (const bad of [
    `https://evilchatgpt.com/c/${uuid}`,
    `https://chatgpt.com.evil.com/c/${uuid}`,
    `https://evil.chatgpt.com/c/${uuid}`,
  ]) {
    assert.throws(() => jobSchema.parse(validJob({ conversation_url: bad })), /conversation_url/);
  }
});

test("job.json rejects a conversation URL without scheme", () => {
  assert.throws(() => jobSchema.parse(validJob({ conversation_url: `chatgpt.com/c/${uuid}` })), /conversation_url/);
});

test("job.json rejects a conversation URL with userinfo", () => {
  assert.throws(() => jobSchema.parse(validJob({ conversation_url: `https://user@chatgpt.com/c/${uuid}` })), /conversation_url/);
});

test("job.json rejects http scheme, explicit port and non-/c/ paths", () => {
  for (const bad of [
    `http://chatgpt.com/c/${uuid}`,
    `https://chatgpt.com:8443/c/${uuid}`,
    `https://chatgpt.com/foo/${uuid}`,
    `https://chatgpt.com/c/${uuid}/extra`,
    `https://chatgpt.com/c/not-a-valid-id!`,
  ]) {
    assert.throws(() => jobSchema.parse(validJob({ conversation_url: bad })), /conversation_url/);
  }
});

test("job.json rejects explicit default ports (443/80) and other ports", () => {
  for (const bad of [
    `https://chatgpt.com:443/c/${uuid}`,
    `https://chatgpt.com:80/c/${uuid}`,
    `https://chatgpt.com:8443/c/${uuid}`,
  ]) {
    assert.throws(() => jobSchema.parse(validJob({ conversation_url: bad })), /conversation_url/);
  }
});

// ---------------------------------------------------------------------------
// GBB-URL-001: GPT-project conversation URLs (/g/<project-id>/c/<uuid-ish>)
// must be accepted alongside the legacy /c/<uuid-ish> form, with every other
// gate (host, scheme, port, credentials, UUID-shape) unchanged.
// ---------------------------------------------------------------------------

test("job.json accepts a GPT-project conversation URL (/g/<project-id>/c/<id>)", () => {
  const parsed = jobSchema.parse(
    validJob({ conversation_url: `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}` })
  );
  assert.equal(parsed.conversation_url, `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`);
});

test("job.json accepts a GPT-project conversation URL with query/hash tolerance", () => {
  const parsed = jobSchema.parse(
    validJob({ conversation_url: `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}?utm_source=x#top` })
  );
  assert.equal(parsed.conversation_url, `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}?utm_source=x#top`);
});

test("job.json rejects a GPT-project URL missing the /c/<id> suffix", () => {
  for (const bad of [
    `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot`,
    `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/`,
    `https://chatgpt.com/g//c/${uuid}`,
    `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/x/${uuid}`,
  ]) {
    assert.throws(() => jobSchema.parse(validJob({ conversation_url: bad })), /conversation_url/);
  }
});

test("job.json rejects a GPT-project URL with a malformed conversation id", () => {
  assert.throws(
    () => jobSchema.parse(validJob({ conversation_url: `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/not-a-valid-id!` })),
    /conversation_url/
  );
});

test("job.json still rejects look-alike hostnames, explicit ports and non-https on the GPT-project form", () => {
  for (const bad of [
    `https://evilchatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`,
    `https://chatgpt.com:8443/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`,
    `http://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`,
    `https://user@chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`,
  ]) {
    assert.throws(() => jobSchema.parse(validJob({ conversation_url: bad })), /conversation_url/);
  }
});

test("extractConversationId returns the same id for both the legacy and GPT-project URL forms", () => {
  const legacy = `https://chatgpt.com/c/${uuid}`;
  const project = `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid.toUpperCase()}`;
  assert.equal(extractConversationId(legacy), uuid);
  assert.equal(extractConversationId(project), uuid);
});

test("extractConversationId returns null for non-conversation paths and unparseable URLs", () => {
  assert.equal(extractConversationId(`https://chatgpt.com/`), null);
  assert.equal(extractConversationId(`https://chatgpt.com/g/g-p-x`), null);
  assert.equal(extractConversationId("not a url"), null);
});

test("isChatgptConversationUrl accepts both forms directly", () => {
  assert.equal(isChatgptConversationUrl(`https://chatgpt.com/c/${uuid}`), true);
  assert.equal(isChatgptConversationUrl(`https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`), true);
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
