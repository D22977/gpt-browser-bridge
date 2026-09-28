import assert from "node:assert/strict";
import test from "node:test";

import { createControlTowerMcpServer } from "../../control-tower-mcp/server.mjs";
import { createRuntimeServices } from "../../control-tower-mcp/runtime.mjs";

const expectedToolNames = [
  "bootstrap_project",
  "read_control_state",
  "write_receipt",
  "inspect_worker_wake",
  "wake_worker",
  "run_worker_wake_canary",
  "worker_status",
  "inspect_reviewer_routes",
  "launch_fresh_reviewer",
  "dispatch_batch",
  "recover_wake_consumer",
  "self_test",
];

const inputs = {
  bootstrap_project: { repo: "D22977/gpt-browser-bridge", current_pointer_issue: 43 },
  read_control_state: { repo: "D22977/gpt-browser-bridge", pointer: "issue:43" },
  write_receipt: { repo: "D22977/gpt-browser-bridge", issue: 94, protocol: "TEST_RESULT_V1", payload: { state: "READY" } },
  inspect_worker_wake: {},
  wake_worker: { target: "worker-1", card: "issue:94", idempotency_key: "event-1" },
  run_worker_wake_canary: { target: "worker-1" },
  worker_status: { target: "worker-1" },
  inspect_reviewer_routes: {},
  launch_fresh_reviewer: { review_request: { repo: "D22977/gpt-browser-bridge", head: "9e97548", paths: ["control-tower-mcp/server.mjs"] } },
  dispatch_batch: { cards: [{ repo: "D22977/gpt-browser-bridge", issue: 94 }] },
  recover_wake_consumer: {},
  self_test: {},
};

const invalidInputs = {
  bootstrap_project: { repo: "" },
  read_control_state: { repo: "repo" },
  write_receipt: { repo: "repo", issue: 0, protocol: "P", payload: {} },
  inspect_worker_wake: { unexpected: true },
  wake_worker: { target: "", card: "card", idempotency_key: "key" },
  run_worker_wake_canary: {},
  worker_status: { target: "" },
  inspect_reviewer_routes: { unexpected: true },
  launch_fresh_reviewer: { review_request: "not-an-object" },
  dispatch_batch: { cards: [] },
  recover_wake_consumer: { unexpected: true },
  self_test: { unexpected: true },
};

async function execute(server, name, args = inputs[name]) {
  return server._registeredTools[name].executor(args, {});
}

test("registers exactly the 12 contract tools with valid input schemas", () => {
  const server = createControlTowerMcpServer();
  assert.deepEqual(Object.keys(server._registeredTools), expectedToolNames);

  for (const name of expectedToolNames) {
    const schema = server._registeredTools[name].inputSchema;
    assert.ok(schema, `${name} must declare an input schema`);
    assert.equal(schema.safeParse(inputs[name]).success, true, `${name} accepts a valid input`);
    assert.equal(schema.safeParse(invalidInputs[name]).success, false, `${name} rejects an invalid input`);
  }
});

test("routes each registered tool only through its injected service port", async () => {
  const calls = [];
  const record = (name) => async (input) => {
    calls.push({ name, input });
    return { state: "PASS", operation: name };
  };
  const services = {
    bootstrapProject: record("bootstrapProject"),
    readControlState: record("readControlState"),
    publishReceipt: async (input) => {
      calls.push({ name: "publishReceipt", input });
      return { receipt_id: "receipt-1" };
    },
    readReceipt: async (input) => {
      calls.push({ name: "readReceipt", input });
      return input;
    },
    inspectWorkerWake: record("inspectWorkerWake"),
    wakeWorker: record("wakeWorker"),
    runWorkerWakeCanary: record("runWorkerWakeCanary"),
    workerStatus: record("workerStatus"),
    inspectReviewerRoutes: record("inspectReviewerRoutes"),
    launchFreshReviewer: record("launchFreshReviewer"),
    dispatchBatch: record("dispatchBatch"),
    recoverWakeConsumer: record("recoverWakeConsumer"),
    selfTest: record("selfTest"),
  };
  const server = createControlTowerMcpServer({ services });
  const expectedCalls = {
    bootstrap_project: ["bootstrapProject"],
    read_control_state: ["readControlState"],
    write_receipt: ["publishReceipt", "readReceipt"],
    inspect_worker_wake: ["inspectWorkerWake"],
    wake_worker: ["wakeWorker"],
    run_worker_wake_canary: ["runWorkerWakeCanary"],
    worker_status: ["workerStatus"],
    inspect_reviewer_routes: ["inspectReviewerRoutes"],
    launch_fresh_reviewer: ["launchFreshReviewer"],
    dispatch_batch: ["dispatchBatch"],
    recover_wake_consumer: ["recoverWakeConsumer"],
    self_test: ["selfTest"],
  };

  for (const name of expectedToolNames) {
    calls.length = 0;
    const result = await execute(server, name);
    assert.deepEqual(calls.map((call) => call.name), expectedCalls[name]);
    assert.equal(result.structuredContent.state, "PASS");
    assert.deepEqual(calls[0].input, inputs[name]);
  }
});

