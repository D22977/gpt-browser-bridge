import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_DECISION_PROTOCOL,
  CURRENT_COMMENT_READBACK_PROTOCOL,
  HERDR_RESUME_DELIVERY_PROTOCOL,
  buildLogicalEventKey,
  classifyFutureConsumerBinding,
  createHerdrPrompter,
  createGhReader,
  createResidentHerdrConsumer,
  deliverResumeOnce,
  findExistingDelivery,
  matchWaitToDecision,
  normalizeWakeAt,
  evaluateTimedQuotaState,
  advanceTimedQuotaState,
  parseAuthoritativeQuotaEvidence,
  scheduleQuotaRetry,
  validatePreSendAuthorityBinding,
  validateFreeRoute,
  parseControlDecision,
  parseHerdrAgentList,
  resolveActiveControlBinding,
  resolveExactHerdrTarget,
  validateWaitTuple,
} from "../src/adapters/herdr_resume.mjs";

const SLASH = String.fromCharCode(92);
const CWD = ["D:", "fixtures", "r49"].join(SLASH);
const BRANCH = "worker/r49-fixture";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SOURCE_RECEIPT = 1629000001;
const GENERATION = 13;
const CARD_ID = "GBB-G13-ISSUE162-RESIDENT-CONSUMER-HERDR-LOOP-R49-01";
const SESSION = "fresh-session-r49";
const INSTANCE = "r49-executor-instance";
const FREE_ROUTE_POLICY = { provider: "herdr:codex", model: "gpt-5.6-luna", billing_class: "FREE", max_cost: 0 };
const DEEPSEEK_FREE_ROUTE_POLICY = { provider: "deepseek", model: "deepseek-v4-flash-free", billing_class: "FREE", max_cost: 0 };

function waitTuple(overrides = {}) {
  return {
    source_terminal_receipt: SOURCE_RECEIPT,
    control_generation: GENERATION,
    card_id: CARD_ID,
    allowed_action_class: "ISSUE162_RESIDENT_CONSUMER",
    executor_role: "WORKER",
    target: {
      agent_name: "R49-EXECUTOR",
      executor_instance_id: INSTANCE,
      surface: "HERDR",
      herdr_agent: "codex",
      herdr_workspace_id: "wR49",
      herdr_pane_id: "wR49:p1",
      herdr_agent_session: SESSION,
      herdr_agent_kind: "codex",
      herdr_agent_provider: "herdr:codex",
      herdr_model: "gpt-5.6-luna",
      cwd: CWD,
      branch: BRANCH,
      HEAD,
      require_visible: true,
      forbidden_pane_ids: [],
      forbidden_task_card_ids: [],
    },
    ...overrides,
  };
}

function decisionBody(overrides = {}) {
  const sourceGeneration = overrides.omitSourceGeneration
    ? ""
    : `source_control_generation: ${overrides.sourceGeneration ?? GENERATION}\n`;
  return `${CONTROL_DECISION_PROTOCOL}

state: EXECUTE_NOW
control_generation: ${overrides.generation ?? GENERATION}
decision_topic: ${overrides.decisionTopic ?? "ISSUE162_RESIDENT_CONSUMER"}

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #162 receipt ${overrides.sourceReceipt ?? SOURCE_RECEIPT}
${sourceGeneration}resume_card_id: ${overrides.cardId ?? CARD_ID}

EXACT_TARGET
executor_role: ${overrides.executorRole ?? "WORKER"}
agent_name: ${overrides.agentName ?? "R49-EXECUTOR"}
executor_instance_id: ${overrides.instanceId ?? INSTANCE}
surface: ${overrides.surface ?? "HERDR"}
minimal_wake: Read GitHub directly and execute only the exact bounded card.
`;
}

function agent(overrides = {}) {
  return {
    agent: "R49-EXECUTOR",
    name: "R49-EXECUTOR",
    agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: SESSION },
    agent_status: "idle",
    model: "gpt-5.6-luna",
    cwd: CWD,
    branch: BRANCH,
    HEAD,
    pane_id: "wR49:p1",
    terminal_id: "term-r49",
    workspace_id: "wR49",
    visible: true,
    ...overrides,
  };
}

function agentList(agents) {
  return JSON.stringify({ id: "cli:agent:list", result: { agents } });
}

function deliveryReceipt(logicalKey, overrides = {}) {
  return `HERDR_RESUME_DELIVERY_V1
state: ${overrides.state ?? "CONSUMED_STARTED"}
logical_event_key: ${logicalKey}
target_herdr_pane_id: wR49:p1
target_herdr_agent_session: ${SESSION}
`;
}

function completeComments(comments = []) {
  return {
    comments,
    pagination_complete: true,
    readback_provenance: {
      protocol: CURRENT_COMMENT_READBACK_PROTOCOL,
      source: "github",
      method: "GET",
      endpoint: "repos/D22977/gpt-browser-bridge/issues/162/comments",
      pagination: "complete",
      readback: "exact_get",
    },
  };
}

function authorityBinding(overrides = {}) {
  return {
    card_id: CARD_ID,
    control_generation: GENERATION,
    source_control_generation: GENERATION,
    HEAD,
    tree: "tree-r49",
    target: {
      agent_name: "R49-EXECUTOR",
      executor_instance_id: INSTANCE,
      surface: "HERDR",
      pane_id: "wR49:p1",
      agent_session: SESSION,
      workspace_id: "wR49",
      cwd: CWD,
      branch: BRANCH,
      HEAD,
    },
    ...overrides,
  };
}

