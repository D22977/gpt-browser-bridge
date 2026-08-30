// GPT_BROWSER_BRIDGE - contract tests (GBB-001)
// node:test only. No third-party test framework.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

const CONTROL_TOWER_DIR = new URL("../skills/control-tower/", import.meta.url);

async function readControlBundle() {
  const names = [
    "HANDOFF.md",
    "SKILL_V4_1_CANDIDATE.md",
    "CONTROL_HANDOFF_PROTOCOL.md",
    "INVARIANTS_AND_LESSONS.md",
  ];
  const entries = await Promise.all(
    names.map(async (name) => [name, await readFile(new URL(name, CONTROL_TOWER_DIR), "utf8")])
  );
  return Object.fromEntries(entries);
}

function scenario(bundle, id) {
  const source = Object.values(bundle).join("\n");
  const match = source.match(new RegExp(`### ${id}\\b[\\s\\S]*?(?=### R\\d{2}\\b|$)`));
  assert.ok(match, `missing control-return regression ${id}`);
  return match[0];
}

function bidirectionalScenario(bundle, id) {
  const source = Object.values(bundle).join("\n");
  const match = source.match(new RegExp(`### ${id}\\b[\\s\\S]*?(?=### BH\\d{2}\\b|$)`));
  assert.ok(match, `missing bidirectional handoff regression ${id}`);
  return match[0];
}

test("Control-return contract keeps HANDOFF navigation-only and preserves canonical Skill freeze", async () => {
  const bundle = await readControlBundle();
  assert.match(bundle["HANDOFF.md"], /navigation pointer|navigation only/i);
  assert.match(bundle["HANDOFF.md"], /latest valid ACTIVE CONTROL|ACTIVE CONTROL/i);
  assert.match(bundle["SKILL_V4_1_CANDIDATE.md"], /SKILL\.md.*MUST NOT be modified|canonical.*SKILL\.md.*not.*modif/i);
});

test("R01 head drift returns CONTROL_REQUIRED before mutation and owner relay", async () => {
  const text = scenario(await readControlBundle(), "R01");
  assert.match(text, /head drift/i);
  assert.match(text, /CONTROL_REQUIRED|LOCAL_CONTROL_RETURN_V1/);
  assert.match(text, /mutation_state[^\n]*NO_MUTATION|no mutation/i);
  assert.match(text, /user_relay_count[^\n]*0|no owner relay/i);
});

test("R02 unexpected implementation branch never resets or deletes", async () => {
  const text = scenario(await readControlBundle(), "R02");
  assert.match(text, /existing implementation branch|unexpected.*branch/i);
  assert.match(text, /CONTROL_REQUIRED|LOCAL_CONTROL_RETURN_V1/);
  assert.match(text, /no reset|no delete|reset\/delete/i);
});

test("R03 unavailable Worker requires Control rebinding and forbids silent substitution", async () => {
  const text = scenario(await readControlBundle(), "R03");
  assert.match(text, /Worker unavailable|worker.*unavailable/i);
  assert.match(text, /REBIND_EXECUTOR|CONTROL_REQUIRED/);
  assert.match(text, /no silent substitute|silent substitution.*forbidden/i);
});

test("R04 ambiguous test failure returns before any repair", async () => {
  const text = scenario(await readControlBundle(), "R04");
  assert.match(text, /non-preauthorized test failure|ambiguous.*test failure/i);
  assert.match(text, /before repair|repair.*forbidden/i);
  assert.match(text, /CONTROL_REQUIRED|LOCAL_CONTROL_RETURN_V1/);
});

test("R05 newer malformed or conflicting authority fails closed without older fallback", async () => {
  const text = scenario(await readControlBundle(), "R05");
  assert.match(text, /newer malformed|conflicting authority/i);
  assert.match(text, /fail closed|FAIL_CLOSED/i);
  assert.match(text, /never.*older|no older.*fallback/i);
});

test("R06 Herdr cannot invent BEST_NEXT or repair scope", async () => {
  const text = scenario(await readControlBundle(), "R06");
  assert.match(text, /Herdr/i);
  assert.match(text, /BEST_NEXT/);
  assert.match(text, /repair scope|repair.*decision/i);
  assert.match(text, /semantic authority[\s\S]*NONE|no semantic authority/i);
});

