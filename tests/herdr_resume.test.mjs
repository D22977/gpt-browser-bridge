import test from "node:test";
import assert from "node:assert/strict";

import {
  captureCreatedCandidate,
  classifyHerdrSendState,
  enumerateExistingCandidate,
  resolveFreshHerdrTarget,
  sendToFreshHerdrTarget,
} from "../src/adapters/herdr_resume.mjs";

const PROJECT = "D22977/gpt-browser-bridge";
const GENERATION = "010";
const CANDIDATE_ID = "6a9c2234-f4b4-83ee-ba4b-82c3ee3a2562";
const CANDIDATE_URL = `https://chatgpt.com/c/${CANDIDATE_ID}`;

function candidateTab(id = CANDIDATE_ID, overrides = {}) {
  return {
    url: `https://chatgpt.com/c/${id}`,
    project_marker: PROJECT,
    generation_marker: "generation010",
    title: "控制塔 candidate",
    ...overrides,
  };
}

function herdrAgent(overrides = {}) {
  return {
    agent: "codex",
    agent_status: "idle",
    pane_id: "w2:p1",
    agent_session: { value: "fresh-session" },
    cwd: "C:\\WINDOWS\\system32",
    name: "generic-worker",
    ...overrides,
  };
}

test("captureCreatedCandidate records location.href and exact conversation id", () => {
  assert.deepEqual(captureCreatedCandidate({
    locationHref: CANDIDATE_URL,
    projectMarker: PROJECT,
    generation: GENERATION,
    observedProjectMarker: PROJECT,
    observedGenerationMarker: "generation010",
  }), {
    ok: true,
    candidate: {
      conversation_id: CANDIDATE_ID,
      conversation_url: CANDIDATE_URL,
      source: "location.href",
    },
  });
});

test("candidate capture rejects prompt-prose identity and marker mismatch", () => {
  assert.equal(captureCreatedCandidate({
    locationHref: "not a URL",
    projectMarker: PROJECT,
    generation: GENERATION,
    observedProjectMarker: PROJECT,
    observedGenerationMarker: "generation010",
  }).reason, "CANDIDATE_URL_INVALID");

  assert.equal(captureCreatedCandidate({
    locationHref: CANDIDATE_URL,
    projectMarker: PROJECT,
    generation: GENERATION,
    observedProjectMarker: PROJECT,
    observedGenerationMarker: "generation009",
  }).reason, "CANDIDATE_GENERATION_MARKER_MISMATCH");

  assert.equal(captureCreatedCandidate({
    locationHref: CANDIDATE_URL,
    projectMarker: PROJECT,
    generation: GENERATION,
    expectedId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    observedProjectMarker: PROJECT,
    observedGenerationMarker: "generation010",
  }).reason, "CANDIDATE_ID_MISMATCH");
});

test("existing candidate enumeration uses mechanical URL and markers, not title", () => {
  const result = enumerateExistingCandidate([
    candidateTab(CANDIDATE_ID, { title: "untrusted locator" }),
    candidateTab("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      generation_marker: "generation009",
      title: "控制塔-010",
    }),
  ], { projectMarker: PROJECT, generation: GENERATION });

  assert.equal(result.ok, true);
  assert.equal(result.candidate.conversation_id, CANDIDATE_ID);
  assert.equal(result.candidate.conversation_url, CANDIDATE_URL);
  assert.equal(result.candidate.source, "mechanically_observed_location");
});

test("zero or multiple eligible candidates fail closed and allowlist cannot invent identity", () => {
  assert.equal(enumerateExistingCandidate([], { projectMarker: PROJECT, generation: GENERATION }).reason,
    "CANDIDATE_COUNT_ZERO");

  assert.equal(enumerateExistingCandidate([
    candidateTab(),
    candidateTab("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  ], { projectMarker: PROJECT, generation: GENERATION }).reason, "CANDIDATE_COUNT_MULTIPLE");

  assert.equal(enumerateExistingCandidate([
    candidateTab("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  ], { projectMarker: PROJECT, generation: GENERATION, allowedIds: [CANDIDATE_ID] }).reason,
    "CANDIDATE_COUNT_ZERO");
});

test("fresh Herdr resolution ignores stale pane/session and rejects zero or multiple matches", () => {
  const current = herdrAgent({
    pane_id: "w2:p4",
    agent_session: { value: "rebooted-session" },
  });
  const resolved = resolveFreshHerdrTarget([current], {
    cwd: "C:\\WINDOWS\\system32",
    historicalBinding: { pane_id: "w2:p1", agent_session: "old-session" },
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.target.pane_id, "w2:p4");
  assert.equal(resolved.target.agent_session, "rebooted-session");
  assert.equal(resolved.stale_binding_ignored, true);

  assert.equal(resolveFreshHerdrTarget([], { cwd: "C:\\WINDOWS\\system32" }).reason,
    "HERDR_TARGET_COUNT_ZERO");
  assert.equal(resolveFreshHerdrTarget([
    herdrAgent(),
    herdrAgent({ pane_id: "w2:p4", agent_session: { value: "other" } }),
  ], { cwd: "C:\\WINDOWS\\system32" }).reason, "HERDR_TARGET_COUNT_MULTIPLE");
});

test("every send re-enumerates Herdr and binds the actual pane/session once", async () => {
  let listCalls = 0;
  const prompts = [];
  const inventory = [herdrAgent()];
  const listAgents = async () => {
    listCalls += 1;
    return inventory;
  };
  const prompt = async (target, text) => {
    prompts.push({ target, text });
    return { accepted: true };
  };

  const first = await sendToFreshHerdrTarget({ listAgents, prompt, text: "wake-1" });
  const second = await sendToFreshHerdrTarget({ listAgents, prompt, text: "wake-2" });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(listCalls, 2);
  assert.deepEqual(prompts.map((entry) => [entry.target.pane_id, entry.target.agent_session]), [
    ["w2:p1", "fresh-session"],
    ["w2:p1", "fresh-session"],
  ]);
});

test("one-shot send state is duplicate-safe and fail-closed", () => {
  assert.deepEqual(classifyHerdrSendState("SENT"), {
    decision: "NO_OP_DUPLICATE",
    second_prompt_sent: false,
  });
  assert.deepEqual(classifyHerdrSendState("SENDING"), {
    decision: "UNCERTAIN_SEND_NO_BLIND_RETRY",
    second_prompt_sent: false,
  });
  assert.deepEqual(classifyHerdrSendState("mystery"), {
    decision: "CONTROL_REQUIRED_UNKNOWN_STATE",
    second_prompt_sent: false,
  });
});