test("wake_at requires an RFC3339 offset, normalizes to UTC epoch, and blocks early send", () => {
  const parsed = normalizeWakeAt("2026-11-01T01:30:00-04:00");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.wake_at, "2026-11-01T05:30:00.000Z");
  assert.equal(parsed.wake_at_ms, Date.parse("2026-11-01T05:30:00.000Z"));
  assert.equal(normalizeWakeAt("2026-11-01T01:30:00").ok, false);
  assert.equal(evaluateTimedQuotaState({ state: "WAITING_FOR_WAKE", wake_at: parsed.wake_at }, { nowMs: parsed.wake_at_ms - 1 }).decision, "WAIT_UNTIL_WAKE");
  assert.equal(evaluateTimedQuotaState({ state: "WAITING_FOR_WAKE", wake_at: parsed.wake_at }, { nowMs: parsed.wake_at_ms }).decision, "SEND_ALLOWED");
});

test("late offline catch-up delivers once and a completed timed event is a duplicate", async () => {
  const tuple = waitTuple();
  const body = decisionBody();
  const wakeAt = "2026-11-01T05:30:00.000Z";
  let prompts = 0;
  const deliver = (timedQuotaState) => deliverResumeOnce({
    waitTuple: tuple,
    decisionBody: body,
    comments: [],
    timedQuotaState,
    quotaRoutePolicy: FREE_ROUTE_POLICY,
    now: () => Date.parse("2026-11-01T06:30:00.000Z"),
    herdr: { prompt: async () => { prompts += 1; return { accepted: true, workspace_id: "wR49", pane_id: "wR49:p1", agent_session: SESSION }; } },
    publishReceipt: async () => ({ id: "catch-up" }),
  });
  const first = await deliver({ state: "WAITING_FOR_WAKE", wake_at: wakeAt });
  const second = await deliver({ state: "DELIVERED", wake_at: wakeAt });
  assert.equal(first.decision, "DELIVERED");
  assert.equal(second.decision, "NO_OP_DUPLICATE");
  assert.equal(prompts, 1);
});

test("only the exact provider, model, and zero-cost route is admissible", () => {
  const policy = { provider: "deepseek", model: "deepseek-v4-flash-free", billing_class: "FREE", max_cost: 0 };
  assert.deepEqual(validateFreeRoute(policy, policy), { ok: true, route: policy });
  assert.equal(validateFreeRoute({ ...policy, max_cost: 1 }, policy).reason, "NONZERO_COST_ROUTE");
  assert.equal(validateFreeRoute({ ...policy, model: "deepseek-v4-flash" }, policy).reason, "WRONG_MODEL");
  assert.equal(validateFreeRoute({ ...policy, provider: "openai" }, policy).reason, "WRONG_PROVIDER");
  assert.equal(validateFreeRoute({ ...policy, billing_class: "PAID" }, policy).reason, "NON_FREE_ROUTE");
  assert.equal(validateFreeRoute({ ...policy, fallback: { provider: "openai", model: "paid" } }, policy).reason, "PAID_FALLBACK_FORBIDDEN");
});

test("quota delay accepts only structured authoritative Retry-After or reset evidence", () => {
  const common = {
    authoritative: true,
    provider: FREE_ROUTE_POLICY.provider,
    model: FREE_ROUTE_POLICY.model,
    billing_class: "FREE",
    max_cost: 0,
    provenance: { source: "provider_http", response_id: "429-1" },
  };
  const byRetryAfter = parseAuthoritativeQuotaEvidence({ ...common, retry_after_seconds: 30 }, { routePolicy: FREE_ROUTE_POLICY, observedAtMs: 1_000 });
  assert.equal(byRetryAfter.ok, true);
  assert.equal(byRetryAfter.wake_at_ms, 31_000);
  const byReset = parseAuthoritativeQuotaEvidence({ ...common, reset_at: "2026-11-01T01:30:00-04:00" }, { routePolicy: FREE_ROUTE_POLICY, observedAtMs: 1_000 });
  assert.equal(byReset.ok, true);
  assert.equal(byReset.wake_at, "2026-11-01T05:30:00.000Z");
  assert.equal(parseAuthoritativeQuotaEvidence({ ...common, reset_at: "tomorrow" }, { routePolicy: FREE_ROUTE_POLICY, observedAtMs: 1_000 }).reason, "INVALID_QUOTA_RESET");
  assert.equal(parseAuthoritativeQuotaEvidence({ ...common, retry_after_seconds: 30, authoritative: false }, { routePolicy: FREE_ROUTE_POLICY, observedAtMs: 1_000 }).reason, "QUOTA_EVIDENCE_NOT_AUTHORITATIVE");
  assert.equal(parseAuthoritativeQuotaEvidence(common, { routePolicy: FREE_ROUTE_POLICY, observedAtMs: 1_000 }).reason, "QUOTA_RESET_MISSING");
});

test("quota retry budget is persisted at one and survives restart state", () => {
  const evidence = parseAuthoritativeQuotaEvidence({
    authoritative: true,
    provider: FREE_ROUTE_POLICY.provider,
    model: FREE_ROUTE_POLICY.model,
    billing_class: "FREE",
    max_cost: 0,
    retry_after_seconds: 5,
    provenance: { source: "provider_http", response_id: "429-2" },
  }, { routePolicy: FREE_ROUTE_POLICY, observedAtMs: 10_000 });
  const scheduled = scheduleQuotaRetry({ state: "WAITING_FOR_WAKE", retry_count: 0, wake_at: "2026-11-01T05:30:00.000Z" }, evidence, { routePolicy: FREE_ROUTE_POLICY, observedAtMs: 10_000 });
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.state.retry_count, 1);
  assert.equal(scheduled.state.state, "RETRY_PENDING");
  const restart = scheduleQuotaRetry(scheduled.state, evidence, { routePolicy: FREE_ROUTE_POLICY, observedAtMs: 20_000 });
  assert.equal(restart.ok, false);
  assert.equal(restart.reason, "RETRY_BUDGET_EXHAUSTED");
  assert.equal(scheduleQuotaRetry({ state: "SEND_PENDING", retry_count: 0 }, evidence, { routePolicy: FREE_ROUTE_POLICY, observedAtMs: 10_000 }).reason, "NO_BLIND_RETRY");
});