test("R07 return payload binds the exact current event and idempotency key", async () => {
  const bundle = await readControlBundle();
  const text = scenario(bundle, "R07");
  for (const field of [
    "event_id",
    "idempotency_key",
    "card_id",
    "phase",
    "generation",
    "dispatch",
    "head",
    "branch",
    "problem_class",
    "mutation_state",
    "last_known_safe_point",
  ]) {
    assert.match(text, new RegExp(`\\b${field}\\b`), `R07 missing ${field}`);
  }
  assert.match(bundle["CONTROL_HANDOFF_PROTOCOL.md"], /LOCAL_CONTROL_RETURN_V1/);
});

test("R08 duplicate return delivery is NO_OP_DUPLICATE", async () => {
  const text = scenario(await readControlBundle(), "R08");
  assert.match(text, /duplicate return delivery|duplicate.*return/i);
  assert.match(text, /NO_OP_DUPLICATE|NO_OP/);
  assert.match(text, /no second semantic decision|no second.*decision/i);
});

test("R09 Control response binds the return event before resume", async () => {
  const text = scenario(await readControlBundle(), "R09");
  assert.match(text, /Control response/i);
  assert.match(text, /bind[\s\S]*return event|return event[\s\S]*bind/i);
  assert.match(text, /before.*resume|resume.*only after/i);
});

test("R10 Control-delivery transport failure never becomes user relay", async () => {
  const text = scenario(await readControlBundle(), "R10");
  assert.match(text, /transport failure/i);
  assert.match(text, /user relay|user_relay_count/);
  assert.match(text, /CONTROL_DELIVERY_BLOCKED_V1/);
  assert.match(text, /deterministic route|admitted.*route/i);
});

test("R11 HUMAN_REQUIRED is last resort for genuinely human-only conditions", async () => {
  const text = scenario(await readControlBundle(), "R11");
  assert.match(text, /HUMAN_REQUIRED/);
  assert.match(text, /credential|payment|security consent/i);
  assert.match(text, /irreversible owner choice|product.*scope/i);
  assert.match(text, /last resort|last-resort/i);
  assert.match(text, /not.*carry.*result|no.*courier|user_relay_count[^\\n]*0/i);
});

test("R12 Reviewer FIX_REQUIRED cannot silently route to an unauthorized Worker", async () => {
  const text = scenario(await readControlBundle(), "R12");
  assert.match(text, /Reviewer FIX_REQUIRED|FIX_REQUIRED/);
  assert.match(text, /not.*silently.*route|silent.*route.*forbidden/i);
  assert.match(text, /ACTIVE CONTROL|explicitly authorized deterministic edge/i);
});

test("BH01 durable dispatch without consume or resident binding forbids Control idle", async () => {
  const text = bidirectionalScenario(await readControlBundle(), "BH01");
  assert.match(text, /durable dispatch/i);
  assert.match(text, /consume|resident.*binding/i);
  assert.match(text, /CONTROL_IDLE_FORBIDDEN/);
});

test("BH02 exact consume and future binding allow idle without model polling", async () => {
  const text = bidirectionalScenario(await readControlBundle(), "BH02");
  assert.match(text, /exact.*consume|consumed.*started/i);
  assert.match(text, /current[\s\S]*future.*consumer.*binding|resident[\s\S]*future/i);
  assert.match(text, /CONTROL_IDLE_ALLOWED/);
  assert.match(text, /no model polling|model polling.*forbidden/i);
});

test("BH03 terminal without return request and doorbell is incomplete", async () => {
  const text = bidirectionalScenario(await readControlBundle(), "BH03");
  assert.match(text, /terminal/i);
  assert.match(text, /return request.*doorbell|doorbell.*return request/i);
  assert.match(text, /AUTO_REPORT_INCOMPLETE/);
});

test("BH04 stale or retired Control target is a retired no-op", async () => {
  const text = bidirectionalScenario(await readControlBundle(), "BH04");
  assert.match(text, /stale|retired/i);
  assert.match(text, /NO_OP_RETIRED/);
  assert.match(text, /current ACTIVE generation/i);
});

