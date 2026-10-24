import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseActiveControlAuthority, parseG34ReceiptFields } from "../src/g34_contract.mjs";

const { createSourceEvent, publishSourceEvent, sourceEventPayloadBody, markSourceEventConsumed, beginSuccessorDelivery } = await import("../src/g34_source_event_publisher.mjs").catch(() => ({}));

const binding = {
  card_comment_id: "5777732770",
  claim_comment_id: "6083284000",
  acceptance_comment_id: "6083285000",
  binding_comment_id: "6083287293",
  dispatch_comment_id: "6083292578",
  agent_name: "gbb_g34_source_1009a",
  agent_session: "01a12121-7e02-7d30-90f3-1484c9a105fa",
  pane: "w3:p11",
  terminal: "term_65d6966ba1cedb",
  cwd: "D:\\AIWORK_WT\\GBB-G34-SOURCE-EVENT-20261009-01",
  model: "gpt-6-luna",
  reasoning_effort: "low",
  executor_identity: "collaboration task gbb_g34_source_1009a",
  lease_id: "GBB-LEASE-20261009-01",
  attempt_id: "GBB-G34-SOURCE-1009A-01",
  start_comment_id: "6083293000",
  base_tree_sha: "d".repeat(40),
};
const authority = {
  control_generation: "034",
  active_control_id: "6ac3b22a-a830-83ee-bd71-85838e5f1392",
  control_conversation_id: "6ac3b22a-a830-83ee-bd71-85838e5f1392",
};
const authorityRecords = {
  switchReceipt: {
    id: "9101", url: "https://github.com/D22977/gpt-browser-bridge/issues/88#issuecomment-9101",
    user: { login: "D22977" },
    body: `CONTROL_GENERATION_ATOMIC_SWITCH_V1\nstate: ACTIVE_SWITCH_COMMITTED_READBACK_REQUIRED\n\nOLD_CONTROL\ngeneration: 033\nstatus_after: RETIRED\n\nNEW_CONTROL\ngeneration: 034\nconversation_id: ${authority.active_control_id}\nstatus_after: ACTIVE\nsingle_active_control: true`,
  },
  index43: {
    id: "9102", url: "https://github.com/D22977/gpt-browser-bridge/issues/43#issuecomment-9102",
    user: { login: "D22977" },
    body: "CURRENT_REHYDRATION_INDEX_V1\ncontrol_generation: 034 ACTIVE\n\nOWNER_RESTORATION_AUTHORITY_AND_ARCH_RECONCILIATION\nactive g34 switch: #88/9101 exact-read",
  },
  index81: {
    id: "9103", url: "https://github.com/D22977/gpt-browser-bridge/issues/81#issuecomment-9103",
    user: { login: "D22977" },
    body: `CURRENT_REGISTRY_INDEX_V1\ncontrol_generation: 034 ACTIVE\ncurrent_control: #43/9102 exact-read\nactive_control_id: ${authority.active_control_id}\nsingle_active_control: true`,
  },
  rehydrationAck: {
    id: "9104", url: "https://github.com/D22977/gpt-browser-bridge/issues/88#issuecomment-9104",
    user: { login: "D22977" },
    body: `ACTIVE_CONTROL_REHYDRATION_ACK_V1\nstate: ACTIVE_REHYDRATED_ACKNOWLEDGED\ngeneration: 034\nconversation_id: ${authority.active_control_id}\n\nREQUEST_AND_SWITCH\natomic_switch: #88/9101 exact-read\n\nACTIVE_STATE\nsole_active_control_generation: 034\nsole_active_control_identity_match: true\nsingle_active_control: true\nstate_pointer_consistency: matched`,
  },
};
parseActiveControlAuthority(authorityRecords);

const sourceBody = (overrides = {}) => {
  const fields = {
  marker: "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1",
  state: "CONSUMED_STARTED",
  card_comment_id: binding.card_comment_id,
  claim_comment_id: binding.claim_comment_id,
  acceptance_comment_id: binding.acceptance_comment_id,
  binding_comment_id: binding.binding_comment_id,
  dispatch_comment_id: binding.dispatch_comment_id,
  control_generation: authority.control_generation,
  control_conversation_id: authority.control_conversation_id,
  repository: "D22977/gpt-browser-bridge",
  branch: "work/gbb-g34-source-event-20261009-01",
  base_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
  base_tree_sha: "d".repeat(40),
  head_sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
  agent_name: binding.agent_name,
  agent_session: binding.agent_session,
  pane: binding.pane,
  terminal: binding.terminal,
  executor_identity: `collaboration task ${binding.agent_name}`,
  lease_id: binding.lease_id,
  attempt_id: binding.attempt_id,
  cwd: binding.cwd,
  model: binding.model,
  reasoning_effort: binding.reasoning_effort,
  user_relay_count: "0",
  ...overrides,
  };
  const marker = fields.marker;
  delete fields.marker;
  return marker + "\n" + Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${value}`).join("\n");
};

function sourceComment(overrides = {}) {
  return {
    id: "6083328488",
    url: "https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-6083328488",
    user: { login: "D22977" },
    body: sourceBody(overrides),
  };
}

function assertImplemented() {
  assert.equal(typeof createSourceEvent, "function", "source event builder is not implemented");
  assert.equal(typeof publishSourceEvent, "function", "source event publisher is not implemented");
  assert.equal(typeof markSourceEventConsumed, "function", "durable event consumption is not implemented");
}

function sampleEvent() {
  return createSourceEvent({
    sourceComment: sourceComment(),
    sourceIssueNumber: 202,
    sourceRepositoryFullName: "D22977/gpt-browser-bridge",
    eventKind: "WORKER_STARTED",
    authority,
    binding,
    branch: "work/gbb-g34-source-event-20261009-01",
    baseSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
    headSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
    state: "CONSUMED_STARTED",
    expectedAuthor: "D22977",
  });
}

function clientFor(body, options = {}) {
  const calls = { create: 0, exactGet: 0, sourceGet: 0, find: 0 };
  return {
    calls,
    async getCommit(sha) {
      if (options.getCommit) return options.getCommit(sha);
      const candidates = [options.sourceComment, ...Object.values(options.sourceComments ?? {})]
        .filter((comment) => typeof comment?.body === "string")
        .map((comment) => parseG34ReceiptFields(comment));
      const startReceipt = candidates.find((receipt) => receipt.base_sha === sha && receipt.base_tree_sha);
      const headReceipt = candidates.find((receipt) =>
        [receipt.head_sha, receipt.remote_commit, receipt.local_tested_commit].includes(sha));
      const tree = startReceipt?.base_tree_sha ?? headReceipt?.tree_sha ?? "d".repeat(40);
      const parent = headReceipt?.remote_parent ?? headReceipt?.commit_parent ?? headReceipt?.parent_sha ?? null;
      return { sha, tree: { sha: tree }, parents: parent ? [{ sha: parent }] : [] };
    },
    async getCurrentAuthorityRecords() {
      options.onAuthorityRead?.();
      if (options.currentAuthorityRead) return options.currentAuthorityRead();
      return structuredClone(options.authorityRecords?.() ?? authorityRecords);
    },
    async findEventComments() { calls.find++; options.onFind?.(); return typeof options.matches === "function" ? options.matches(calls.find) : options.matches ?? []; },
    async createIssueComment(issueNumber, postedBody) {
      calls.create++;
      options.onCreate?.();
      assert.equal(issueNumber, 202);
      assert.equal(postedBody, body);
      if (options.createError) throw options.createError;
      return { id: "9001" };
    },
    async getIssueComment(id) {
      const pointer = Object.values(options.currentAuthorityRecords?.() ?? authorityRecords).find((record) => String(record.id) === String(id));
      if (pointer) return structuredClone(pointer);
      if (options.sourceComments?.[String(id)]) return structuredClone(options.sourceComments[String(id)]);
      if (String(id) === "6083328488") {
        calls.sourceGet++;
        const source = sourceComment();
        if (options.sourceComment) return structuredClone(options.sourceComment);
        return source;
      }
      calls.exactGet++;
      assert.equal(String(id), "9001");
      if (options.getError) throw options.getError;
      return { id, url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${id}`, user: { login: "D22977" }, body };
    },
  };
}