test("retry scheduling revalidates the exact admitted free route", () => {
  const policy = { provider: "deepseek", model: "deepseek-v4-flash-free", billing_class: "FREE", max_cost: 0 };
  const evidence = parseAuthoritativeQuotaEvidence({
    authoritative: true, provider: "openai", model: "gpt-paid", billing_class: "FREE", max_cost: 0,
    retry_after_seconds: 5, provenance: { source: "provider_http", response_id: "429-paid" },
  }, { routePolicy: FREE_ROUTE_POLICY, observedAtMs: 10_000 });
  assert.equal(scheduleQuotaRetry({ state: "WAITING_FOR_WAKE", retry_count: 0 }, evidence, { routePolicy: policy, observedAtMs: 10_000 }).reason, "WRONG_PROVIDER");
});

test("a quota retry is legal only before the physical-send boundary", () => {
  const nowMs = Date.parse("2026-11-01T06:30:00.000Z");
  assert.equal(evaluateTimedQuotaState({ state: "RETRY_PENDING", wake_at: "2026-11-01T05:30:00.000Z", retry_count: 1, prompt_submitted: false }, { nowMs }).decision, "SEND_ALLOWED");
  assert.equal(evaluateTimedQuotaState({ state: "RETRY_PENDING", wake_at: "2026-11-01T05:30:00.000Z", retry_count: 2 }, { nowMs }).reason, "RETRY_BUDGET_EXHAUSTED");
  assert.equal(evaluateTimedQuotaState({ state: "RETRY_PENDING", wake_at: "2026-11-01T05:30:00.000Z", retry_count: 1, prompt_submitted: true }, { nowMs }).decision, "NO_BLIND_RETRY");
  assert.equal(evaluateTimedQuotaState({ state: "SEND_PENDING", wake_at: "2026-11-01T05:30:00.000Z", prompt_submitted: false }, { nowMs }).decision, "NO_BLIND_RETRY");
  assert.equal(evaluateTimedQuotaState({ state: "UNCERTAIN_SEND", wake_at: "2026-11-01T05:30:00.000Z", prompt_submitted: false }, { nowMs }).decision, "NO_BLIND_RETRY");
});

test("epoch due-time survives DST and forward/backward clock changes without a duplicate", () => {
  const state = { state: "WAITING_FOR_WAKE", wake_at: "2026-03-08T01:30:00-05:00", logical_event_key: "event-1" };
  const before = advanceTimedQuotaState(state, { nowMs: Date.parse("2026-03-08T06:29:59.000Z") });
  assert.equal(before.decision, "WAIT_UNTIL_WAKE");
  const due = advanceTimedQuotaState(state, { nowMs: Date.parse("2026-03-08T06:30:00.000Z") });
  assert.equal(due.decision, "SEND_ALLOWED");
  assert.equal(due.state.wake_at, "2026-03-08T06:30:00.000Z");
  const afterBackwardJump = advanceTimedQuotaState({ ...due.state, state: "DELIVERED" }, { nowMs: Date.parse("2026-03-08T05:00:00.000Z") });
  assert.equal(afterBackwardJump.decision, "NO_OP_DUPLICATE");
});

test("structured pre-send quota failure schedules one retry without blind resend", async () => {
  const tuple = waitTuple();
  const body = decisionBody();
  const logicalKey = buildLogicalEventKey(tuple, parseControlDecision(body));
  const evidence = {
    authoritative: true,
    provider: FREE_ROUTE_POLICY.provider,
    model: FREE_ROUTE_POLICY.model,
    billing_class: "FREE",
    max_cost: 0,
    retry_after_seconds: 30,
    provenance: { source: "provider_http", response_id: "429-3" },
  };
  let nowMs = 10_000;
  let prompts = 0;
  const persisted = [];
  const herdr = { prompt: async () => {
    prompts += 1;
    if (prompts === 1) throw Object.assign(new Error("quota"), { code: "PROVIDER_QUOTA", prompt_submitted: false, quota_evidence: evidence });
    return { accepted: true, workspace_id: "wR49", pane_id: "wR49:p1", agent_session: SESSION };
  } };
  const base = { waitTuple: tuple, decisionBody: body, comments: [], herdr, publishReceipt: async () => ({ id: "retry-receipt" }), now: () => nowMs, persistDeliveryState: async (state) => { persisted.push(state); }, consumerHostId: "host-a", quotaRoutePolicy: FREE_ROUTE_POLICY };
  const first = await deliverResumeOnce({ ...base, timedQuotaState: { state: "WAITING_FOR_WAKE", wake_at: "1970-01-01T00:00:00.000Z", retry_count: 0 } });
  assert.equal(first.decision, "RETRY_SCHEDULED");
  assert.equal(persisted.at(-1).state, "RETRY_PENDING");
  assert.equal(persisted.at(-1).retry_count, 1);
  assert.equal(persisted.at(-1).consumer_host_id, "host-a");
  const scheduled = persisted.at(-1);
  const early = await deliverResumeOnce({ ...base, timedQuotaState: scheduled, deliveryState: scheduled });
  assert.equal(early.decision, "WAIT_UNTIL_WAKE");
  nowMs = scheduled.wake_at_ms;
  const retry = await deliverResumeOnce({ ...base, timedQuotaState: scheduled, deliveryState: scheduled });
  assert.equal(retry.decision, "DELIVERED");
  assert.equal(prompts, 2);
  assert.equal(logicalKey, retry.logical_key);
});

