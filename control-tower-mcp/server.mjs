import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { createGitHubRuntimeServices } from "./github_runtime.mjs";
import { createRuntimeServices } from "./runtime.mjs";

const repo = z.string().min(1);
const issue = z.number().int().positive();
const object = (shape) => z.object(shape).strict();
const empty = object({});
const record = z.record(z.string(), z.unknown());

const tools = [
  ["bootstrap_project", "bootstrapProject", object({ repo, current_pointer_issue: issue.optional() }), "Read repository identity and current Control pointer candidates."],
  ["read_control_state", "readControlState", object({ repo, pointer: z.string().min(1) }), "Read and resolve the current durable Control state."],
  ["write_receipt", "writeReceipt", object({ repo, issue, protocol: z.string().min(1), payload: record }), "Publish a bounded receipt and require exact read-back."],
  ["inspect_worker_wake", "inspectWorkerWake", empty, "Inspect currently admitted Worker wake mechanisms."],
  ["wake_worker", "wakeWorker", object({ target: z.string().min(1), card: z.string().min(1), idempotency_key: z.string().min(1) }), "Request one idempotent Worker wake through an admitted adapter."],
  ["run_worker_wake_canary", "runWorkerWakeCanary", object({ target: z.string().min(1) }), "Run a bounded no-product Worker wake canary."],
  ["worker_status", "workerStatus", object({ target: z.string().min(1) }), "Read the Worker dispatch, consumption, and terminal state."],
  ["inspect_reviewer_routes", "inspectReviewerRoutes", empty, "Inspect currently admitted fresh Reviewer routes."],
  ["launch_fresh_reviewer", "launchFreshReviewer", object({ review_request: record }), "Launch only an admitted independent Reviewer route."],
  ["dispatch_batch", "dispatchBatch", object({ cards: z.array(record).min(1) }), "Dispatch a batch only when all runtime gates are admitted."],
  ["recover_wake_consumer", "recoverWakeConsumer", empty, "Recover only an admitted restart-safe wake consumer."],
  ["self_test", "selfTest", empty, "Run deterministic tests against injected adapters."],
];

function resultFor(value) {
  const result = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : { state: "BLOCKED", code: "BLOCKED_INVALID_SERVICE_RESULT" };
  try {
    const text = JSON.stringify(result);
    if (text !== undefined) return { content: [{ type: "text", text }], structuredContent: result };
  } catch {
    // Return a typed result instead of exposing adapter internals or throwing through MCP.
  }
  const fallback = { state: "BLOCKED", code: "BLOCKED_INVALID_SERVICE_RESULT" };
  return { content: [{ type: "text", text: JSON.stringify(fallback) }], structuredContent: fallback };
}

export function createControlTowerMcpServer({ services = {} } = {}) {
  const runtime = createRuntimeServices(services);
  const github = createGitHubRuntimeServices();
  runtime.bootstrapProject = services.bootstrapProject ?? github.bootstrapProject;
  runtime.readControlState = services.readControlState ?? github.readControlState;
  if (typeof services.publishReceipt !== "function" && typeof services.readReceipt !== "function") {
    runtime.writeReceipt = github.writeReceipt;
  }
  const server = new McpServer({ name: "control-tower-mcp", version: "1.0.0" });

  for (const [name, serviceName, inputSchema, description] of tools) {
    server.registerTool(name, { description, inputSchema }, async (input) => {
      try {
        return resultFor(await runtime[serviceName](input));
      } catch {
        return resultFor({ state: "BLOCKED", code: "BLOCKED_RUNTIME_SERVICE_FAILURE" });
      }
    });
  }

  return server;
}

export async function runControlTowerMcpServer(options) {
  const server = createControlTowerMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runControlTowerMcpServer().catch(() => {
    process.exitCode = 1;
  });
}
