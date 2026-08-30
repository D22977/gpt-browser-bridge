import test from "node:test";
import assert from "node:assert/strict";

import {
  HERDR_RESUME_DELIVERY_PROTOCOL,
  buildLogicalEventKey,
  classifyFutureConsumerBinding,
  createHerdrPrompter,
  deliverResumeOnce,
  findExistingDelivery,
  matchWaitToDecision,
  parseControlDecision,
  parseHerdrAgentList,
  resolveActiveControlBinding,
  resolveExactHerdrTarget,
  validateWaitTuple,
} from "../src/adapters/herdr_resume.mjs";

const SOURCE_RECEIPT = 5467000001;
const GENERATION = 7;
const CARD_ID = "HERDR-CONTROL-AUTONOMOUS-SEAM-RESTORE-G7-01";
const SESSION = "01a04f6c-bd0f-7b42-8b56-ab876c720aad";

function waitTuple(overrides = {}) {
  return {
    source_terminal_receipt: SOURCE_RECEIPT,
    control_generation: GENERATION,
    card_id: CARD_ID,
    allowed_action_class: "CONTROL_AUTONOMOUS_SEAM_REPAIR",
    target: {
      agent_name: "LOCAL_HERDR_CODEX_GENERIC",
      executor_instance_id: "HERDR-CONTROL-AUTONOMOUS-SEAM-RESTORE-G7-01",
      surface: "HERDR",
      herdr_agent: "codex",
      herdr_workspace_id: "w2",
      herdr_pane_id: "w2:p1",
      herdr_agent_session: SESSION,
      herdr_agent_kind: "codex",
      forbidden_pane_ids: [],
      forbidden_task_card_ids: [],
    },
    ...overrides,
  };
}

function decisionBody(overrides = {}) {
  return `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: ${overrides.generation ?? GENERATION}
decision_topic: TEST_HERDR_RESUME

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #103 receipt ${overrides.sourceReceipt ?? SOURCE_RECEIPT}
source_terminal_state: WAIT_CONTROL_DECISION
source_control_generation: ${overrides.sourceGeneration ?? GENERATION}
resume_card_id: ${overrides.cardId ?? CARD_ID}

EXACT_TARGET
executor_role: WORKER
agent_name: ${overrides.agentName ?? "LOCAL_HERDR_CODEX_GENERIC"}
executor_instance_id: ${overrides.instanceId ?? "HERDR-CONTROL-AUTONOMOUS-SEAM-RESTORE-G7-01"}
surface: ${overrides.surface ?? "HERDR"}
minimal_wake: Read GitHub directly. Rehydrate the exact bounded card only.
`;
}