function publishWithCurrentAuthority(args) {
  const currentAuthority = args.currentAuthority ?? authorityRecords;
  const sourceGithub = args.github;
  const liveRecords = () => args.liveAuthorityRecords?.() ?? currentAuthority;
  const github = {
    ...sourceGithub,
    async getCurrentAuthorityRecords() { return structuredClone(liveRecords()); },
    async getIssueComment(id) {
      const pointer = Object.values(liveRecords()).find((record) => String(record.id) === String(id));
      return pointer ? structuredClone(pointer) : sourceGithub.getIssueComment(id);
    },
  };
  return publishSourceEvent({
    ...args,
    currentAuthority,
    github,
  });
}

test("source-event exports exist", () => {
  assert.equal(typeof createSourceEvent, "function");
  assert.equal(typeof publishSourceEvent, "function");
});

test("source event id is deterministic and body binds the upstream receipt identity", () => {
  assertImplemented();
  const first = sampleEvent();
  const second = sampleEvent();
  const expectedId = createHash("sha256")
    .update(JSON.stringify(["034", "WORKER_STARTED", "6083328488"]), "utf8")
    .digest("hex");
  assert.equal(first.event_id, expectedId);
  assert.equal(second.body, first.body);
  assert.equal(first.source_comment_id, "6083328488");
  assert.equal(first.tree_sha, binding.base_tree_sha);
  assert.equal("event_comment_id" in first, false);
  assert.doesNotMatch(first.body, /event_comment_id/);
  assert.equal(first.source_body_sha256, createHash("sha256").update(sourceComment().body, "utf8").digest("hex"));
  assert.match(first.body, /marker=GITHUB_SOURCE_EVENT_V1/);
  assert.match(first.body, /source_comment_id=6083328488/);
  assert.match(first.body, /claim_comment_id=6083284000/);
  assert.match(first.body, /acceptance_comment_id=6083285000/);
  assert.match(first.body, new RegExp(`tree_sha=${binding.base_tree_sha}`));
});

test("source event rejects unrelated authors and mismatched claim, executor, state, or branch fields", () => {
  assertImplemented();
  const variants = [
    { comment: { ...sourceComment(), user: { login: "unrelated" } } },
    { comment: sourceComment({ card_comment_id: "1" }) },
    { comment: sourceComment({ binding_comment_id: "1" }) },
    { comment: sourceComment({ dispatch_comment_id: "1" }) },
    { comment: sourceComment({ agent_session: "other-session" }) },
    { comment: sourceComment({ state: "READY_FOR_FRESH_REVIEW" }) },
    { comment: sourceComment({ branch: "other-branch" }) },
    { comment: sourceComment({ base_sha: "d7d17550fdfe3ae3e06ecec352004ca3b7284c55" }) },
    { comment: sourceComment({ base_tree_sha: undefined }) },
  ];
  for (const { comment } of variants) {
    assert.throws(() => createSourceEvent({
      sourceComment: comment,
      sourceIssueNumber: 202,
      sourceRepositoryFullName: "D22977/gpt-browser-bridge",
      eventKind: "WORKER_STARTED",
      authority,
      binding,
      branch: "work/gbb-g34-source-event-20261009-01",
      baseSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
      headSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
      state: "CONSUMED_STARTED",
      expectedAuthor: "D22977",
    }));
  }
});