test("BH05 duplicate outbound wake does not send a second prompt", async () => {
  const text = bidirectionalScenario(await readControlBundle(), "BH05");
  assert.match(text, /duplicate outbound wake/i);
  assert.match(text, /NO_OP_DUPLICATE/);
  assert.match(text, /no second prompt|second prompt[\s\S]*forbidden/i);
});

test("BH06 duplicate inbound doorbell does not create a second decision", async () => {
  const text = bidirectionalScenario(await readControlBundle(), "BH06");
  assert.match(text, /duplicate inbound.*doorbell|inbound.*doorbell.*duplicate/i);
  assert.match(text, /NO_OP_DUPLICATE/);
  assert.match(text, /no second semantic decision|second semantic decision[\s\S]*forbidden/i);
});

test("BH07 Herdr runtime failure blocks liveness without erasing bounded capability", async () => {
  const text = bidirectionalScenario(await readControlBundle(), "BH07");
  assert.match(text, /Herdr.*runtime.*FAIL|runtime.*FAIL.*Herdr/i);
  assert.match(text, /PROVEN_BOUNDED/);
  assert.match(text, /current liveness.*block|blocks.*current liveness/i);
  assert.match(text, /no new infrastructure|new infrastructure[\s\S]*forbidden/i);
});

test("BH08 child terminal without a resident successor fails with missing future binding", async () => {
  const text = bidirectionalScenario(await readControlBundle(), "BH08");
  assert.match(text, /child terminal[\s\S]*parent|parent[\s\S]*child terminal/i);
  assert.match(text, /no.*future.*consumer|future.*successor/i);
  assert.match(text, /FUTURE_WAKE_BOUND_MISSING|BLOCKED_NO_BOUND_SUCCESSOR/);
});

test("BH09 mismatched source/card/head/generation/target fails closed before mutation", async () => {
  const text = bidirectionalScenario(await readControlBundle(), "BH09");
  assert.match(text, /source.*card.*head.*generation.*target|mismatch/i);
  assert.match(text, /FAIL_CLOSED/);
  assert.match(text, /no mutation|NO_MUTATION/);
});

test("BH10 normal handoff keeps user and owner courier counts at zero", async () => {
  const text = bidirectionalScenario(await readControlBundle(), "BH10");
  assert.match(text, /user_relay_count[^\\n]*0/);
  assert.match(text, /owner_courier_count[^\\n]*0/);
});

test("Reviewer canary workflow is a static, read-only, fail-closed runner contract", async () => {
  const source = await readFile(
    new URL("../.github/workflows/reviewer-runner-canary.yml", import.meta.url),
    "utf8"
  );

  assert.match(source, /^name:\s+GBB Reviewer Runner Canary$/m);
  assert.match(source, /^\s+workflow_dispatch:\s*$/m);
  assert.doesNotMatch(source, /^\s+(push|pull_request|workflow_call):/m);
  assert.match(source, /runs-on:\s*\[self-hosted,\s*Windows,\s*GBB-REVIEWER\]/);
  assert.match(source, /timeout-minutes:\s*10\b/);
  assert.match(source, /permissions:\s*\n\s+contents:\s+read/);
  assert.match(source, /shell:\s+pwsh\s+-NoProfile\s+-File\s+\{0\}/);
  assert.doesNotMatch(source, /^\s+shell:\s+pwsh\s*$/m);
  assert.match(source, /RUNNER_NAME/);
  assert.match(source, /gbb-reviewer-win-01/);
  assert.match(source, /whoami/);
  assert.match(source, /UserInteractive/);
  assert.match(source, /SessionId/);
  assert.match(source, /GBBWorker/);
  assert.doesNotMatch(source, /actions\/checkout|uses:\s+/);
  assert.doesNotMatch(source, /(^|[\s`])(?:git|gh)\s+(?:add|commit|push|fetch|checkout|api)\b/i);
  assert.doesNotMatch(source, /(?:Start-Process|&\s*)(?:opencode|chrome|msedge|node)\b/i);
  assert.doesNotMatch(source, /secrets\.|GITHUB_TOKEN/);
});