test("GitHub auth, rate, pagination, or readback ambiguity is a no-prompt condition", async () => {
  const reader = createGhReader({ exec: async () => ({ stdout: "" }) });
  await assert.rejects(reader.readComments({ repo: "D22977/gpt-browser-bridge", issue: 162 }), /GITHUB_COMMENTS_READBACK_AMBIGUOUS/);
  const invalid = createGhReader({ exec: async () => ({ stdout: '{"message":"rate limit"}' }) });
  await assert.rejects(invalid.readComments({ repo: "D22977/gpt-browser-bridge", issue: 162 }), /GITHUB_COMMENTS_READBACK_AMBIGUOUS/);
});

test("GitHub comment reader returns pagination-complete exact-readback provenance", async () => {
  const reader = createGhReader({ exec: async () => ({ stdout: "[[{\"id\":1,\"created_at\":\"now\",\"body\":\"receipt\"}]]" }) });
  const result = await reader.readComments({ repo: "D22977/gpt-browser-bridge", issue: 162 });
  assert.deepEqual(result.comments, [{ id: 1, created_at: "now", body: "receipt" }]);
  assert.equal(result.pagination_complete, true);
  assert.deepEqual(result.readback_provenance, {
    protocol: CURRENT_COMMENT_READBACK_PROTOCOL,
    source: "github",
    method: "GET",
    endpoint: "repos/D22977/gpt-browser-bridge/issues/162/comments",
    pagination: "complete",
    readback: "exact_get",
  });
});

test("pre-send authority revalidation binds card, generation, head, and exact target", () => {
  const binding = authorityBinding();
  assert.deepEqual(validatePreSendAuthorityBinding(binding, { ...binding }), { ok: true });
  assert.equal(validatePreSendAuthorityBinding(binding, { ...binding, HEAD: "different" }).reason, "AUTHORITY_HEAD_CHANGED");
  assert.equal(validatePreSendAuthorityBinding(binding, { ...binding, control_generation: GENERATION - 1 }).reason, "AUTHORITY_GENERATION_CHANGED");
  assert.equal(validatePreSendAuthorityBinding(binding, { ...binding, target: { ...binding.target, pane_id: "wR49:p2" } }).reason, "AUTHORITY_TARGET_CHANGED");
  assert.equal(validatePreSendAuthorityBinding({ ...binding, source_control_generation: undefined }, { ...binding, source_control_generation: undefined }).reason, "AUTHORITY_BINDING_MISSING");
});

test("resident delivery revalidates exact authority before prompting", async () => {
  const binding = authorityBinding();
  let prompts = 0;
  let reads = 0;
  const result = await createResidentHerdrConsumer({
    futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: [CONTROL_DECISION_PROTOCOL] },
    waitTuple: waitTuple(),
    readAuthority: async () => ({ value: { binding: reads++ === 0 ? binding : { ...binding, HEAD: "drifted" } } }),
    readDecisionBody: async () => decisionBody(),
    readComments: async () => completeComments(),
    herdr: { prompt: async () => { prompts += 1; return {}; } },
    publishReceipt: async () => ({ id: "never" }),
    requireExactAuthorityBinding: true,
  }).consumeOnce();
  assert.equal(result.decision, "CONTROL_REQUIRED");
  assert.equal(prompts, 0);
});

test("due timed delivery requires an independently admitted exact free route", async () => {
  let prompts = 0;
  const result = await deliverResumeOnce({
    waitTuple: waitTuple(),
    decisionBody: decisionBody(),
    comments: [],
    timedQuotaState: { state: "WAITING_FOR_WAKE", wake_at: "1970-01-01T00:00:00.000Z", retry_count: 0 },
    now: () => 1_000,
    herdr: { prompt: async () => { prompts += 1; } },
    publishReceipt: async () => ({ id: "never" }),
  });
  assert.equal(result.decision, "CONTROL_REQUIRED");
  assert.equal(result.reason, "MISSING_ROUTE");
  assert.equal(prompts, 0);
});

test("paid or nonzero-cost timed routes fail closed before the physical prompt", async () => {
  for (const quotaRoutePolicy of [
    { ...FREE_ROUTE_POLICY, billing_class: "PAID" },
    { ...FREE_ROUTE_POLICY, max_cost: 1 },
    { ...FREE_ROUTE_POLICY, fallback: { provider: "openai", model: "paid" } },
    { ...FREE_ROUTE_POLICY, fallback_path: null },
  ]) {
    let prompts = 0;
    const result = await deliverResumeOnce({
      waitTuple: waitTuple(),
      decisionBody: decisionBody(),
      comments: [],
      timedQuotaState: { state: "WAITING_FOR_WAKE", wake_at: "1970-01-01T00:00:00.000Z", retry_count: 0 },
      quotaRoutePolicy,
      now: () => 1_000,
      herdr: { prompt: async () => { prompts += 1; } },
      publishReceipt: async () => ({ id: "never" }),
    });
    assert.equal(result.decision, "CONTROL_REQUIRED");
    assert.equal(prompts, 0);
  }
});

test("timed decision route must match the independently admitted route policy", async () => {
  let prompts = 0;
  const result = await deliverResumeOnce({
    waitTuple: waitTuple(),
    decisionBody: `${decisionBody()}
TIMED_QUOTA
wake_at: 1970-01-01T00:00:00Z
provider: openai
model: gpt-paid
billing_class: FREE
max_cost: 0
`,
    comments: [],
    quotaRoutePolicy: FREE_ROUTE_POLICY,
    now: () => 1_000,
    herdr: { prompt: async () => { prompts += 1; } },
    publishReceipt: async () => ({ id: "never" }),
  });
  assert.equal(result.decision, "CONTROL_REQUIRED");
  assert.equal(result.reason, "WRONG_PROVIDER");
  assert.equal(prompts, 0);
});