function agent(id = "target", overrides = {}) {
  return {
    agent: "codex",
    agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: SESSION },
    agent_status: "working",
    cwd: "D:\\AIWORK_WT\\GPT_BROWSER_BRIDGE\\HERDR-CONTROL-AUTONOMOUS-SEAM-G7",
    pane_id: "w2:p1",
    terminal_id: `term-${id}`,
    workspace_id: "w2",
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
target_herdr_pane_id: w2:p1
target_herdr_agent_session: ${SESSION}
`;
}

test("T01 exact decision/source/generation/card/target matching is preserved", () => {
  const tuple = waitTuple();
  const checked = validateWaitTuple(tuple);
  assert.equal(checked.ok, true);
  const matched = matchWaitToDecision(tuple, parseControlDecision(decisionBody()));
  assert.equal(matched.ok, true);
  assert.match(matched.pointer, /Read GitHub directly/);
});

test("T02 duplicate logical names resolve one exact eligible pane and prompt that pane once", async () => {
  const tuple = waitTuple();
  const list = agentList([
    agent("p1"),
    agent("other", { pane_id: "w2:p3", agent_session: { value: "other-session" } }),
  ]);
  const resolved = resolveExactHerdrTarget(tuple.target, parseHerdrAgentList(list));
  assert.equal(resolved.ok, true);
  assert.equal(resolved.target.pane_id, "w2:p1");

  const calls = [];
  const prompter = createHerdrPrompter({
    herdrExe: "herdr.exe",
    exec: async (_exe, args) => {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "list") return { stdout: list };
      return { stdout: "{}" };
    },
  });
  const result = await prompter.prompt(tuple.target, "pointer");
  assert.equal(result.accepted, true);
  assert.equal(result.target.pane_id, "w2:p1");
  assert.equal(calls.filter((args) => args[1] === "prompt").length, 1);
  assert.deepEqual(calls.find((args) => args[1] === "prompt"), ["agent", "prompt", "w2:p1", "pointer"]);
});

test("T03 duplicate eligible panes fail closed without prompting", () => {
  const tuple = waitTuple({ target: { ...waitTuple().target, herdr_pane_id: undefined, herdr_agent_session: undefined } });
  const resolved = resolveExactHerdrTarget(tuple.target, parseHerdrAgentList(agentList([
    agent("one"),
    agent("two", { pane_id: "w2:p2", terminal_id: "term-two", agent_session: { value: SESSION } }),
  ])));
  assert.deepEqual(resolved, { ok: false, reason: "AMBIGUOUS_PHYSICAL_TARGET", count: 2 });
});

test("T04 zero eligible panes fail closed without selecting an alternate", () => {
  const tuple = waitTuple();
  const resolved = resolveExactHerdrTarget(tuple.target, parseHerdrAgentList(agentList([
    agent("wrong", { pane_id: "w2:p3", agent_session: { value: "wrong-session" } }),
  ])));
  assert.deepEqual(resolved, { ok: false, reason: "NO_ELIGIBLE_PHYSICAL_TARGET", count: 0 });
});

test("T05 stale pane/session between list and prompt fails closed with no blind alternate", async () => {
  const tuple = waitTuple();
  let listCalls = 0;
  let promptCalls = 0;
  const prompter = createHerdrPrompter({
    exec: async (_exe, args) => {
      if (args[1] === "list") {
        listCalls += 1;
        return { stdout: agentList([agent("target", listCalls === 1 ? {} : { agent_session: { value: "new-session" } })]) };
      }
      promptCalls += 1;
      return { stdout: "{}" };
    },
  });
  await assert.rejects(prompter.prompt(tuple.target, "pointer"), (error) => error.code === "STALE_PHYSICAL_TARGET");
  assert.equal(listCalls, 2);
  assert.equal(promptCalls, 0);
});

test("T06 forbidden task-bound pane is excluded from exact resolution", () => {
  const tuple = waitTuple({ target: { ...waitTuple().target, forbidden_pane_ids: ["w2:p1"] } });
  const resolved = resolveExactHerdrTarget(tuple.target, parseHerdrAgentList(agentList([agent()])));
  assert.deepEqual(resolved, { ok: false, reason: "NO_ELIGIBLE_PHYSICAL_TARGET", count: 0 });
});

test("T07 duplicate durable delivery is NO_OP_DUPLICATE and prompt count stays one", async () => {
  const tuple = waitTuple();
  const body = decisionBody();
  const logicalKey = buildLogicalEventKey(tuple, parseControlDecision(body));
  const prompts = [];
  const published = [];
  const herdr = { prompt: async () => { prompts.push(1); return { accepted: true }; } };
  const publishReceipt = async (receipt) => { published.push(receipt); return { id: 5467000010 }; };
  const first = await deliverResumeOnce({ waitTuple: tuple, decisionBody: body, comments: [], herdr, publishReceipt });
  assert.equal(first.decision, "DELIVERED");
  const second = await deliverResumeOnce({
    waitTuple: tuple,
    decisionBody: body,
    comments: [{ id: 5467000010, body: deliveryReceipt(logicalKey) }],
    herdr,
    publishReceipt,
  });
  assert.equal(second.decision, "NO_OP_DUPLICATE");
  assert.equal(prompts.length, 1);
  assert.equal(published.length, 1);
});

test("T08 uncertain prompt outcome publishes NO_BLIND_RETRY and rerun is duplicate-safe", async () => {
  const tuple = waitTuple();
  const body = decisionBody();
  const published = [];
  const publishReceipt = async (receipt) => { published.push(receipt); return { id: 5467000020 }; };
  const first = await deliverResumeOnce({
    waitTuple: tuple,
    decisionBody: body,
    comments: [],
    herdr: { prompt: async () => { throw Object.assign(new Error("send uncertain"), { code: "SENDER_UNCERTAIN" }); } },
    publishReceipt,
  });
  assert.equal(first.decision, "NO_BLIND_RETRY");
  assert.equal(published[0].state, "UNCERTAIN_SEND");
  const second = await deliverResumeOnce({ waitTuple: tuple, decisionBody: body, comments: [{ id: 5467000020, body: deliveryReceipt(first.logical_key, { state: "UNCERTAIN_SEND" }) }], herdr: { prompt: async () => { throw new Error("must not retry"); } }, publishReceipt });
  assert.equal(second.decision, "NO_OP_DUPLICATE");
});

test("T09 retired or wrong Control generation never delivers", () => {
  const tuple = waitTuple();
  assert.equal(matchWaitToDecision(tuple, parseControlDecision(decisionBody({ generation: 6 }))).reason, "WRONG_GENERATION");
  assert.equal(matchWaitToDecision(tuple, parseControlDecision(decisionBody({ generation: 7, sourceGeneration: 6 }))).reason, "WRONG_SOURCE_GENERATION");
});

test("T10 malformed or conflicting Control decision fails closed", () => {
  const tuple = waitTuple();
  assert.equal(matchWaitToDecision(tuple, parseControlDecision("NOT_CONTROL_DECISION")).ok, false);
  assert.equal(matchWaitToDecision(tuple, parseControlDecision(decisionBody({ cardId: "OTHER-CARD" }))).ok, false);
});

test("T11 missing future consumer binding cannot claim autonomous ready", () => {
  assert.deepEqual(classifyFutureConsumerBinding(null), {
    state: "CONTROL_REQUIRED_FUTURE_CONSUMER_BINDING_MISSING",
    bound: false,
  });
});

test("T12 an open LLM/process is not a future consumer binding", () => {
  assert.equal(classifyFutureConsumerBinding({ resident: false, restartable: false, process_alive: true }).bound, false);
  assert.equal(classifyFutureConsumerBinding({ resident: true, restartable: true, source: "existing-supervisor", event_classes: ["CONTROL_DECISION_V1"] }).bound, true);
});

test("T13 delivery evidence carries exact physical pane/session/runtime identity", async () => {
  const tuple = waitTuple();
  let published;
  const result = await deliverResumeOnce({
    waitTuple: tuple,
    decisionBody: decisionBody(),
    comments: [],
    herdr: { prompt: async () => ({ accepted: true, runtime: "herdr 0.8", workspace_id: "w2", pane_id: "w2:p1", agent_session: SESSION }) },
    publishReceipt: async (receipt) => { published = receipt; return { id: 5467000030 }; },
  });
  assert.equal(result.decision, "DELIVERED");
  assert.equal(published.target_herdr_pane_id, "w2:p1");
  assert.equal(published.target_herdr_agent_session, SESSION);
  assert.equal(published.herdr_evidence.runtime, "herdr 0.8");
});

test("T14 Control-return binding resolves current ACTIVE #88, not stale display identity", () => {
  const current = `CONTROL_GENERATION_SWITCH_V1

new_generation: 007
new_conversation_id: active-007
new_generation_status: ACTIVE
`;
  assert.deepEqual(resolveActiveControlBinding(current), { ok: true, generation: 7, conversation_id: "active-007" });
  assert.equal(resolveActiveControlBinding(current.replace("new_generation_status: ACTIVE", "new_generation_status: RETIRED")).ok, false);
});

test("T15 protocol constant and delivery receipt duplicate parser remain exact", () => {
  assert.equal(HERDR_RESUME_DELIVERY_PROTOCOL, "HERDR_RESUME_DELIVERY_V1");
  const tuple = waitTuple();
  const key = buildLogicalEventKey(tuple, parseControlDecision(decisionBody()));
  assert.equal(findExistingDelivery([{ id: 5467000040, body: deliveryReceipt(key) }], key).receipt_id, 5467000040);
});
