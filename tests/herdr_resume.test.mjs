import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_DECISION_PROTOCOL,
  HERDR_RESUME_DELIVERY_PROTOCOL,
  buildLogicalEventKey,
  classifyFutureConsumerBinding,
  createHerdrPrompter,
  createResidentHerdrConsumer,
  deliverResumeOnce,
  findExistingDelivery,
  matchWaitToDecision,
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
    readAuthority: async ({ phase }) => { authorityPhases.push(phase); return { fingerprint: "authority-v1" }; },
    readDecisionBody: async () => decisionBody(),
    readComments: async ({ logicalKey }) => { commentsPhases.push(logicalKey ? "before_send" : "initial"); return []; },
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