test("timed delivery rejects a free route policy that mismatches the exact physical Herdr target", async () => {
  let prompts = 0;
  const result = await deliverResumeOnce({
    waitTuple: waitTuple(),
    decisionBody: decisionBody(),
    comments: [],
    timedQuotaState: { state: "WAITING_FOR_WAKE", wake_at: "1970-01-01T00:00:00.000Z", retry_count: 0 },
    quotaRoutePolicy: DEEPSEEK_FREE_ROUTE_POLICY,
    now: () => 1_000,
    herdr: { prompt: async () => { prompts += 1; } },
    publishReceipt: async () => ({ id: "never" }),
  });
  assert.equal(result.decision, "CONTROL_REQUIRED");
  assert.equal(result.reason, "WRONG_PROVIDER");
  assert.equal(prompts, 0);
});

test("resolved Herdr route identity is checked before the prompt command", async () => {
  const calls = [];
  const prompter = createHerdrPrompter({
    exec: async (_exe, args) => {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "list") return { stdout: agentList([agent()]) };
      throw new Error(`unexpected prompt command: ${args.join(" ")}`);
    },
  });
  await assert.rejects(
    prompter.prompt(waitTuple().target, "wake", { quotaRoutePolicy: DEEPSEEK_FREE_ROUTE_POLICY }),
    /WRONG_PROVIDER/,
  );
  assert.equal(calls.filter((args) => args[1] === "prompt").length, 0);
});

test("resident delivery rejects a syntactically valid but incomplete current-comment page", async () => {
  let prompts = 0;
  const incomplete = {
    comments: [],
    pagination_complete: false,
    readback_provenance: { source: "github", pagination: "partial", readback: "exact_get" },
  };
  const result = await createResidentHerdrConsumer({
    futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: [CONTROL_DECISION_PROTOCOL] },
    waitTuple: waitTuple(),
    decisionBody: decisionBody(),
    readAuthority: async () => ({ binding: authorityBinding() }),
    readComments: async () => incomplete,
    timedQuotaState: { state: "WAITING_FOR_WAKE", wake_at: "1970-01-01T00:00:00.000Z", retry_count: 0 },
    quotaRoutePolicy: { provider: "herdr:codex", model: "gpt-5.6-luna", billing_class: "FREE", max_cost: 0 },
    now: () => 1_000,
    herdr: { prompt: async () => { prompts += 1; } },
    publishReceipt: async () => ({ id: "never" }),
  }).consumeOnce();
  assert.equal(result.decision, "CONTROL_REQUIRED");
  assert.match(result.reason, /COMMENTS/);
  assert.equal(prompts, 0);
});

test("quota evidence cannot self-validate its provider and model", () => {
  const evidence = parseAuthoritativeQuotaEvidence({
    authoritative: true,
    provider: "openai",
    model: "gpt-paid",
    billing_class: "FREE",
    max_cost: 0,
    retry_after_seconds: 5,
    provenance: { source: "provider_http", response_id: "429-mismatch" },
  }, { routePolicy: FREE_ROUTE_POLICY, observedAtMs: 10_000 });
  assert.equal(evidence.reason, "WRONG_PROVIDER");
  assert.equal(scheduleQuotaRetry({ state: "WAITING_FOR_WAKE", retry_count: 0 }, { ...evidence, ok: true, wake_at: "1970-01-01T00:00:05.000Z", wake_at_ms: 5_000 }, { observedAtMs: 10_000 }).reason, "MISSING_ROUTE");
});

test("resident physical delivery requires fresh authority and current comments readers", async () => {
  for (const missing of ["authority", "comments"]) {
    let prompts = 0;
    const config = {
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: [CONTROL_DECISION_PROTOCOL] },
      waitTuple: waitTuple(),
      decisionBody: decisionBody(),
      comments: [],
      timedQuotaState: { state: "WAITING_FOR_WAKE", wake_at: "1970-01-01T00:00:00.000Z", retry_count: 0 },
      quotaRoutePolicy: FREE_ROUTE_POLICY,
      readAuthority: missing === "authority" ? undefined : async () => ({ binding: authorityBinding() }),
      readComments: missing === "comments" ? undefined : async () => completeComments(),
      herdr: { prompt: async () => { prompts += 1; } },
      publishReceipt: async () => ({ id: "never" }),
      now: () => "2026-09-14T00:00:00.000Z",
    };
    const result = await createResidentHerdrConsumer(config).consumeOnce();
    assert.equal(result.decision, "CONTROL_REQUIRED");
    assert.equal(prompts, 0);
  }
});

test("resident physical delivery requires exact tree on both authority reads", async () => {
  for (const latest of [authorityBinding({ tree: undefined }), authorityBinding({ tree: "tree-drifted" })]) {
    let prompts = 0;
    let reads = 0;
    const result = await createResidentHerdrConsumer({
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: [CONTROL_DECISION_PROTOCOL] },
      waitTuple: waitTuple(),
      decisionBody: decisionBody(),
      readAuthority: async ({ phase }) => ({ binding: phase === "start" ? authorityBinding() : latest }),
      readComments: async () => completeComments(),
      quotaRoutePolicy: FREE_ROUTE_POLICY,
      herdr: { prompt: async () => { prompts += 1; } },
      publishReceipt: async () => ({ id: "never" }),
      now: () => "2026-09-14T00:00:00.000Z",
      _reads: reads,
    }).consumeOnce();
    assert.equal(result.decision, "CONTROL_REQUIRED");
    assert.equal(prompts, 0);
  }
});

