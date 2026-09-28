import { pathToFileURL } from "node:url";

import { createGitHubRuntimeServices } from "./github_runtime.mjs";

const repo = "D22977/gpt-browser-bridge";
const protocol = "GBB_CONTROL_TOWER_MCP_R2_GITHUB_AUTHORITY_CANARY_V1";
const eventId = "GBB-CONTROL-TOWER-MCP-R2-GH-CANARY-20260928-01";

export async function runGitHubCanary({ services = createGitHubRuntimeServices({ env: {
  ...process.env,
  CONTROL_TOWER_MCP_GITHUB_REPOS: repo,
  CONTROL_TOWER_MCP_GITHUB_POINTER_ISSUES: "43",
  CONTROL_TOWER_MCP_GITHUB_WRITE_ALLOWLIST: `${repo}#94#${protocol}`,
} }) } = {}) {
  const bootstrap = await services.bootstrapProject({ repo, current_pointer_issue: 43 });
  if (bootstrap?.state !== "PASS") return bootstrap;
  const pointer = await services.readControlState({ repo, pointer: "issue:43" });
  if (pointer?.state !== "PASS") return pointer;
  const payload = {
    state: "PASS",
    event_id: eventId,
    idempotency_key: eventId,
    current_pointer_issue: 43,
    user_relay_count: 0,
    product_file_modified: false,
    pull_request_modified: false,
    workflow_modified: false,
    host_config_modified: false,
    task_modified: false,
    process_modified: false,
    browser_modified: false,
    wake_activated: false,
    lease_activated: false,
    heartbeat_activated: false,
    reviewer_activated: false,
    monitor_activated: false,
    token_value_read: false,
  };
  const receipt = await services.writeReceipt({ repo, issue: 94, protocol, payload });
  if (receipt?.state !== "PASS" || receipt.read_back !== true) return receipt;
  return {
    state: "PASS",
    receipt_id: receipt.receipt_id,
    read_back: true,
    existing: receipt.existing === true,
    repository: repo,
    pointer_issue: 43,
    no_worker_wake_claimed: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "--execute") {
  runGitHubCanary().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result?.state !== "PASS") process.exitCode = 1;
  }).catch(() => {
    process.stdout.write('{"state":"BLOCKED","code":"BLOCKED_CANARY"}\n');
    process.exitCode = 1;
  });
}
