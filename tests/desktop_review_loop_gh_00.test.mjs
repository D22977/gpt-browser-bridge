import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReadyReceipt } from "../src/desktop_review_loop_gh_00.mjs";

const SHA = "a".repeat(40);

function validReceipt(overrides = {}) {
  return {
    card_id: "DESKTOP-REVIEW-LOOP-GH-00",
    round: 1,
    task_id: "TASK-A",
    repo: "D22977/gpt-browser-bridge",
    exact_base_sha: SHA,
    candidate_head_sha: "b".repeat(40),
    changed_paths: ["src/desktop_review_loop_gh_00.mjs"],
    tests_run: ["npm test"],
    desktop_agent_identity: "CODEX_DESKTOP_AGENT",
    manual_relay_count: 0,
    request_fresh_reviewer: true,
    ...overrides,
  };
}

test("DESKTOP-REVIEW-LOOP-GH-00 accepts a valid READY receipt", () => {
  assert.equal(validateReadyReceipt(validReceipt()), true);
});

test("DESKTOP-REVIEW-LOOP-GH-00 rejects a wrong card", () => {
  assert.equal(validateReadyReceipt(validReceipt({ card_id: "OTHER" })), false);
});

test("DESKTOP-REVIEW-LOOP-GH-00 rejects a non-positive round", () => {
  assert.equal(validateReadyReceipt(validReceipt({ round: 0 })), false);
});

test("DESKTOP-REVIEW-LOOP-GH-00 rejects an empty task id", () => {
  assert.equal(validateReadyReceipt(validReceipt({ task_id: "" })), false);
});

test("DESKTOP-REVIEW-LOOP-GH-00 rejects a wrong repository", () => {
  assert.equal(validateReadyReceipt(validReceipt({ repo: "other/repo" })), false);
});

test("DESKTOP-REVIEW-LOOP-GH-00 rejects malformed commit SHAs", () => {
  assert.equal(validateReadyReceipt(validReceipt({ exact_base_sha: "not-a-sha" })), false);
  assert.equal(validateReadyReceipt(validReceipt({ candidate_head_sha: "a".repeat(39) })), false);
});

test("DESKTOP-REVIEW-LOOP-GH-00 rejects empty changed paths", () => {
  assert.equal(validateReadyReceipt(validReceipt({ changed_paths: [] })), false);
});

test("DESKTOP-REVIEW-LOOP-GH-00 rejects empty test commands", () => {
  assert.equal(validateReadyReceipt(validReceipt({ tests_run: [] })), false);
});

test("DESKTOP-REVIEW-LOOP-GH-00 rejects a wrong Desktop identity", () => {
  assert.equal(validateReadyReceipt(validReceipt({ desktop_agent_identity: "OTHER_AGENT" })), false);
});

test("DESKTOP-REVIEW-LOOP-GH-00 rejects manual review-result relay", () => {
  assert.equal(validateReadyReceipt(validReceipt({ manual_relay_count: 1 })), false);
});

test("DESKTOP-REVIEW-LOOP-GH-00 rejects a request without a fresh reviewer", () => {
  assert.equal(validateReadyReceipt(validReceipt({ request_fresh_reviewer: false })), false);
});

test("DESKTOP-REVIEW-LOOP-GH-00 rejects malformed receipts", () => {
  assert.equal(validateReadyReceipt(null), false);
  assert.equal(validateReadyReceipt("not-an-object"), false);
});
