import { test } from "node:test";
import assert from "node:assert/strict";

const { parseActiveControlAuthority } = await import("../src/g34_contract.mjs").catch(() => ({}));

const activeId = "6ac3b22a-a830-83ee-bd71-85838e5f1392";

function record(id, issue_number, fields) {
  const marker = fields.marker;
  const entries = Object.entries(fields).filter(([key]) => key !== "marker");
  return {
    id,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/${issue_number}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/D22977/gpt-browser-bridge/issues/${issue_number}`,
    user: { login: "D22977" },
    body: [marker, ...entries.map(([key, value]) => `${key}: ${value}`)].filter(Boolean).join("\n"),
  };
}

function assertImplemented() {
  assert.equal(typeof parseActiveControlAuthority, "function", "authority parser is not implemented");
}

function authority(overrides = {}) {
  return {
    switchReceipt: structuredClone(realSwitch),
    index43: structuredClone(realStartIndex),
    index81: structuredClone(realRegistryIndex),
    rehydrationAck: structuredClone(realAck),
    ...overrides,
  };
}

test("G34 authority export exists", () => {
  assert.equal(typeof parseActiveControlAuthority, "function");
});

test("authority accepts only the current generation 034 switch, indexes, and ACK", () => {
  assertImplemented();
  assert.deepEqual(parseActiveControlAuthority(authority()), {
    control_generation: "034",
    active_control_id: activeId,
    control_conversation_id: activeId,
    active_control_github_login: "D22977",
    source_comment_ids: {
      switch: "5997153160", index43: "5997180468", index81: "5997189759", rehydration_ack: "5997220300",
    },
  });
});

test("authority fails closed on G14, null identity, stale index, or duplicate fields", () => {
  assertImplemented();
  const g14 = authority();
  g14.switchReceipt.body = g14.switchReceipt.body.replace("034", "014");
  assert.throws(() => parseActiveControlAuthority(g14));

  const nullId = authority();
  nullId.switchReceipt.body = nullId.switchReceipt.body.replace(activeId, "null");
  assert.throws(() => parseActiveControlAuthority(nullId));

  const stale = authority();
  stale.index81.body = stale.index81.body.replace("control_generation: 034 ACTIVE", "control_generation: 033 ACTIVE");
  assert.throws(() => parseActiveControlAuthority(stale));

  const duplicate = authority();
  duplicate.switchReceipt.body += `\nconversation_id: ${activeId}`;
  assert.throws(() => parseActiveControlAuthority(duplicate));

  const wrongPointer = authority();
  wrongPointer.index43.url = wrongPointer.index43.url.replace("5997180468", "99");
  assert.throws(() => parseActiveControlAuthority(wrongPointer));
});
function githubComment(id, issue, body) {
  return {
    id,
    url: "https://github.com/D22977/gpt-browser-bridge/issues/" + issue + "#issuecomment-" + id,
    issue_url: "https://api.github.com/repos/D22977/gpt-browser-bridge/issues/" + issue,
    user: { login: "D22977" },
    body,
  };
}

const realSwitch = githubComment(5997153160, 88, [
  "CONTROL_GENERATION_ATOMIC_SWITCH_V1",
  "state: ACTIVE_SWITCH_COMMITTED_READBACK_REQUIRED",
  "repository: D22977/gpt-browser-bridge",
  "",
  "OLD_CONTROL",
  "generation: 033",
  "status_before: SOLE_ACTIVE_UNTIL_VALID_ATOMIC_SWITCH",
  "status_after: RETIRED",
  "conversation_id: 6abd98f5-5808-83e8-852c-f01a16cebf24",
  "",
  "NEW_CONTROL",
  "generation: 034",
  "display_name: 控制塔-034",
  "status_before: CANDIDATE_ACKED_CONTINUITY_ROUTE_PROVEN_URL_CORRECTED_R3_V2_PASS_NOT_ACTIVE",
  "status_after: ACTIVE",
  "conversation_id: " + activeId,
  "single_active_control: true",
].join("\n"));

const realAck = githubComment(5997220300, 88, [
  "ACTIVE_CONTROL_REHYDRATION_ACK_V1",
  "state: ACTIVE_REHYDRATED_ACKNOWLEDGED",
  "repository: D22977/gpt-browser-bridge",
  "issue: 88",
  "generation: 034",
  "conversation_id: " + activeId,
  "",
  "ACTIVE_STATE",
  "sole_active_control_generation: 034",
  "sole_active_control_identity_match: true",
  "old033_status: RETIRED",
  "generation032_status: EXHAUSTED_NEVER_ACTIVE",
  "single_active_control: true",
  "state_pointer_consistency: matched",
].join("\n"));

const realStartIndex = githubComment(5997180468, 43, [
  "CURRENT_REHYDRATION_INDEX_V246",
  "state: CURRENT_START_HERE_ACTIVE_CONTROL034_SWITCHED_AWAITING_ACTIVE_REHYDRATION_ACK",
  "recorded_by_role: LOCAL_CONTROL_TRANSPORT",
  "repository: D22977/gpt-browser-bridge",
  "control_generation: 034 ACTIVE",
  "atomic_switch: #88/5997153160 exact GET matched",
  "single_active_control: true",
  "active_control_id: " + activeId,
  "",
  "CURRENT_CONTROL",
  "generation: 034",
  "display_name: 控制塔-034",
  "conversation_id: " + activeId,
  "034_status: ACTIVE_SWITCH_COMMITTED_AWAITING_OWN_REHYDRATION_ACK",
].join("\n"));

const realRegistryIndex = githubComment(5997189759, 81, [
  "CURRENT_REGISTRY_INDEX_V142",
  "state: CURRENT_ACTIVE_CONTROL034_SWITCHED_AWAITING_ACTIVE_REHYDRATION_ACK",
  "recorded_by_role: LOCAL_CONTROL_TRANSPORT",
  "repository: D22977/gpt-browser-bridge",
  "control_generation: 034 ACTIVE",
  "current_start: #43/5997180468 V246 exact GET matched",
  "atomic_switch: #88/5997153160 exact GET matched",
  "active_control_id: " + activeId,
  "033_RETIRED: true",
  "032_EXHAUSTED_NEVER_ACTIVE: true",
  "single_active_control: true",
].join("\n"));

test("authority parses exact sectioned GitHub switch and ACK GET records without synthetic identity fields", () => {
  assertImplemented();
  const parsed = parseActiveControlAuthority({
    switchReceipt: realSwitch, index43: realStartIndex, index81: realRegistryIndex, rehydrationAck: realAck,
  });
  assert.equal(parsed.active_control_id, activeId);
  assert.equal(parsed.source_comment_ids.switch, "5997153160");
  assert.equal(parsed.source_comment_ids.rehydration_ack, "5997220300");
});

test("authority rejects duplicate fields within a section and inconsistent GitHub comment URL identity", () => {
  assertImplemented();
  const duplicate = { ...realSwitch, body: realSwitch.body.replace("generation: 034", "generation: 033\ngeneration: 034") };
  assert.throws(() => parseActiveControlAuthority({
    switchReceipt: duplicate, index43: realStartIndex, index81: realRegistryIndex, rehydrationAck: realAck,
  }), /duplicate/i);
  const wrongCommentUrl = { ...realAck, url: realAck.url.replace("5997220300", "5997220301") };
  assert.throws(() => parseActiveControlAuthority({
    switchReceipt: realSwitch, index43: realStartIndex, index81: realRegistryIndex, rehydrationAck: wrongCommentUrl,
  }), /exact|identity/i);
});
