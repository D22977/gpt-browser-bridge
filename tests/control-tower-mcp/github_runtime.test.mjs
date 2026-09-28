import assert from "node:assert/strict";
import test from "node:test";

import { runGitHubCanary } from "../../control-tower-mcp/github_canary.mjs";
import { createGitHubRuntimeServices } from "../../control-tower-mcp/github_runtime.mjs";

const repo = "D22977/gpt-browser-bridge";
const protocol = "GBB_CONTROL_TOWER_MCP_R2_GITHUB_AUTHORITY_CANARY_V1";
const event = "GBB-CONTROL-TOWER-MCP-R2-GH-CANARY-20260928-01";
const endpoint = "repos/" + repo;
const env = {
  CONTROL_TOWER_MCP_GITHUB_REPOS: repo,
  CONTROL_TOWER_MCP_GITHUB_POINTER_ISSUES: "43",
  CONTROL_TOWER_MCP_GITHUB_WRITE_ALLOWLIST: repo + "#94#" + protocol,
};

function fakeGh({ comments = [], uncertainPost = false } = {}) {
  const calls = [];
  let nextId = 100;
  const executeGh = async (args, input) => {
    calls.push({ args, input });
    if (args[1] === endpoint) return { ok: true, value: { full_name: repo, default_branch: "main" } };
    if (args[1] === endpoint + "/issues/43") return { ok: true, value: { number: 43, title: "Control", state: "open" } };
    if (args[1] === endpoint + "/issues/94") return { ok: true, value: { number: 94, title: "Canary", state: "open" } };
    if (args[1] === endpoint + "/issues/94/comments" && args.includes("POST")) {
      const comment = { id: nextId++, body: JSON.parse(input).body };
      comments.push(comment);
      return uncertainPost ? { ok: false } : { ok: true, value: comment };
    }
    if (args[1] === endpoint + "/issues/94/comments" && args.includes("--paginate")) {
      return { ok: true, value: [comments] };
    }
    if (args[1] === endpoint + "/issues/43/comments" && args.includes("--paginate")) {
      return { ok: true, value: [comments] };
    }
    const commentPrefix = endpoint + "/issues/comments/";
    if (args[1].startsWith(commentPrefix)) {
      const id = Number(args[1].slice(commentPrefix.length));
      const comment = comments.find((entry) => entry.id === id);
      return comment ? { ok: true, value: comment } : { ok: false };
    }
    return { ok: false };
  };
  return { calls, comments, executeGh };
}

test("missing allowlists fail closed without invoking gh", async () => {
  const gh = fakeGh();
  const services = createGitHubRuntimeServices({ env: {}, executeGh: gh.executeGh });
  const result = await services.bootstrapProject({ repo });
  assert.equal(result.state, "BLOCKED");
  assert.equal(gh.calls.length, 0);
});

test("bootstrap reads repository and pointer metadata", async () => {
  const gh = fakeGh();
  const services = createGitHubRuntimeServices({ env, executeGh: gh.executeGh });
  const result = await services.bootstrapProject({ repo, current_pointer_issue: 43 });
  assert.equal(result.state, "PASS");
  assert.equal(result.repository.default_branch, "main");
  assert.equal(result.pointer_issue.number, 43);
  assert.equal(gh.calls.length, 2);
});

test("unallowlisted inputs do not reach gh", async () => {
  const gh = fakeGh();
  const services = createGitHubRuntimeServices({ env, executeGh: gh.executeGh });
  assert.equal((await services.bootstrapProject({ repo: "other/repo" })).state, "BLOCKED");
  assert.equal((await services.readControlState({ repo, pointer: "issue:44" })).state, "BLOCKED");
  assert.equal((await services.writeReceipt({ repo, issue: 95, protocol, payload: { idempotency_key: event } })).state, "BLOCKED");
  assert.equal((await services.writeReceipt({ repo, issue: 94, protocol: "OTHER", payload: { idempotency_key: event } })).state, "BLOCKED");
  assert.equal(gh.calls.length, 0);
});

test("control state resolves supersession links", async () => {
  const comments = [
    { id: 1, body: "CURRENT_INDEX_V1\nstate: OLD" },
    { id: 2, body: "CURRENT_INDEX_V2\nstate: CURRENT\nsupersedes: Issue #43 comment 1" },
  ];
  const gh = fakeGh({ comments });
  const services = createGitHubRuntimeServices({ env, executeGh: gh.executeGh });
  const result = await services.readControlState({ repo, pointer: "issue:43" });
  assert.equal(result.state, "PASS");
  assert.equal(result.candidates[0].current, false);
  assert.deepEqual(result.candidates[1].supersedes, [1]);
  assert.equal(result.candidates[1].current, true);
});

test("receipt write is idempotent and requires exact read-back", async () => {
  const gh = fakeGh();
  const services = createGitHubRuntimeServices({ env, executeGh: gh.executeGh });
  const input = { repo, issue: 94, protocol, payload: { idempotency_key: event, state: "PASS" } };
  const first = await services.writeReceipt(input);
  const second = await services.writeReceipt(input);
  assert.equal(first.state, "PASS");
  assert.equal(first.read_back, true);
  assert.equal(second.existing, true);
  assert.equal(gh.calls.filter(({ args }) => args.includes("POST")).length, 1);
});

test("conflicting idempotency and uncertain POST never cause a retry", async () => {
  const conflictGh = fakeGh();
  const conflictServices = createGitHubRuntimeServices({ env, executeGh: conflictGh.executeGh });
  await conflictServices.writeReceipt({ repo, issue: 94, protocol, payload: { idempotency_key: event, state: "PASS" } });
  const conflict = await conflictServices.writeReceipt({ repo, issue: 94, protocol, payload: { idempotency_key: event, state: "OTHER" } });
  assert.equal(conflict.code, "BLOCKED_RECEIPT_IDEMPOTENCY_CONFLICT");
  assert.equal(conflictGh.calls.filter(({ args }) => args.includes("POST")).length, 1);

  const uncertainGh = fakeGh({ uncertainPost: true });
  const uncertainServices = createGitHubRuntimeServices({ env, executeGh: uncertainGh.executeGh });
  const reconciled = await uncertainServices.writeReceipt({ repo, issue: 94, protocol, payload: { idempotency_key: event, state: "PASS" } });
  assert.equal(reconciled.state, "PASS");
  assert.equal(reconciled.reconciled_after_uncertain_post, true);
  assert.equal(uncertainGh.calls.filter(({ args }) => args.includes("POST")).length, 1);
});

test("canary reads authority before asking the adapter to write", async () => {
  const calls = [];
  const services = {
    bootstrapProject: async (input) => { calls.push(["bootstrap", input]); return { state: "PASS" }; },
    readControlState: async (input) => { calls.push(["read", input]); return { state: "PASS" }; },
    writeReceipt: async (input) => { calls.push(["write", input]); return { state: "PASS", receipt_id: "123", read_back: true }; },
  };
  const result = await runGitHubCanary({ services });
  assert.equal(result.state, "PASS");
  assert.deepEqual(calls.map(([name]) => name), ["bootstrap", "read", "write"]);
  const write = calls[2][1];
  assert.equal(write.repo, repo);
  assert.equal(write.issue, 94);
  assert.equal(write.protocol, protocol);
  assert.equal(write.payload.idempotency_key, event);
  assert.equal(write.payload.user_relay_count, 0);
  assert.equal(write.payload.token_value_read, false);
  assert.equal(write.payload.wake_activated, false);
});