test("terminal source event derives consistent linked fields and rejects conflicting legacy aliases", () => {
  assertImplemented();
  const cases = [
    {
      id: "6306918593", start_comment_id: "6306778001", lease_id: "GBB-211-LEASE-20261021-13",
      attempt_id: "GBB-G036-211-LUNA-COLLAB-G13-20261021-01", base_sha: "8fc68fe06231d3c9c07630273f3d0e70bda1f9a6",
      claim_comment_id: "6306230204", acceptance_comment_id: "6306245339", binding_comment_id: "6306219207", dispatch_comment_id: "6306761839",
      head_sha: "9a1fb30b79cb64b26b81180483924ad1a2227cee",
      expected_tree_sha: "bf50166719f641c5f06c935953767c1936ba9ec2",
      body: `GBB_G34_EXECUTOR_TERMINAL_RESULT_V1\nstate: READY_FOR_FRESH_REVIEW\nevent_idempotency_key: GBB-211-G13-READY-9a1fb30b79cb64b26b81180483924ad1a2227cee\nwork_order: D22977/gpt-browser-bridge#211\nworker_task_identity: /root/g34_211_worker_luna1\nrole: Worker\nmodel_effort: gpt-6-luna / low\nsession_surface: collaboration-managed\ngithub_publisher: D22977\nexecutor_identity: collaboration task /root/g34_211_worker_luna1\nlease_id: GBB-211-LEASE-20261021-13\nlease_generation: 13\nattempt_id: GBB-G036-211-LUNA-COLLAB-G13-20261021-01\nworker_check_in_comment_id: 6306770019\nworker_start_comment_id: 6306778001\nclaim_comment_id: 6306230204\nacceptance_comment_id: 6306245339\nbinding_comment_id: 6306219207\ndispatch_comment_id: 6306761839\nbase_sha: 8fc68fe06231d3c9c07630273f3d0e70bda1f9a6\nbranch: work/gbb-g34-review-repair-20261009-01\nhead_sha: 9a1fb30b79cb64b26b81180483924ad1a2227cee\ntree_sha: bf50166719f641c5f06c935953767c1936ba9ec2\nsuperseded_invalid_head: none in G13; prior reviewed head was 8fc68fe06231d3c9c07630273f3d0e70bda1f9a6\nchanged_paths:\n- src/g34_resident.mjs\n- src/g34_source_event_publisher.mjs\n- tests/g34_resident.test.mjs\n- tests/g34_source_event_publisher.test.mjs\nexact_six_remote_blob_readback:\nsrc/g34_contract.mjs: 66ada1cd36ce30690c71e61e1de706ac29b880c9\nsrc/g34_resident.mjs: dc6cbab2f229cc3c92f2edcd88886829d9264c56\nsrc/g34_source_event_publisher.mjs: f6aefcf2a54d4d498c176da2150c49598f43420d\ntests/g34_contract.test.mjs: 7199c37e2088f8b4d24cbfdf9ba4593cd1e9844d\ntests/g34_resident.test.mjs: 31a212447fc8c8c1e929820596e3b2e7f7f5b053\ntests/g34_source_event_publisher.test.mjs: 8b1ec46ff684541e75c0517ebd000b6a1d28113f\nfocused_validation: node --test tests/g34_contract.test.mjs tests/g34_source_event_publisher.test.mjs tests/g34_resident.test.mjs — 22/22 passed\nfull_validation: npm test — 197/197 passed\ndiff_check: git diff --check — clean\nremote_publication: exact local Git blob objects uploaded; tree bf50166719f641c5f06c935953767c1936ba9ec2 matches local tree; commit 9a1fb30b79cb64b26b81180483924ad1a2227cee exact-read; all six remote file blob SHAs exact-read at that commit; branch update_ref succeeded with expected_sha 8fc68fe06231d3c9c07630273f3d0e70bda1f9a6 and force=false\ntransport_note: direct git push had Windows Schannel SEC_E_UNTRUSTED_ROOT; TLS was not bypassed\nscope: six-file allowlist only; no merge, runtime, release, or activation performed`,
    },
    {
      id: "6308893422", start_comment_id: "6308694953", lease_id: "GBB-211-LEASE-20261021-14",
      attempt_id: "GBB-G036-211-LUNA-COLLAB-G14-20261021-01", base_sha: "9a1fb30b79cb64b26b81180483924ad1a2227cee",
      claim_comment_id: "6306230204", acceptance_comment_id: "6306245339", binding_comment_id: "6306219207", dispatch_comment_id: "6308671466",
      head_sha: "c7e3b1d53b3fa5e94f7fa4c8701fda9c97760d1f",
      expected_tree_sha: "9ad949d21072b3e4a9733d42f8afa92ebcef530f",
      body: `GBB_G34_EXECUTOR_TERMINAL_RESULT_V1\nstate: READY_FOR_FRESH_REVIEW\ntask_identity: /root/g34_211_worker_luna1\nrole: Worker\nmodel_effort: gpt-6-luna / low\nsession_surface: collaboration-managed\npublisher: D22977\nexecutor_identity: collaboration task /root/g34_211_worker_luna1\nlease_id: GBB-211-LEASE-20261021-14\nlease_generation: 14\nattempt_id: GBB-G036-211-LUNA-COLLAB-G14-20261021-01\nworker_start_comment_id: 6308694953\ncontrol_publication_readback_comment_id: 6308879515\nbranch: work/gbb-g34-review-repair-20261009-01\nbase_sha: 9a1fb30b79cb64b26b81180483924ad1a2227cee\nlocal_tested_commit: d04b56fdb3bbe41281c858cf6e9705f56d42e4b1\nlocal_tested_tree: 9ad949d21072b3e4a9733d42f8afa92ebcef530f\nremote_commit: c7e3b1d53b3fa5e94f7fa4c8701fda9c97760d1f\nremote_parent: 9a1fb30b79cb64b26b81180483924ad1a2227cee\nremote_tree: 9ad949d21072b3e4a9733d42f8afa92ebcef530f\nexact_branch_ref_readback: refs/heads/work/gbb-g34-review-repair-20261009-01 -> c7e3b1d53b3fa5e94f7fa4c8701fda9c97760d1f\nexact_commit_readback: commit c7e3b1d53b3fa5e94f7fa4c8701fda9c97760d1f; parent 9a1fb30b79cb64b26b81180483924ad1a2227cee; tree 9ad949d21072b3e4a9733d42f8afa92ebcef530f\nexact_recursive_tree_readback: 9ad949d21072b3e4a9733d42f8afa92ebcef530f; 154 entries; truncated=false\nverified_blob_paths:\nsrc/g34_contract.mjs: aea54ee7dfacd28fa501ff1c17732b2a7c6d0248\nsrc/g34_resident.mjs: 97526964acc3c085983935db7ac93a171edfbe9f\nsrc/g34_source_event_publisher.mjs: 14fd5e585f6b02a0a513af791932f47bf450d3b5\ntests/g34_contract.test.mjs: 7199c37e2088f8b4d24cbfdf9ba4593cd1e9844d\ntests/g34_resident.test.mjs: 0789352a7b3761b2373ec7ef3b70ec08c66fc7ad\ntests/g34_source_event_publisher.test.mjs: b6049e0544110a82a8a7c13d878e459a6d797ac8\nfocused_validation: node --test tests/g34_resident.test.mjs tests/g34_source_event_publisher.test.mjs tests/g34_contract.test.mjs — PASS 22/22\nfull_validation: npm test — PASS 197/197\ndiff_check: git diff --check — PASS\nscope: five changed allowlisted paths; sixth allowlisted contract test unchanged; no merge/runtime/release/activation/adoption/deployment.`,
    },
  ];
  for (const item of cases) {
    const baseBinding = { ...binding, ...Object.fromEntries(["claim_comment_id", "acceptance_comment_id", "binding_comment_id", "dispatch_comment_id"].map((key) => [key, item[key]])), executor_identity: "collaboration task /root/g34_211_worker_luna1", agent_name: "/root/g34_211_worker_luna1", start_comment_id: item.start_comment_id, lease_id: item.lease_id, attempt_id: item.attempt_id };
    const source = { id: item.id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${item.id}`, user: { login: "D22977" }, body: item.body };
    const build = () => createSourceEvent({
      sourceComment: source, sourceIssueNumber: 211, sourceRepositoryFullName: "D22977/gpt-browser-bridge",
      eventKind: "WORKER_TERMINAL_RESULT", authority, binding: baseBinding,
      branch: "work/gbb-g34-review-repair-20261009-01", baseSha: item.base_sha, headSha: item.head_sha,
      state: "READY_FOR_FRESH_REVIEW", expectedAuthor: "D22977",
    });
    if (item.body.includes("local_tested_commit:")) {
      assert.throws(build, /upstream executor receipt/);
      continue;
    }
    const event = build();
    assert.equal(event.source_comment_id, item.id);
    assert.equal(event.claim_comment_id, item.claim_comment_id);
    assert.equal(event.acceptance_comment_id, item.acceptance_comment_id);
    assert.equal(event.tree_sha, item.expected_tree_sha);
  }
});

test("publisher persists before sending and exact-reads the created GitHub comment", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  const github = clientFor(event.body);
  const result = await publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github });
  assert.equal(result.state, "DELIVERED");
  assert.deepEqual(github.calls, { create: 1, exactGet: 1, sourceGet: 1, find: 1 });
  const ledger = JSON.parse(await readFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "DELIVERED");
  assert.equal(ledger[event.event_id].comment_id, "9001");
});

test("publisher rejects a non-deterministic event id before ledger writes or GitHub creation", async () => {
  const event = sampleEvent();
  event.event_id = "f".repeat(64);
  event.body = sourceEventPayloadBody(event);
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-event-id-tamper-"));
  const github = clientFor(event.body);
  await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }), /deterministic event id/);
  assert.equal(github.calls.create, 0);
  assert.equal(github.calls.find, 0);
  assert.equal(github.calls.sourceGet, 0);
  await assert.rejects(() => readFile(path.join(runtimeRoot, "events", "g34-source-events.json")), { code: "ENOENT" });
});

test("publisher binds source identity, issue, repository, and body hash before ledger writes", async () => {
  const event = sampleEvent();
  const variants = [
    { ...sourceComment(), id: "6083328489" },
    { ...sourceComment(), url: "https://github.com/D22977/gpt-browser-bridge/issues/203#issuecomment-6083328488" },
    { ...sourceComment(), url: "https://github.com/D22977/other/issues/202#issuecomment-6083328488" },
    { ...sourceComment(), body: "changed upstream body" },
  ];
  for (const [index, source] of variants.entries()) {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), `g34-source-metadata-tamper-${index}-`));
    const github = clientFor(event.body, { sourceComment: source });
    await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }), /exact upstream source comment/);
    assert.equal(github.calls.create, 0);
    assert.equal(github.calls.find, 0);
    assert.equal(github.calls.sourceGet, 1);
    await assert.rejects(() => readFile(path.join(runtimeRoot, "events", "g34-source-events.json")), { code: "ENOENT" });
  }
});

test("exported publisher rejects source-derived Worker field tampering despite the genuine source hash", async () => {
  for (const [field, value] of [
    ["head_sha", "e".repeat(40)],
    ["tree_sha", "f".repeat(40)],
    ["state", "BLOCKED_NETWORK"],
    ["agent_name", "forged-worker"],
    ["branch", "work/forged-branch"],
  ]) {
    const event = sampleEvent();
    event[field] = value;
    event.body = sourceEventPayloadBody(event);
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), `g34-event-field-tamper-${field}-`));
    const github = clientFor(event.body);
    await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }), /does not match exact Worker source receipt/);
    assert.equal(github.calls.create, 0);
    assert.equal(github.calls.find, 0);
    const ledgerPath = path.join(runtimeRoot, "events", "g34-source-events.json");
    await assert.rejects(() => readFile(ledgerPath), { code: "ENOENT" });
  }
});

test("exported publisher reconstructs a terminal event from the exact linked Worker start", async () => {
  const startId = "6083330000";
  const terminalId = "6083330001";
  const start = {
    id: startId,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${startId}`,
    user: { login: "D22977" },
    body: sourceBody(),
  };
  const terminalBody = [
    "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1",
    "state: READY_FOR_FRESH_REVIEW",
    `worker_start_comment_id: ${startId}`,
    `card_comment_id: ${binding.card_comment_id}`,
    `claim_comment_id: ${binding.claim_comment_id}`,
    `acceptance_comment_id: ${binding.acceptance_comment_id}`,
    `binding_comment_id: ${binding.binding_comment_id}`,
    `dispatch_comment_id: ${binding.dispatch_comment_id}`,
    `executor_identity: collaboration task ${binding.agent_name}`,
    `agent_name: ${binding.agent_name}`,
    `agent_session: ${binding.agent_session}`,
    `pane: ${binding.pane}`,
    `terminal: ${binding.terminal}`,
    `cwd: ${binding.cwd}`,
    `model: ${binding.model}`,
    `reasoning_effort: ${binding.reasoning_effort}`,
    `lease_id: ${binding.lease_id}`,
    `attempt_id: ${binding.attempt_id}`,
    "branch: work/gbb-g34-source-event-20261009-01",
    "base_sha: c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
    "remote_parent: c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
    `head_sha: ${"e".repeat(40)}`,
    `tree_sha: ${"a".repeat(40)}`,
  ].join("\n");
  const source = {
    id: terminalId,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${terminalId}`,
    user: { login: "D22977" },
    body: terminalBody,
  };
  const event = createSourceEvent({
    sourceComment: source,
    canonicalReceipt: parseG34ReceiptFields(source),
    sourceIssueNumber: 202,
    sourceRepositoryFullName: "D22977/gpt-browser-bridge",
    eventKind: "WORKER_TERMINAL_RESULT",
    authority,
    binding: { ...binding, start_comment_id: startId },
    branch: "work/gbb-g34-source-event-20261009-01",
    baseSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
    headSha: "e".repeat(40),
    state: "READY_FOR_FRESH_REVIEW",
    terminalCommentId: terminalId,
    expectedAuthor: "D22977",
  });
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-terminal-event-reconstruction-"));
  const github = clientFor(event.body, { sourceComments: { [startId]: start, [terminalId]: source } });
  github.getCommit = async (sha) => sha === "c7d17550fdfe3ae3e06ecec352004ca3b7284c55"
    ? { sha, tree: { sha: "d".repeat(40) }, parents: [] }
    : { sha, tree: { sha: "a".repeat(40) }, parents: [{ sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55" }] };
  const result = await publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github });
  assert.equal(result.state, "DELIVERED");
  assert.equal(github.calls.create, 1);

  github.getCommit = async (sha) => sha === "c7d17550fdfe3ae3e06ecec352004ca3b7284c55"
    ? { sha, tree: { sha: "d".repeat(40) }, parents: [] }
    : { sha, tree: { sha: "a".repeat(40) }, parents: [{ sha: "b".repeat(40) }] };
  const badParentRoot = await mkdtemp(path.join(tmpdir(), "g34-terminal-parent-mismatch-"));
  await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot: badParentRoot, github }), /parent metadata/);
  assert.equal(github.calls.create, 1);
  await assert.rejects(readFile(path.join(badParentRoot, "events", "g34-source-events.json")), { code: "ENOENT" });
});

test("exported publisher checks every start tree alias against the exact GitHub base tree before ledger mutation", async () => {
  for (const treeAlias of ["tree_sha", "base_tree_sha"]) {
    for (const placement of ["top-level", "nested"]) {
    const declaredTree = "a".repeat(40);
    const source = { ...sourceComment({
      base_tree_sha: placement === "top-level" && treeAlias === "base_tree_sha" ? declaredTree : null,
      tree_sha: placement === "top-level" && treeAlias === "tree_sha" ? declaredTree : null,
    }) };
    if (placement === "nested") source.body += `\nBASE_TREE_EVIDENCE\n${treeAlias}: ${declaredTree}`;
    const event = createSourceEvent({
      sourceComment: source,
      canonicalReceipt: parseG34ReceiptFields(source),
      sourceIssueNumber: 202,
      sourceRepositoryFullName: "D22977/gpt-browser-bridge",
      eventKind: "WORKER_STARTED",
      authority,
      binding,
      branch: "work/gbb-g34-source-event-20261009-01",
      baseSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
      headSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
      state: "CONSUMED_STARTED",
      expectedAuthor: "D22977",
    });
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), `g34-start-tree-alias-${treeAlias}-${placement}-`));
    const github = clientFor(event.body, { sourceComment: source });
    github.getCommit = async (sha) => ({ sha, tree: { sha: "d".repeat(40) }, parents: [] });
    await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }), /tree metadata/);
    assert.equal(github.calls.create, 0);
    assert.equal(github.calls.find, 0);
    await assert.rejects(readFile(path.join(runtimeRoot, "events", "g34-source-events.json")), { code: "ENOENT" });
    }
  }
});

test("exported publisher checks every terminal tree alias against exact GitHub head tree before ledger mutation", async () => {
  const startId = "6083330200";
  const terminalId = "6083330201";
  const start = {
    id: startId,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${startId}`,
    user: { login: "D22977" },
    body: sourceBody(),
  };
  for (const treeAlias of ["tree_sha", "remote_tree", "remote_api_tree", "local_tested_tree", "candidate_tree_sha"]) {
    for (const placement of ["top-level", "nested"]) {
    const head = "e".repeat(40);
    const declaredTree = "a".repeat(40);
    const source = {
      id: terminalId,
      url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${terminalId}`,
      user: { login: "D22977" },
      body: sourceBody({
        marker: "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1",
        state: "READY_FOR_FRESH_REVIEW",
        worker_start_comment_id: startId,
        head_sha: head,
        tree_sha: placement === "top-level" && treeAlias === "tree_sha" ? declaredTree : null,
        remote_tree: placement === "top-level" && treeAlias === "remote_tree" ? declaredTree : null,
        remote_api_tree: placement === "top-level" && treeAlias === "remote_api_tree" ? declaredTree : null,
        local_tested_tree: placement === "top-level" && treeAlias === "local_tested_tree" ? declaredTree : null,
        candidate_tree_sha: placement === "top-level" && treeAlias === "candidate_tree_sha" ? declaredTree : null,
      }),
    };
    if (placement === "nested") source.body += `\nCANDIDATE_TREE_EVIDENCE\n${treeAlias}: ${declaredTree}`;
    const event = createSourceEvent({
      sourceComment: source,
      canonicalReceipt: parseG34ReceiptFields(source),
      sourceIssueNumber: 202,
      sourceRepositoryFullName: "D22977/gpt-browser-bridge",
      eventKind: "WORKER_TERMINAL_RESULT",
      authority,
      binding: { ...binding, start_comment_id: startId },
      branch: "work/gbb-g34-source-event-20261009-01",
      baseSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
      headSha: head,
      state: "READY_FOR_FRESH_REVIEW",
      terminalCommentId: terminalId,
      expectedAuthor: "D22977",
    });
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), `g34-terminal-tree-alias-${treeAlias}-${placement}-`));
    const github = clientFor(event.body, { sourceComments: { [startId]: start, [terminalId]: source } });
    github.getCommit = async (sha) => sha === "c7d17550fdfe3ae3e06ecec352004ca3b7284c55"
      ? { sha, tree: { sha: "d".repeat(40) }, parents: [] }
      : { sha, tree: { sha: "b".repeat(40) }, parents: [{ sha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55" }] };
    await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }), /tree metadata/);
    assert.equal(github.calls.create, 0);
    assert.equal(github.calls.find, 0);
    await assert.rejects(readFile(path.join(runtimeRoot, "events", "g34-source-events.json")), { code: "ENOENT" });
    }
  }
});

test("exported publisher rejects a terminal base_tree_sha mismatch, including nested evidence, before ledger mutation", async () => {
  const startId = "6083330250";
  const terminalId = "6083330251";
  const base = "c7d17550fdfe3ae3e06ecec352004ca3b7284c55";
  const start = {
    id: startId,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${startId}`,
    user: { login: "D22977" },
    body: sourceBody(),
  };
  for (const placement of ["top-level", "nested"]) {
    const source = {
      id: terminalId,
      url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${terminalId}`,
      user: { login: "D22977" },
      body: sourceBody({
        marker: "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1",
        state: "READY_FOR_FRESH_REVIEW",
        worker_start_comment_id: startId,
        head_sha: "e".repeat(40),
        tree_sha: "a".repeat(40),
        base_tree_sha: placement === "top-level" ? "b".repeat(40) : null,
      }),
    };
    if (placement === "nested") source.body += `\nBASE_TREE_EVIDENCE\nbase_tree_sha: ${"b".repeat(40)}`;
    const event = createSourceEvent({
      sourceComment: source,
      canonicalReceipt: parseG34ReceiptFields(source),
      sourceIssueNumber: 202,
      sourceRepositoryFullName: "D22977/gpt-browser-bridge",
      eventKind: "WORKER_TERMINAL_RESULT",
      authority,
      binding: { ...binding, start_comment_id: startId },
      branch: "work/gbb-g34-source-event-20261009-01",
      baseSha: base,
      headSha: "e".repeat(40),
      state: "READY_FOR_FRESH_REVIEW",
      terminalCommentId: terminalId,
      expectedAuthor: "D22977",
    });
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), `g34-terminal-base-tree-${placement}-`));
    const github = clientFor(event.body, { sourceComments: { [startId]: start, [terminalId]: source } });
    github.getCommit = async (sha) => sha === base
      ? { sha, tree: { sha: "d".repeat(40) }, parents: [] }
      : { sha, tree: { sha: "a".repeat(40) }, parents: [{ sha: base }] };
    await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }), /base tree metadata/);
    assert.equal(github.calls.find, 0);
    assert.equal(github.calls.create, 0);
    await assert.rejects(readFile(path.join(runtimeRoot, "events", "g34-source-events.json")), { code: "ENOENT" });
  }
});

test("exported publisher rejects a nested candidate_tree_sha conflict before ledger mutation or GitHub event lookup", async () => {
  const startId = "6083330270";
  const terminalId = "6083330271";
  const base = "c7d17550fdfe3ae3e06ecec352004ca3b7284c55";
  const start = {
    id: startId,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${startId}`,
    user: { login: "D22977" },
    body: sourceBody(),
  };
  const source = {
    id: terminalId,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${terminalId}`,
    user: { login: "D22977" },
    body: sourceBody({
      marker: "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1",
      state: "READY_FOR_FRESH_REVIEW",
      worker_start_comment_id: startId,
      head_sha: "e".repeat(40),
      tree_sha: "a".repeat(40),
    }),
  };
  const event = createSourceEvent({
    sourceComment: source,
    canonicalReceipt: parseG34ReceiptFields(source),
    sourceIssueNumber: 202,
    sourceRepositoryFullName: "D22977/gpt-browser-bridge",
    eventKind: "WORKER_TERMINAL_RESULT",
    authority,
    binding: { ...binding, start_comment_id: startId },
    branch: "work/gbb-g34-source-event-20261009-01",
    baseSha: base,
    headSha: "e".repeat(40),
    state: "READY_FOR_FRESH_REVIEW",
    terminalCommentId: terminalId,
    expectedAuthor: "D22977",
  });
  source.body += `\nCANDIDATE_TREE_EVIDENCE\ncandidate_tree_sha: ${"b".repeat(40)}`;
  event.source_body_sha256 = createHash("sha256").update(source.body, "utf8").digest("hex");
  event.body = sourceEventPayloadBody(event);
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-candidate-tree-conflict-"));
  const github = clientFor(event.body, { sourceComments: { [startId]: start, [terminalId]: source } });
  github.getCommit = async (sha) => sha === base
    ? { sha, tree: { sha: "d".repeat(40) }, parents: [] }
    : { sha, tree: { sha: "a".repeat(40) }, parents: [{ sha: base }] };
  await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }), /receipt|tree/);
  assert.equal(github.calls.find, 0);
  assert.equal(github.calls.create, 0);
  await assert.rejects(readFile(path.join(runtimeRoot, "events", "g34-source-events.json")), { code: "ENOENT" });
});

test("exported publisher proves bounded single-parent descent and rejects unrelated or ambiguous ancestry", async () => {
  const startId = "6083330300";
  const terminalId = "6083330301";
  const base = "c7d17550fdfe3ae3e06ecec352004ca3b7284c55";
  const mid = "c".repeat(40);
  const head = "e".repeat(40);
  const start = {
    id: startId,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${startId}`,
    user: { login: "D22977" },
    body: sourceBody(),
  };
  const source = {
    id: terminalId,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${terminalId}`,
    user: { login: "D22977" },
    body: sourceBody({
      marker: "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1",
      state: "READY_FOR_FRESH_REVIEW",
      worker_start_comment_id: startId,
      head_sha: head,
      tree_sha: "a".repeat(40),
      remote_parent: mid,
    }),
  };
  const event = createSourceEvent({
    sourceComment: source,
    canonicalReceipt: parseG34ReceiptFields(source),
    sourceIssueNumber: 202,
    sourceRepositoryFullName: "D22977/gpt-browser-bridge",
    eventKind: "WORKER_TERMINAL_RESULT",
    authority,
    binding: { ...binding, start_comment_id: startId },
    branch: "work/gbb-g34-source-event-20261009-01",
    baseSha: base,
    headSha: head,
    state: "READY_FOR_FRESH_REVIEW",
    terminalCommentId: terminalId,
    expectedAuthor: "D22977",
  });
  const sourceComments = { [startId]: start, [terminalId]: source };
  const goodCommit = (sha) => sha === base
    ? { sha, tree: { sha: "d".repeat(40) }, parents: [] }
    : sha === mid
      ? { sha, tree: { sha: "c".repeat(40) }, parents: [{ sha: base }] }
      : { sha, tree: { sha: "a".repeat(40) }, parents: [{ sha: mid }] };
  const goodRoot = await mkdtemp(path.join(tmpdir(), "g34-terminal-multi-commit-"));
  const goodGithub = clientFor(event.body, { sourceComments });
  goodGithub.getCommit = async (sha) => goodCommit(sha);
  assert.equal((await publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot: goodRoot, github: goodGithub })).state, "DELIVERED");

  const overDepthNodes = Array.from({ length: 66 }, (_, index) => (index + 1).toString(16).padStart(40, "0"));
  for (const ancestry of ["unrelated", "multiparent", "cycle", "over-depth", "malformed-intermediate-sha", "malformed-intermediate-parent", "intermediate-multiparent"]) {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), `g34-terminal-${ancestry}-`));
    const github = clientFor(event.body, { sourceComments });
    github.getCommit = async (sha) => {
      if (sha === base) return goodCommit(sha);
      if (sha === head) {
        if (ancestry === "unrelated") return { sha, tree: { sha: "a".repeat(40) }, parents: [{ sha: "f".repeat(40) }] };
        if (ancestry === "multiparent") return { sha, tree: { sha: "a".repeat(40) }, parents: [{ sha: mid }, { sha: "f".repeat(40) }] };
        if (ancestry === "over-depth") return { sha, tree: { sha: "a".repeat(40) }, parents: [{ sha: overDepthNodes[0] }] };
        return { sha, tree: { sha: "a".repeat(40) }, parents: [{ sha: mid }] };
      }
      if (sha === mid) {
        if (ancestry === "cycle") return { sha, tree: { sha: "c".repeat(40) }, parents: [{ sha: head }] };
        if (ancestry === "malformed-intermediate-sha") return { sha: "f".repeat(40), tree: { sha: "c".repeat(40) }, parents: [{ sha: base }] };
        if (ancestry === "malformed-intermediate-parent") return { sha, tree: { sha: "c".repeat(40) }, parents: [{ sha: "not-a-git-sha" }] };
        if (ancestry === "intermediate-multiparent") return { sha, tree: { sha: "c".repeat(40) }, parents: [{ sha: base }, { sha: "f".repeat(40) }] };
        return goodCommit(sha);
      }
      const overDepthIndex = overDepthNodes.indexOf(sha);
      if (overDepthIndex >= 0) {
        const parent = overDepthNodes[overDepthIndex + 1] ?? "f".repeat(40);
        return { sha, tree: { sha: "1".repeat(40) }, parents: [{ sha: parent }] };
      }
      return { sha, tree: { sha: "f".repeat(40) }, parents: [] };
    };
    await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }), /parent|ancestry/);
    assert.equal(github.calls.create, 0);
    assert.equal(github.calls.find, 0);
    await assert.rejects(readFile(path.join(runtimeRoot, "events", "g34-source-events.json")), { code: "ENOENT" });
  }
});

test("exported publisher rejects conflicting terminal head aliases before ledger mutation", async () => {
  const startId = "6083330100";
  const terminalId = "6083330101";
  const start = {
    id: startId,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${startId}`,
    user: { login: "D22977" },
    body: sourceBody(),
  };
  const source = {
    id: terminalId,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-${terminalId}`,
    user: { login: "D22977" },
    body: sourceBody({
      marker: "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1",
      state: "READY_FOR_FRESH_REVIEW",
      worker_start_comment_id: startId,
      head_sha: "e".repeat(40),
      tree_sha: "a".repeat(40),
    }),
  };
  const event = createSourceEvent({
    sourceComment: source,
    canonicalReceipt: parseG34ReceiptFields(source),
    sourceIssueNumber: 202,
    sourceRepositoryFullName: "D22977/gpt-browser-bridge",
    eventKind: "WORKER_TERMINAL_RESULT",
    authority,
    binding: { ...binding, start_comment_id: startId },
    branch: "work/gbb-g34-source-event-20261009-01",
    baseSha: "c7d17550fdfe3ae3e06ecec352004ca3b7284c55",
    headSha: "e".repeat(40),
    state: "READY_FOR_FRESH_REVIEW",
    terminalCommentId: terminalId,
    expectedAuthor: "D22977",
  });
  source.body += `\nremote_commit: ${"f".repeat(40)}`;
  event.source_body_sha256 = createHash("sha256").update(source.body, "utf8").digest("hex");
  event.body = sourceEventPayloadBody(event);
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-terminal-head-alias-conflict-"));
  const github = clientFor(event.body, { sourceComments: { [startId]: start, [terminalId]: source } });
  await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }));
  assert.equal(github.calls.create, 0);
  await assert.rejects(() => readFile(path.join(runtimeRoot, "events", "g34-source-events.json")), { code: "ENOENT" });
});

test("overlapping publishers for one source event create at most one GitHub event comment", async () => {
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-parallel-publication-"));
  let releaseCreate;
  let signalCreate;
  const createStarted = new Promise((resolve) => { signalCreate = resolve; });
  const holdCreate = new Promise((resolve) => { releaseCreate = resolve; });
  const github = clientFor(event.body, { matches: (call) => call === 1 ? [] : [{ id: "9001" }] });
  const originalCreate = github.createIssueComment;
  github.createIssueComment = async (...args) => {
    signalCreate();
    await holdCreate;
    return originalCreate(...args);
  };
  const first = publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github });
  await createStarted;
  const second = publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github });
  releaseCreate();
  const results = await Promise.all([first, second]);
  assert.equal(github.calls.create, 1);
  assert.deepEqual(results.map((result) => result.state).sort(), ["DELIVERED", "NO_OP"]);
});

test("overlapping successor admissions grant READY_TO_DELIVER to at most one caller", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-parallel-successor-"));
  const ledgerPath = path.join(runtimeRoot, "events", "g34-source-events.json");
  const event = sampleEvent();
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, JSON.stringify({ [event.event_id]: {
    state: "DELIVERED", source_publication_state: "DELIVERED", source_comment_id: event.source_comment_id, comment_id: "9001",
  } }));
  let deliverCalls = 0;
  const deliver = async () => { deliverCalls++; };
  const args = {
    eventId: event.event_id, sourceCommentId: event.source_comment_id, eventCommentId: "9001",
    controlCommentId: "8001", successorCommentId: "8002", deliver, runtimeRoot,
  };
  const results = await Promise.all([beginSuccessorDelivery(args), beginSuccessorDelivery(args)]);
  assert.equal(results.filter((result) => result.state === "READY_TO_DELIVER").length, 1);
  assert.equal(results.filter((result) => result.state === "DELIVERY_UNCERTAIN").length, 1);
  for (const result of results) if (result.state === "READY_TO_DELIVER") await deliver();
  assert.equal(deliverCalls, 1);
});

test("publisher exact-reads current Control after event lookup and ignores caller no-op guards", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-pre-create-authority-race-"));
  const order = [];
  let live = structuredClone(authorityRecords);
  const updated = structuredClone(authorityRecords);
  const old43 = String(updated.index43.id);
  const new43 = "9112";
  const new81 = "9113";
  updated.index43.id = new43;
  updated.index43.url = `https://github.com/D22977/gpt-browser-bridge/issues/43#issuecomment-${new43}`;
  updated.index81.id = new81;
  updated.index81.url = `https://github.com/D22977/gpt-browser-bridge/issues/81#issuecomment-${new81}`;
  updated.index81.body = updated.index81.body.replace(`#43/${old43}`, `#43/${new43}`);
  parseActiveControlAuthority(updated);
  const github = clientFor(event.body, {
    authorityRecords: () => live,
    currentAuthorityRecords: () => live,
    onFind: () => { order.push("find"); live = updated; },
    onAuthorityRead: () => order.push("authority"),
    onCreate: () => order.push("create"),
  });
  const missingAuthorityRoot = await mkdtemp(path.join(tmpdir(), "g34-no-authority-snapshot-"));
  await assert.rejects(() => publishSourceEvent({
    event, issueNumber: 202, runtimeRoot: missingAuthorityRoot,
    github: clientFor(event.body), beforeCreate: async () => {},
  }), /current Control authority snapshot is required/);
  await assert.rejects(() => publishSourceEvent({
    event, issueNumber: 202, runtimeRoot, github, currentAuthority: authorityRecords,
    beforeCreate: async () => {},
  }), /current Control authority changed before source-event GitHub create/);
  assert.deepEqual(order, ["authority", "find", "authority"]);
  assert.equal(github.calls.create, 0);
  const ledger = JSON.parse(await readFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "CLAIMED");
});

test("a pending authority read never leaves a durable send-attempt state", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-pending-authority-read-"));
  let signalAuthorityRead;
  let rejectAuthorityRead;
  const authorityReadStarted = new Promise((resolve) => { signalAuthorityRead = resolve; });
  const github = clientFor(event.body, {
    onAuthorityRead: signalAuthorityRead,
    currentAuthorityRead: () => new Promise((_resolve, reject) => { rejectAuthorityRead = reject; }),
  });

  const pendingPublish = publishSourceEvent({
    event, issueNumber: 202, runtimeRoot, github, currentAuthority: authorityRecords,
  });
  await authorityReadStarted;
  const pathToLedger = path.join(runtimeRoot, "events", "g34-source-events.json");
  await assert.rejects(() => readFile(pathToLedger), { code: "ENOENT" });

  rejectAuthorityRead(new Error("authority read unavailable"));
  await assert.rejects(() => pendingPublish, /authority read unavailable/);
  await assert.rejects(() => readFile(pathToLedger), { code: "ENOENT" });
  assert.equal(github.calls.create, 0);
  await assert.rejects(() => readFile(`${pathToLedger}.lock`), { code: "ENOENT" });
});

test("publisher uses OS lock ownership without creating path-based lock sidecars", async () => {
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-os-lock-"));
  const lockPath = path.join(runtimeRoot, "events", "g34-source-events.json.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, "partial owner record");
  const result = await publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github: clientFor(event.body) });
  assert.equal(result.state, "DELIVERED");
  assert.equal(await readFile(lockPath, "utf8"), "partial owner record");
});

test("publisher owner exits promptly if its acquired mutex provider dies during an awaited source read", async () => {
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-provider-death-"));
  const source = sourceComment();
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
  const moduleUrl = new URL("../src/g34_source_event_publisher.mjs", import.meta.url).href;
  const script = `
    import { publishSourceEvent } from ${JSON.stringify(moduleUrl)};
    const event = JSON.parse(Buffer.from(process.env.GBB_EVENT, "base64").toString("utf8"));
    const authority = JSON.parse(Buffer.from(process.env.GBB_AUTHORITY, "base64").toString("utf8"));
    const source = JSON.parse(Buffer.from(process.env.GBB_SOURCE, "base64").toString("utf8"));
    const github = {
      async getIssueComment(id) { if (String(id) === source.id) { process.stdout.write("SOURCE_GET_PENDING\\n"); await new Promise(() => setInterval(() => {}, 1000)); } return source; },
      async getCurrentAuthorityRecords() { return authority; },
      async findEventComments() { return []; },
      async createIssueComment() { throw new Error("must not reach send"); },
    };
    publishSourceEvent({ event, issueNumber: 202, runtimeRoot: process.env.GBB_RUNTIME_ROOT, github, currentAuthority: authority })
      .catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });
  `;
  const child = spawnChild(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    windowsHide: true,
    env: { ...process.env, GBB_EVENT: encoded(event), GBB_AUTHORITY: encoded(authorityRecords),
      GBB_SOURCE: encoded(source), GBB_RUNTIME_ROOT: runtimeRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", () => { if (stdout.includes("SOURCE_GET_PENDING")) resolve(); });
    child.once("error", reject);
    child.once("close", (code) => reject(new Error(`publisher child exited before source read (${code})`)));
  });
  await ready;
  const mutexSuffix = createHash("sha256").update(path.resolve(runtimeRoot).toLocaleLowerCase("en-US"), "utf8").digest("hex");
  const command = `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${child.pid} -and $_.CommandLine -like '*GBB-G34-${mutexSuffix}*' } | Select-Object -ExpandProperty ProcessId`;
  const providerPid = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" }).trim();
  assert.match(providerPid, /^\d+$/, "mutex provider process was not found under the publisher child");
  execFileSync("taskkill.exe", ["/PID", providerPid, "/F"], { stdio: "ignore" });
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, timedOut: true }); }, 7000);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.equal(exit.code, 70, `publisher did not fail closed after provider death; stdout=${stdout}`);
});

