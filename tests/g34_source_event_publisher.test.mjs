import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseActiveControlAuthority } from "../src/g34_contract.mjs";

const { createSourceEvent, publishSourceEvent, sourceEventPayloadBody, markSourceEventConsumed } = await import("../src/g34_source_event_publisher.mjs").catch(() => ({}));

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
  return marker + "\n" + Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n");
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
  const calls = { create: 0, exactGet: 0, find: 0 };
  return {
    calls,
    async getCurrentAuthorityRecords() {
      options.onAuthorityRead?.();
      if (options.currentAuthorityRead) return options.currentAuthorityRead();
      return structuredClone(options.authorityRecords?.() ?? authorityRecords);
    },
    async findEventComments() { calls.find++; options.onFind?.(); return options.matches ?? []; },
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
      calls.exactGet++;
      assert.equal(id, "9001");
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

test("terminal source event derives omitted chain fields from its exact linked start", () => {
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
    const event = createSourceEvent({
      sourceComment: source, sourceIssueNumber: 211, sourceRepositoryFullName: "D22977/gpt-browser-bridge",
      eventKind: "WORKER_TERMINAL_RESULT", authority, binding: baseBinding,
      branch: "work/gbb-g34-review-repair-20261009-01", baseSha: item.base_sha, headSha: item.head_sha,
      state: "READY_FOR_FRESH_REVIEW", expectedAuthor: "D22977",
    });
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
  assert.deepEqual(github.calls, { create: 1, exactGet: 1, find: 1 });
  const ledger = JSON.parse(await readFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "DELIVERED");
  assert.equal(ledger[event.event_id].comment_id, "9001");
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
  assert.deepEqual(order, ["find", "authority"]);
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
  const duringRead = JSON.parse(await readFile(pathToLedger, "utf8"));
  assert.equal(duringRead[event.event_id].state, "CLAIMED");

  rejectAuthorityRead(new Error("authority read unavailable"));
  await assert.rejects(() => pendingPublish, /authority read unavailable/);
  const afterFailure = JSON.parse(await readFile(pathToLedger, "utf8"));
  assert.equal(afterFailure[event.event_id].state, "CLAIMED");
  assert.equal(github.calls.create, 0);
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
    const github = clientFor(event.body);

    await assert.rejects(() => publishWithCurrentAuthority({
      event, issueNumber: 202, runtimeRoot, github,
    }), /does not match live Control authority/);
    assert.equal(github.calls.create, 0);
    const ledger = JSON.parse(await readFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "utf8"));
    assert.equal(ledger[event.event_id].state, "CLAIMED");
  });
}

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
    async findEventComments() { return [{ id: "9001" }]; },
    async createIssueComment() { creates++; throw new Error("must not resend"); },
    async getIssueComment(id) {
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
