import { test } from "node:test";
import assert from "node:assert/strict";

const { parseActiveControlAuthority } = await import("../src/g34_contract.mjs").catch(() => ({}));

const activeId = "6ac3b22a-a830-83ee-bd71-85838e5f1392";

function record(id, issue_number, fields) {
  return { id, pointer_id: id, issue_number, body: Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n") };
}

function assertImplemented() {
  assert.equal(typeof parseActiveControlAuthority, "function", "authority parser is not implemented");
}

function authority(overrides = {}) {
  return {
    switchReceipt: record(10, 88, {
      marker: "CONTROL_GENERATION_ATOMIC_SWITCH_V1",
      transition: "NEW_CONTROL",
      generation: "034",
      conversation_id: activeId,
      status_after: "ACTIVE",
    }),
    index43: record(11, 43, {
      generation: "034",
      status: "ACTIVE",
      active_control_id: activeId,
      single_active_control: "true",
    }),
    index81: record(12, 81, {
      generation: "034",
      status: "ACTIVE",
      active_control_id: activeId,
      single_active_control: "true",
    }),
    rehydrationAck: record(13, 88, {
      marker: "ACTIVE_CONTROL_REHYDRATION_ACK_V1",
      generation: "034",
      active_control_id: activeId,
      conversation_id: activeId,
      status: "ACTIVE",
    }),
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
  stale.index81.body = stale.index81.body.replace("ACTIVE", "STALE");
  assert.throws(() => parseActiveControlAuthority(stale));

  const duplicate = authority();
  duplicate.switchReceipt.body += `\nconversation_id: ${activeId}`;
  assert.throws(() => parseActiveControlAuthority(duplicate));

  const wrongPointer = authority();
  wrongPointer.index43.pointer_id = "99";
  assert.throws(() => parseActiveControlAuthority(wrongPointer));
});