test("authority and current-comment readback errors are CONTROL_REQUIRED with zero prompts", async () => {
  for (const mode of ["authority", "comments"]) {
    let prompts = 0;
    const result = await createResidentHerdrConsumer({
      futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: [CONTROL_DECISION_PROTOCOL] },
      waitTuple: waitTuple(),
      decisionBody: decisionBody(),
      readAuthority: async ({ phase }) => {
        if (mode === "authority" || phase === "before_send") throw new Error("github readback ambiguous");
        return { binding: authorityBinding() };
      },
      readComments: async () => {
        if (mode === "comments") throw new Error("pagination incomplete");
        return [];
      },
      quotaRoutePolicy: FREE_ROUTE_POLICY,
      herdr: { prompt: async () => { prompts += 1; } },
      publishReceipt: async () => ({ id: "never" }),
      now: () => "2026-09-14T00:00:00.000Z",
    }).consumeOnce();
    assert.equal(result.decision, "CONTROL_REQUIRED");
    assert.equal(prompts, 0);
  }
});

test("a timed event is host-bound unless the second host is explicitly authorized", () => {
  const state = { state: "WAITING_FOR_WAKE", wake_at: "2099-01-01T00:00:00.000Z", consumer_host_id: "host-a" };
  assert.equal(evaluateTimedQuotaState(state, { nowMs: 0, hostId: "host-a" }).decision, "WAIT_UNTIL_WAKE");
  assert.equal(evaluateTimedQuotaState(state, { nowMs: 0, hostId: "host-b" }).reason, "HOST_IDENTITY_REJECTED");
  assert.equal(evaluateTimedQuotaState(state, { nowMs: 0, hostId: "host-b", authorizedHostIds: ["host-b"] }).decision, "WAIT_UNTIL_WAKE");
});

test("timed delivery without a pre-send authority reader is CONTROL_REQUIRED", async () => {
  let prompts = 0;
  const result = await createResidentHerdrConsumer({
    futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: [CONTROL_DECISION_PROTOCOL] },
    waitTuple: waitTuple(),
    decisionBody: decisionBody(),
    comments: [],
    timedQuotaState: { state: "WAITING_FOR_WAKE", wake_at: "1970-01-01T00:00:00.000Z", retry_count: 0 },
    requireExactAuthorityBinding: true,
    herdr: { prompt: async () => { prompts += 1; return {}; } },
    publishReceipt: async () => ({ id: "never" }),
    now: () => 1_000,
  }).consumeOnce();
  assert.equal(result.decision, "CONTROL_REQUIRED");
  assert.equal(result.reason, "CONTROL_REQUIRED_AUTHORITY_READER_MISSING");
  assert.equal(prompts, 0);
});

test("CONTROL_DECISION_V1 carries a normalized timed wake and exact free route", () => {
  const parsed = parseControlDecision(`${decisionBody()}
TIMED_QUOTA
wake_at: 2026-11-01T01:30:00-04:00
provider: deepseek
model: deepseek-v4-flash-free
billing_class: FREE
max_cost: 0
`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.decision.wake_at, "2026-11-01T05:30:00.000Z");
  assert.deepEqual(parsed.decision.quota_route, { provider: "deepseek", model: "deepseek-v4-flash-free", billing_class: "FREE", max_cost: 0 });
});

test("decision-carried wake_at gates delivery even without a local prebuilt state", async () => {
  let prompts = 0;
  const result = await deliverResumeOnce({
    waitTuple: waitTuple(),
    decisionBody: `${decisionBody()}
TIMED_QUOTA
wake_at: 2099-01-01T00:00:00Z
provider: deepseek
model: deepseek-v4-flash-free
billing_class: FREE
max_cost: 0
`,
    comments: [],
    now: () => Date.parse("2026-01-01T00:00:00Z"),
    herdr: { prompt: async () => { prompts += 1; return {}; } },
    publishReceipt: async () => ({ id: "never" }),
  });
  assert.equal(result.decision, "WAIT_UNTIL_WAKE");
  assert.equal(prompts, 0);
});

test("exact source, generation, card, and target bindings are required", () => {
  const tuple = waitTuple();
  const checked = validateWaitTuple(tuple);
  assert.equal(checked.ok, true);
  assert.equal(matchWaitToDecision(tuple, parseControlDecision(decisionBody())).ok, true);
  assert.equal(matchWaitToDecision(tuple, parseControlDecision(decisionBody({ generation: 12 }))).reason, "WRONG_GENERATION");
  assert.equal(matchWaitToDecision(tuple, parseControlDecision(decisionBody({ cardId: "OTHER-CARD" }))).reason, "WRONG_CARD");
  assert.equal(matchWaitToDecision(tuple, parseControlDecision("NOT_CONTROL_DECISION")).ok, false);
});

test("card binding rejects prefix, suffix, and superstring variants before send", async () => {
  const variants = [
    `prefix-${CARD_ID}`,
    `${CARD_ID}-suffix`,
    `prefix-${CARD_ID}-suffix`,
  ];
  for (const cardId of variants) {
    let prompts = 0;
    let persisted = false;
    const result = await deliverResumeOnce({
      waitTuple: waitTuple(),
      decisionBody: decisionBody({ cardId }),
      comments: [],
      herdr: { prompt: async () => { prompts += 1; } },
      persistDeliveryState: async () => { persisted = true; },
      publishReceipt: async () => ({ id: "never" }),
    });
    assert.equal(result.reason, "WRONG_CARD");
    assert.equal(prompts, 0);
    assert.equal(persisted, false);
  }
});