for (const [field, mutate] of [
  ["active_control_id/control_conversation_id", (event) => {
    event.active_control_id = "11111111-1111-1111-1111-111111111111";
    event.control_conversation_id = event.active_control_id;
  }],
  ["expected_author", (event) => { event.expected_author = "untrusted-publisher"; }],
]) {
  test(`publisher rejects an event whose ${field} disagrees with live Control authority`, async () => {
    assertImplemented();
    const event = sampleEvent();
    mutate(event);
    event.body = sourceEventPayloadBody(event);
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), `g34-mismatched-${field.replaceAll("/", "-")}-`));
    const github = clientFor(event.body, field === "expected_author"
      ? { sourceComment: { ...sourceComment(), user: { login: "untrusted-publisher" } } }
      : {});

    await assert.rejects(() => publishWithCurrentAuthority({
      event, issueNumber: 202, runtimeRoot, github,
    }), /does not match live Control authority|does not match exact Worker source receipt|exact current Control publisher/);
    assert.equal(github.calls.create, 0);
    await assert.rejects(() => readFile(path.join(runtimeRoot, "events", "g34-source-events.json")), { code: "ENOENT" });
  });
}

test("existing-event dedup validates live Control authority before recording DELIVERED", async () => {
  assertImplemented();
  const event = sampleEvent();
  event.active_control_id = "11111111-1111-1111-1111-111111111111";
  event.control_conversation_id = event.active_control_id;
  event.body = sourceEventPayloadBody(event);
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-existing-event-authority-"));
  const github = clientFor(event.body, { matches: [{ id: "9001" }] });

  await assert.rejects(() => publishWithCurrentAuthority({
    event, issueNumber: 202, runtimeRoot, github,
  }), /does not match live Control authority|does not match exact Worker source receipt/);
  assert.equal(github.calls.create, 0);
  const ledgerPath = path.join(runtimeRoot, "events", "g34-source-events.json");
  let ledger = {};
  try { ledger = JSON.parse(await readFile(ledgerPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  assert.notEqual(ledger[event.event_id]?.state, "DELIVERED");
});

test("SEND_ATTEMPTED recovery validates live authority before reconciling an existing event to DELIVERED", async () => {
  assertImplemented();
  const event = sampleEvent();
  event.active_control_id = "11111111-1111-1111-1111-111111111111";
  event.control_conversation_id = event.active_control_id;
  event.body = sourceEventPayloadBody(event);
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-send-recovery-authority-"));
  const ledgerPath = path.join(runtimeRoot, "events", "g34-source-events.json");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, JSON.stringify({
    [event.event_id]: { state: "SEND_ATTEMPTED", source_comment_id: event.source_comment_id },
  }));
  const github = clientFor(event.body, { matches: [{ id: "9001" }] });

  await assert.rejects(() => publishWithCurrentAuthority({
    event, issueNumber: 202, runtimeRoot, github,
  }), /does not match live Control authority|does not match exact Worker source receipt/);
  assert.equal(github.calls.create, 0);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger[event.event_id].state, "SEND_ATTEMPTED");
});

test("uncertain send is reconciled without blindly reposting", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  const github = clientFor(event.body, { createError: new Error("response lost") });
  await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }), /UNCERTAIN_SEND/);
  const retry = await publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github });
  assert.equal(retry.state, "UNCERTAIN_SEND");
  assert.equal(github.calls.create, 1);
});