test("returns typed blocked results when runtime capabilities are not admitted", async () => {
  const server = createControlTowerMcpServer();

  for (const name of expectedToolNames) {
    const result = await execute(server, name);
    assert.equal(result.structuredContent.state, "BLOCKED", `${name} fails closed`);
    assert.equal(typeof result.structuredContent.code, "string", `${name} includes a typed reason`);
  }
});

test("write_receipt requires a publisher and an exact durable read-back", async () => {
  let publishCount = 0;
  const missingReadBack = createRuntimeServices({
    publishReceipt: async () => {
      publishCount += 1;
      return { receipt_id: "receipt-1" };
    },
  });
  const blocked = await missingReadBack.writeReceipt(inputs.write_receipt);
  assert.equal(blocked.state, "BLOCKED");
  assert.equal(blocked.code, "BLOCKED_RECEIPT_PUBLISHER_OR_READBACK_UNAVAILABLE");
  assert.equal(publishCount, 0);

  const matching = createRuntimeServices({
    publishReceipt: async () => ({ receipt_id: "receipt-1" }),
    readReceipt: async (query) => query,
  });
  assert.deepEqual(await matching.writeReceipt(inputs.write_receipt), {
    state: "PASS",
    receipt_id: "receipt-1",
    read_back: true,
  });

  let storedReceipt;
  const mutatingPublisher = createRuntimeServices({
    publishReceipt: async (request) => {
      request.payload.state = "OTHER";
      storedReceipt = request;
      return { receipt_id: "receipt-1" };
    },
    readReceipt: async (query) => ({ ...structuredClone(storedReceipt), receipt_id: query.receipt_id }),
  });
  const mutationRejected = await mutatingPublisher.writeReceipt(inputs.write_receipt);
  assert.equal(mutationRejected.state, "BLOCKED");
  assert.equal(mutationRejected.code, "BLOCKED_RECEIPT_READBACK_MISMATCH");

  const mismatched = createRuntimeServices({
    publishReceipt: async () => ({ receipt_id: "receipt-1" }),
    readReceipt: async (query) => ({ ...query, payload: { state: "OTHER" } }),
  });
  const rejected = await mismatched.writeReceipt(inputs.write_receipt);
  assert.equal(rejected.state, "BLOCKED");
  assert.equal(rejected.code, "BLOCKED_RECEIPT_READBACK_MISMATCH");
});

test("preserves duplicate no-op outcomes from the injected wake adapter", async () => {
  const seen = new Set();
  let dispatchCount = 0;
  const server = createControlTowerMcpServer({
    services: {
      wakeWorker: async ({ idempotency_key }) => {
        if (seen.has(idempotency_key)) return { state: "NO_OP", code: "DUPLICATE" };
        seen.add(idempotency_key);
        dispatchCount += 1;
        return { state: "DISPATCH_REQUEST_WRITTEN" };
      },
    },
  });

  assert.equal((await execute(server, "wake_worker")).structuredContent.state, "DISPATCH_REQUEST_WRITTEN");
  assert.deepEqual((await execute(server, "wake_worker")).structuredContent, { state: "NO_OP", code: "DUPLICATE" });
  assert.equal(dispatchCount, 1);
});
