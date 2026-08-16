import test from "node:test";
import assert from "node:assert/strict";

import {
  HERDR_RESUME_DELIVERY_PROTOCOL,
  buildLogicalEventKey,
  createGhReader,
  createHerdrPrompter,
  deliverResumeOnce,
  findExistingDelivery,
  matchWaitToDecision,
  parseControlDecision,
  parseReceiptRef,
  validateWaitTuple,
} from "../src/adapters/herdr_resume.mjs";

const SOURCE_RECEIPT = 5307312987;
const GENERATION = 2;
const CARD_ID = "HERDR-NATIVE-REGISTERED-WATCH-AI70-ADMISSION-01";

function waitTuple(overrides = {}) {
  return {
    source_terminal_receipt: SOURCE_RECEIPT,
    control_generation: GENERATION,
    card_id: CARD_ID,
    allowed_action_class: "RUNTIME_ADMISSION_OPERATOR",
    target: {
      agent_name: "LUNA_CLI_HERDR_W1",
      executor_instance_id: "LUNA_CLI_HERDR_W1_01",
      surface: "CLI",
      herdr_agent: "w1",
    },
    ...overrides,
  };
}

function decisionBody(overrides = {}) {
  return `CONTROL_DECISION_V1

state: EXECUTE_NOW
control_generation: ${overrides.generation ?? GENERATION}
decision_topic: TEST_RESUME

SOURCE_BINDING
source_terminal_receipt: D22977/gpt-browser-bridge Issue #43 receipt ${overrides.sourceReceipt ?? SOURCE_RECEIPT}
source_terminal_state: WAIT_CONTROL_DECISION
source_control_generation: ${overrides.sourceGeneration ?? GENERATION}
resume_card: D22977/gpt-browser-bridge Issue #43 receipt 5307351523
resume_card_id: ${overrides.cardId ?? CARD_ID}

EXACT_TARGET
executor_role: RUNTIME_ADMISSION_OPERATOR
agent_name: ${overrides.agentName ?? "LUNA_CLI_HERDR_W1"}
executor_instance_id: ${overrides.instanceId ?? "LUNA_CLI_HERDR_W1_01"}
surface: ${overrides.surface ?? "CLI"}
minimal_wake: Read GitHub directly. D22977/gpt-browser-bridge Issue #43 receipt 5307351523. Execute only that existing bounded native-watch admission card; publish/read-back its required result; do not invent a replacement.
`;
}

function decisionReceipt(logicalKey, id = 5309000001) {
  return `HERDR_RESUME_DELIVERY_V1
state: TERMINAL
decision: DELIVERED
logical_event_key: ${logicalKey}
delivery_count: 1
`;
}

test("parseReceiptRef extracts repo/issue/receipt id and rejects garbage", () => {
  assert.deepEqual(parseReceiptRef("D22977/gpt-browser-bridge Issue #43 receipt 5307312987"), {
    repo: "D22977/gpt-browser-bridge",
    issue: 43,
    receipt_id: 5307312987,
  });
  assert.equal(parseReceiptRef("not a ref"), null);
  assert.equal(parseReceiptRef(null), null);
});

test("validateWaitTuple accepts a complete tuple and rejects malformed ones", () => {
  assert.equal(validateWaitTuple(waitTuple()).ok, true);
  assert.equal(validateWaitTuple({ ...waitTuple(), control_generation: "two" }).ok, false);
  assert.equal(validateWaitTuple({ ...waitTuple(), target: { ...waitTuple().target, herdr_agent: "" } }).ok, false);
  assert.equal(validateWaitTuple(null).ok, false);
});

test("parseControlDecision binds exact source terminal, generation, card, and target", () => {
  const parsed = parseControlDecision(decisionBody());
  assert.equal(parsed.ok, true);
  const d = parsed.decision;
  assert.equal(d.state, "EXECUTE_NOW");
  assert.equal(d.control_generation, GENERATION);
  assert.equal(d.source_terminal_receipt_id, SOURCE_RECEIPT);
  assert.equal(d.source_control_generation, GENERATION);
  assert.equal(d.resume_card_id, CARD_ID);
  assert.equal(d.target.agent_name, "LUNA_CLI_HERDR_W1");
  assert.equal(d.target.executor_instance_id, "LUNA_CLI_HERDR_W1_01");
  assert.equal(d.target.surface, "CLI");
  assert.match(d.minimal_wake, /5307351523/);
});

test("matchWaitToDecision accepts the exact valid decision and yields the minimal wake pointer", () => {
  const matched = matchWaitToDecision(waitTuple(), parseControlDecision(decisionBody()));
  assert.equal(matched.ok, true);
  assert.match(matched.pointer, /Read GitHub directly/);
});

test("matchWaitToDecision rejects wrong generation, source, card, and target fail-closed", () => {
  const base = waitTuple();
  const reject = (body) => {
    const m = matchWaitToDecision(base, parseControlDecision(body));
    assert.equal(m.ok, false, `expected rejection: ${m.reason}`);
    return m;
  };
  assert.equal(reject(decisionBody({ generation: 3 })).reason, "WRONG_GENERATION");
  assert.equal(reject(decisionBody({ sourceGeneration: 3 })).reason, "WRONG_SOURCE_GENERATION");
  assert.equal(reject(decisionBody({ sourceReceipt: 9999999999 })).reason, "WRONG_SOURCE_TERMINAL");
  assert.equal(reject(decisionBody({ cardId: "OTHER-CARD" })).reason, "WRONG_CARD");
  assert.equal(reject(decisionBody({ agentName: "LUNA_CLI_HERDR_W2" })).reason, "WRONG_TARGET_AGENT");
  assert.equal(reject(decisionBody({ instanceId: "LUNA_CLI_HERDR_W1_99" })).reason, "WRONG_TARGET_INSTANCE");
  assert.equal(reject(decisionBody({ surface: "DESKTOP" })).reason, "WRONG_TARGET_SURFACE");
});