test("source control generation is explicit, positive, and exactly matched before send", async () => {
  for (const sourceGeneration of ["not-an-integer", "13.5", "0", "-1"]) {
    const parsed = parseControlDecision(decisionBody({ sourceGeneration }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "MISSING_SOURCE_CONTROL_GENERATION");
  }
  const omitted = parseControlDecision(decisionBody({ omitSourceGeneration: true }));
  assert.deepEqual(omitted, { ok: false, reason: "MISSING_SOURCE_CONTROL_GENERATION" });

  let prompts = 0;
  let persisted = false;
  const result = await deliverResumeOnce({
    waitTuple: waitTuple(),
    decisionBody: decisionBody({ sourceGeneration: GENERATION - 1 }),
    comments: [],
    herdr: { prompt: async () => { prompts += 1; } },
    persistDeliveryState: async () => { persisted = true; },
    publishReceipt: async () => ({ id: "never" }),
  });
  assert.equal(result.reason, "WRONG_SOURCE_GENERATION");
  assert.equal(prompts, 0);
  assert.equal(persisted, false);
});

test("executor role and decision topic bind exactly to the wait tuple before send", async () => {
  assert.equal(matchWaitToDecision(waitTuple(), parseControlDecision(decisionBody())).ok, true);
  for (const [overrides, tupleOverride, expectedReason] of [
    [{ executorRole: "REVIEWER" }, {}, "WRONG_EXECUTOR_ROLE"],
    [{ decisionTopic: "ISSUE162_RESIDENT_CONSUMER_EXTRA" }, {}, "WRONG_DECISION_TOPIC"],
    [{}, { allowed_action_class: "OTHER_ACTION" }, "WRONG_DECISION_TOPIC"],
  ]) {
    let prompts = 0;
    let persisted = false;
    const result = await deliverResumeOnce({
      waitTuple: waitTuple(tupleOverride),
      decisionBody: decisionBody(overrides),
      comments: [],
      herdr: { prompt: async () => { prompts += 1; } },
      persistDeliveryState: async () => { persisted = true; },
      publishReceipt: async () => ({ id: "never" }),
    });
    assert.equal(result.reason, expectedReason);
    assert.equal(prompts, 0);
    assert.equal(persisted, false);
  }
});

test("one visible exact Herdr target is selected with cwd, branch, HEAD, and model bindings", () => {
  const resolved = resolveExactHerdrTarget(waitTuple().target, parseHerdrAgentList(agentList([agent()])));
  assert.equal(resolved.ok, true);
  assert.equal(resolved.target.pane_id, "wR49:p1");
  assert.equal(resolved.target.cwd, CWD);
  assert.equal(resolved.target.branch, BRANCH);
  assert.equal(resolved.target.HEAD, HEAD);
  assert.equal(resolved.target.model, "gpt-5.6-luna");
});

test("zero, ambiguous, stale, invisible, and forbidden targets fail closed", () => {
  const target = waitTuple().target;
  assert.deepEqual(resolveExactHerdrTarget(target, parseHerdrAgentList(agentList([]))), {
    ok: false,
    reason: "NO_ELIGIBLE_PHYSICAL_TARGET",
    count: 0,
  });
  const ambiguousTarget = { ...target, herdr_pane_id: undefined, herdr_agent_session: undefined };
  assert.deepEqual(resolveExactHerdrTarget(ambiguousTarget, parseHerdrAgentList(agentList([
    agent(),
    agent({ pane_id: "wR49:p2", terminal_id: "term-r49-2" }),
  ]))), { ok: false, reason: "AMBIGUOUS_PHYSICAL_TARGET", count: 2 });
  assert.equal(resolveExactHerdrTarget(target, parseHerdrAgentList(agentList([agent({ agent_session: { agent: "codex", value: "new-session" } })]))).count, 0);
  assert.equal(resolveExactHerdrTarget(target, parseHerdrAgentList(agentList([agent({ visible: false })]))).count, 0);
  assert.equal(resolveExactHerdrTarget({ ...target, forbidden_pane_ids: ["wR49:p1"] }, parseHerdrAgentList(agentList([agent()]))).count, 0);
});

test("physical target is listed twice and no alternate target is used after drift", async () => {
  const calls = [];
  let listCount = 0;
  const prompter = createHerdrPrompter({
    herdrExe: "herdr.exe",
    exec: async (_exe, args) => {
      calls.push(args);
      if (args[1] === "list") {
        listCount += 1;
        return { stdout: agentList([agent(listCount === 1 ? {} : { agent_session: { agent: "codex", value: "changed" } })]) };
      }
      return { stdout: "{}" };
    },
  });
  await assert.rejects(prompter.prompt(waitTuple().target, "pointer"), (error) => error.code === "STALE_PHYSICAL_TARGET");
  assert.equal(calls.filter((args) => args[1] === "prompt").length, 0);
});

test("stable exact target receives one pointer prompt", async () => {
  const calls = [];
  const prompter = createHerdrPrompter({
    herdrExe: "herdr.exe",
    exec: async (_exe, args) => {
      calls.push(args);
      return args[1] === "list" ? { stdout: agentList([agent()]) } : { stdout: "{}" };
    },
  });
  const result = await prompter.prompt(waitTuple().target, "Read GitHub directly.");
  assert.equal(result.accepted, true);
  assert.deepEqual(calls.find((args) => args[1] === "prompt"), ["agent", "prompt", "wR49:p1", "Read GitHub directly."]);
});

test("duplicate durable delivery is NO_OP_DUPLICATE", async () => {
  const tuple = waitTuple();
  const body = decisionBody();
  const logicalKey = buildLogicalEventKey(tuple, parseControlDecision(body));
  let prompts = 0;
  const first = await deliverResumeOnce({
    waitTuple: tuple,
    decisionBody: body,
    comments: [],
    herdr: { prompt: async () => { prompts += 1; return { accepted: true, workspace_id: "wR49", pane_id: "wR49:p1", agent_session: SESSION }; } },
    publishReceipt: async (receipt) => ({ id: receipt.logical_event_key }),
  });
  assert.equal(first.decision, "DELIVERED");
  const second = await deliverResumeOnce({
    waitTuple: tuple,
    decisionBody: body,
    comments: [{ id: "receipt-1", body: deliveryReceipt(logicalKey) }],
    herdr: { prompt: async () => { prompts += 1; } },
    publishReceipt: async () => ({ id: "receipt-2" }),
  });
  assert.equal(second.decision, "NO_OP_DUPLICATE");
  assert.equal(prompts, 1);
});

test("persisted SEND_PENDING state blocks a restart from blind retrying", async () => {
  const tuple = waitTuple();
  const body = decisionBody();
  const logicalKey = buildLogicalEventKey(tuple, parseControlDecision(body));
  let prompts = 0;
  const result = await deliverResumeOnce({
    waitTuple: tuple,
    decisionBody: body,
    comments: [],
    deliveryState: { logical_event_key: logicalKey, state: "SEND_PENDING" },
    herdr: { prompt: async () => { prompts += 1; } },
    publishReceipt: async () => ({ id: "never" }),
  });
  assert.equal(result.decision, "NO_BLIND_RETRY");
  assert.equal(result.reason, "SEND_PENDING");
  assert.equal(prompts, 0);
});

test("uncertain prompt publishes NO_BLIND_RETRY and never prompts again", async () => {
  const tuple = waitTuple();
  const body = decisionBody();
  const published = [];
  const first = await deliverResumeOnce({
    waitTuple: tuple,
    decisionBody: body,
    comments: [],
    herdr: { prompt: async () => { throw Object.assign(new Error("transport uncertain"), { code: "SENDER_UNCERTAIN" }); } },
    publishReceipt: async (receipt) => { published.push(receipt); return { id: "uncertain-1" }; },
  });
  assert.equal(first.decision, "NO_BLIND_RETRY");
  assert.equal(published[0].state, "UNCERTAIN_SEND");
  const second = await deliverResumeOnce({
    waitTuple: tuple,
    decisionBody: body,
    comments: [{ id: "uncertain-1", body: deliveryReceipt(first.logical_key, { state: "UNCERTAIN_SEND" }) }],
    herdr: { prompt: async () => { throw new Error("must not retry"); } },
    publishReceipt: async () => ({ id: "never" }),
  });
  assert.equal(second.decision, "NO_OP_DUPLICATE");
});

test("resident consumer refuses to prompt without a resident restartable binding", async () => {
  let promptCount = 0;
  const result = await createResidentHerdrConsumer({
    futureConsumerBinding: { resident: false, restartable: false, process_alive: true },
    herdr: { prompt: async () => { promptCount += 1; } },
  }).consumeOnce();
  assert.equal(result.decision, "CONTROL_REQUIRED_FUTURE_CONSUMER_BINDING_MISSING");
  assert.equal(promptCount, 0);
  assert.equal(classifyFutureConsumerBinding({ resident: true, restartable: true, source: "supervisor", event_classes: [CONTROL_DECISION_PROTOCOL] }).bound, true);
});

test("resident consumer rereads authority before send and persists delivery state", async () => {
  const tuple = waitTuple();
  const states = [];
  const authorityPhases = [];
  const commentsPhases = [];
  const consumer = createResidentHerdrConsumer({
    futureConsumerBinding: { resident: true, restartable: true, source: "supervisor", event_classes: [CONTROL_DECISION_PROTOCOL] },
    waitTuple: tuple,
    readAuthority: async ({ phase }) => { authorityPhases.push(phase); return { fingerprint: "authority-v1", binding: authorityBinding() }; },
    readDecisionBody: async () => decisionBody(),
    readComments: async ({ logicalKey }) => { commentsPhases.push(logicalKey ? "before_send" : "initial"); return completeComments(); },
    readState: async () => null,
    writeState: async (state) => { states.push(state.state); },
    herdr: { prompt: async () => ({ accepted: true, workspace_id: "wR49", pane_id: "wR49:p1", agent_session: SESSION, cwd: CWD, branch: BRANCH, HEAD, visible: true }) },
    publishReceipt: async () => ({ id: "r49-delivery" }),
    now: () => "2026-09-14T00:00:00.000Z",
  });
  const result = await consumer.consumeOnce();
  assert.equal(result.decision, "DELIVERED");
  assert.deepEqual(authorityPhases, ["start", "before_send"]);
  assert.deepEqual(commentsPhases, ["initial", "before_send"]);
  assert.deepEqual(states, ["SEND_PENDING", "DELIVERED"]);
});

test("current ACTIVE Control binding is required for return routing", () => {
  const current = `CONTROL_GENERATION_SWITCH_V1

new_generation: 013
new_conversation_id: active-013
new_generation_status: ACTIVE
`;
  assert.deepEqual(resolveActiveControlBinding(current), { ok: true, generation: 13, conversation_id: "active-013" });
  assert.equal(resolveActiveControlBinding(current.replace("ACTIVE", "RETIRED")).ok, false);
});

test("delivery protocol and logical-key parser remain exact", () => {
  const tuple = waitTuple();
  const key = buildLogicalEventKey(tuple, parseControlDecision(decisionBody()));
  assert.equal(HERDR_RESUME_DELIVERY_PROTOCOL, "HERDR_RESUME_DELIVERY_V1");
  assert.equal(findExistingDelivery([{ id: "receipt-1", body: deliveryReceipt(key) }], key).receipt_id, "receipt-1");
});
