import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReviewRoute,
  isValidDurableResultPointer,
} from "../src/review_router.mjs";

const route = {
  worker_family: "deepseek",
  primary_reviewer: { id: "fresh-chatgpt", family: "openai" },
  secondary_reviewer: { id: "kimi-cli", family: "moonshot" },
  primary_transport: "CONNECTOR",
  secondary_transport: "CLI",
  web_external_review: "OPTIONAL",
  cross_family_required: true,
};

const availableResults = {
  primary: { available: true },
  secondary: { available: true },
};

function evaluate(overrides = {}, resultOverrides = {}) {
  return evaluateReviewRoute(
    { ...route, ...overrides },
    { ...availableResults, ...resultOverrides },
  );
}

const validPointer = {
  repository: "D22977/gpt-browser-bridge",
  card_id: "REVIEW-ROUTER-01",
  reviewer: { id: "kimi-cli", family: "moonshot", transport: "CLI" },
  receipt_id: "5230256787",
  decision: "PASS",
};

test("OPTIONAL web unavailable does not block a valid cross-family CLI route", () => {
  assert.equal(evaluate().decision, "COMPLETE");
});

test("same-family secondary blocks when cross-family review is required", () => {
  const result = evaluate({
    secondary_reviewer: { id: "deepseek-cli", family: "deepseek" },
  });
  assert.equal(result.decision, "BLOCKED");
});

test("missing primary result blocks", () => {
  assert.equal(evaluate({}, { primary: null }).decision, "BLOCKED");
});

test("missing secondary result blocks", () => {
  assert.equal(evaluate({}, { secondary: null }).decision, "BLOCKED");
});

test("missing REQUIRED web result blocks", () => {
  assert.equal(evaluate({ web_external_review: "REQUIRED" }).decision, "BLOCKED");
});

test("missing OPTIONAL web result completes when other gates pass", () => {
  assert.equal(evaluate({}, { web: null }).decision, "COMPLETE");
});

test("DISABLED web mode ignores missing web result", () => {
  assert.equal(evaluate({ web_external_review: "DISABLED" }, { web: null }).decision, "COMPLETE");
});

test("unknown transport blocks", () => {
  assert.equal(evaluate({ primary_transport: "BROWSER" }).decision, "BLOCKED");
});

test("unknown web mode blocks", () => {
  assert.equal(evaluate({ web_external_review: "MAYBE" }).decision, "BLOCKED");
});

test("malformed durable result pointer is rejected", () => {
  assert.equal(isValidDurableResultPointer({ ...validPointer, receipt_id: "" }), false);
});

test("valid durable result pointer is accepted", () => {
  assert.equal(isValidDurableResultPointer(validPointer), true);
});