test("matchWaitToDecision rejects malformed and conflicting decisions fail-closed", () => {
  const base = waitTuple();
  assert.equal(matchWaitToDecision(base, parseControlDecision("NOT_A_DECISION")).reason, "NOT_CONTROL_DECISION_V1");
  const noGeneration = decisionBody().replace(/control_generation:\s*2/, "control_generation: nope");
  assert.equal(matchWaitToDecision(base, parseControlDecision(noGeneration)).reason, "MISSING_CONTROL_GENERATION");
  const notExecute = decisionBody().replace("state: EXECUTE_NOW", "state: WAIT_CONTROL_DECISION");
  assert.equal(matchWaitToDecision(base, parseControlDecision(notExecute)).reason, "DECISION_NOT_EXECUTE_NOW");
  const noPointer = decisionBody().replace(/minimal_wake:.*$/m, "wake_action: ");
  assert.equal(matchWaitToDecision(base, parseControlDecision(noPointer)).reason, "MISSING_WAKE_POINTER");
  assert.equal(matchWaitToDecision(base, parseControlDecision("")).reason, "NOT_CONTROL_DECISION_V1");
});

test("buildLogicalEventKey is deterministic and findExistingDelivery detects a prior receipt", () => {
  const wt = waitTuple();
  const parsed = parseControlDecision(decisionBody());
  const key = buildLogicalEventKey(wt, parsed);
  assert.equal(key, `${SOURCE_RECEIPT}|${GENERATION}|${CARD_ID}|LUNA_CLI_HERDR_W1|LUNA_CLI_HERDR_W1_01`);
  assert.equal(buildLogicalEventKey(wt, parsed), key);
  assert.equal(findExistingDelivery([], key), null);
  assert.deepEqual(
    findExistingDelivery([{ id: 5309000001, body: decisionReceipt(key) }], key),
    { receipt_id: 5309000001, created_at: null }
  );
  assert.equal(findExistingDelivery([{ id: 5309000001, body: decisionReceipt("OTHER|KEY") }], key), null);
});

test("deliverResumeOnce delivers exactly one physical prompt then NO_OP_DUPLICATE on rerun", async () => {
  const wt = waitTuple();
  const body = decisionBody();
  const comments = [];
  const prompts = [];
  const published = [];
  const herdr = {
    prompt: async (agent, text) => {
      prompts.push({ agent, text });
      return { accepted: true, agent };
    },
  };
  const publishReceipt = async (receipt) => {
    published.push(receipt);
    return { id: 5309000009 };
  };

  const first = await deliverResumeOnce({ waitTuple: wt, decisionBody: body, comments, herdr, publishReceipt });
  assert.equal(first.decision, "DELIVERED");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].agent, "w1");
  assert.equal(published.length, 1);
  assert.equal(published[0].delivery_count, 1);
  assert.equal(published[0].target_herdr_agent, "w1");

  const commentsWithReceipt = [...comments, { id: 5309000009, body: decisionReceipt(first.logical_key) }];
  const second = await deliverResumeOnce({
    waitTuple: wt,
    decisionBody: body,
    comments: commentsWithReceipt,
    herdr,
    publishReceipt,
  });
  assert.equal(second.decision, "NO_OP_DUPLICATE");
  assert.equal(prompts.length, 1, "no second Herdr prompt on duplicate");
  assert.equal(published.length, 1, "no second publish on duplicate");
});

test("deliverResumeOnce never prompts on a non-applicable decision", async () => {
  const prompts = [];
  const published = [];
  const result = await deliverResumeOnce({
    waitTuple: waitTuple(),
    decisionBody: decisionBody({ generation: 9 }),
    comments: [],
    herdr: { prompt: async () => { prompts.push(1); return {}; } },
    publishReceipt: async (r) => { published.push(r); return { id: 1 }; },
  });
  assert.equal(result.decision, "REJECTED");
  assert.equal(result.reason, "WRONG_GENERATION");
  assert.equal(prompts.length, 0);
  assert.equal(published.length, 0);
});

test("createHerdrPrompter and createGhReader wire the real CLI boundaries", async () => {
  const herdrCalls = [];
  const ghCalls = [];
  const herdr = createHerdrPrompter({
    herdrExe: "C:\\fake\\herdr.exe",
    exec: async (exe, args) => { herdrCalls.push({ exe, args }); return { stdout: "{}" }; },
  });
  await herdr.prompt("w1", "pointer");
  assert.equal(herdrCalls[0].args[0], "agent");
  assert.equal(herdrCalls[0].args[1], "prompt");
  assert.equal(herdrCalls[0].args[2], "w1");

  const gh = createGhReader({
    gh: "gh",
    exec: async (exe, args) => {
      ghCalls.push(args);
      if (args.some((a) => String(a).includes("comments/123"))) {
        return { stdout: 'CONTROL_DECISION_V1\n\nstate: EXECUTE_NOW\n' };
      }
      return { stdout: "[]" };
    },
  });
  const body = await gh.readDecisionBody({ repo: "D22977/gpt-browser-bridge", receiptId: 123 });
  assert.match(body, /CONTROL_DECISION_V1/);
  assert.ok(ghCalls.some((args) => args.some((a) => String(a).includes("issues/comments/123"))));
});

test("default protocol constant matches the receipt protocol", () => {
  assert.equal(HERDR_RESUME_DELIVERY_PROTOCOL, "HERDR_RESUME_DELIVERY_V1");
});