test("a repeated resident publication preserves uncertain successor delivery and never resets it", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  await mkdir(path.join(runtimeRoot, "events"));
  await writeFile(path.join(runtimeRoot, "events", "g34-source-events.json"), JSON.stringify({
    [event.event_id]: {
      state: "SUCCESSOR_DELIVERY_UNCERTAIN", source_comment_id: event.source_comment_id,
      comment_id: "9001", control_comment_id: "8001", successor_comment_id: "8002",
    },
  }));
  let creates = 0;
  const github = {
    async getCommit(sha) { return { sha, tree: { sha: "d".repeat(40) }, parents: [] }; },
    async findEventComments() { return [{ id: "9001" }]; },
    async createIssueComment() { creates++; throw new Error("must not resend"); },
    async getIssueComment(id) {
      if (String(id) === event.source_comment_id) return sourceComment();
      assert.equal(id, "9001");
      return { id, url: "https://github.com/D22977/gpt-browser-bridge/issues/202#issuecomment-9001", user: { login: "D22977" }, body: event.body };
    },
  };
  assert.equal((await publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github })).state, "DELIVERY_UNCERTAIN");
  const ledger = JSON.parse(await readFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "SUCCESSOR_DELIVERY_UNCERTAIN");
  assert.equal(creates, 0);
});

test("duplicate source-event matches fail closed", async () => {
  assertImplemented();
  const event = sampleEvent();
  const github = clientFor(event.body, { matches: [{ id: "1" }, { id: "2" }] });
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }), /DUPLICATE_EVENT/);
  assert.equal(github.calls.create, 0);
});

test("source event cannot be marked CONSUMED without a successor delivery attempt and confirmation", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  await publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github: clientFor(event.body) });
  const args = { eventId: event.event_id, sourceCommentId: event.source_comment_id, controlCommentId: "8001", runtimeRoot };
  await assert.rejects(() => markSourceEventConsumed(args), /successor delivery attempt/);
  const ledger = JSON.parse(await readFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "DELIVERED");
});

test("corrupt ledger fails closed before a GitHub create call", async () => {
  assertImplemented();
  const event = sampleEvent();
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-events-"));
  await mkdir(path.join(runtimeRoot, "events"));
  await writeFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "not-json");
  const github = clientFor(event.body);
  await assert.rejects(() => publishWithCurrentAuthority({ event, issueNumber: 202, runtimeRoot, github }), /cannot read G34 event ledger/);
  assert.equal(github.calls.create, 0);
});
