import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseActiveControlAuthority } from "../src/g34_contract.mjs";
import { authorizeControlSuccessor, consumeDeliveredControlSuccessor, runG34ResidentCycle } from "../src/g34_resident.mjs";

const authorityRecords = {
  "switchReceipt": {
    "id": 5997153160,
    "url": "https://github.com/D22977/gpt-browser-bridge/issues/88#issuecomment-5997153160",
    "user": {
      "login": "D22977",
      "name": "D22977",
      "email": null,
      "avatar_url": "https://avatars.githubusercontent.com/u/55701413?v=4",
      "id": 55701413
    },
    "body": "CONTROL_GENERATION_ATOMIC_SWITCH_V1\nstate: ACTIVE_SWITCH_COMMITTED_READBACK_REQUIRED\nrecorded_by_role: LOCAL_CONTROL_TRANSPORT\nrepository: D22977/gpt-browser-bridge\nrotation_id: GBB-CONTROL-ROTATION-033-034-20261005-01\nidempotency_key: GBB-CONTROL-G34-ATOMIC-SWITCH-20261005-01\n\nAUTHORITY_AND_GATES\nsource_previous_active_switch: #88/5921509976 exact GET matched\nsource_previous_active_rehydration_ack: #88/5921541952 exact GET matched\nsource_rotation: #88/5996361577 exact GET matched; conditional switch gates satisfied\ncandidate_binding: #88/5996425489 exact GET matched\ncandidate_generation_ACK: #88/5996475036 exact GET matched\ncandidate_continuity_ACK: #88/5996481102 exact GET matched\ncandidate_route_request_and_one_send: #88/5996530780 exact GET matched; one URL-only send and exact ACK observed\ncandidate_canary_result: #88/5996822042 exact GET matched; prior URL typo preserved\ncandidate_result_correction_request: #88/5997016543 exact GET matched\ncandidate_result_correction: #88/5997032073 exact GET matched; canonical target URL reconciled\nprior_R3: #88/5996926532 exact GET matched; missed URL mismatch and not accepted for switch\nfresh_independent_R3: #88/5997109138 exact GET matched; PASS_R3_CANARY_TRANSPORT_ONLY and URL discrepancy reconciled\ncurrent_start_before_switch: #43/5995536451 V245 exact GET matched\ncurrent_registry_before_switch: #81/5995555623 V141 exact GET matched\npre_switch_live_identity_and_platform_check: 2026-10-05T15:02:33Z; exact 034 conversation_id/URL/title/project membership matched; idle; no visible length or platform confirmation gate\ncompeting_rotation_or_switch_check: one small Issue #88 comments GET since 2026-10-05T14:59:36Z, per_page=30; returned #5997109138 only; no competing rotation/switch\n\nOLD_CONTROL\ngeneration: 033\nstatus_before: SOLE_ACTIVE_UNTIL_VALID_ATOMIC_SWITCH\nstatus_after: RETIRED\nconversation_id: 6abd98f5-5808-83e8-852c-f01a16cebf24\nconversation_url: https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhuan-an/c/6abd98f5-5808-83e8-852c-f01a16cebf24\n\nNEW_CONTROL\ngeneration: 034\ndisplay_name: 控制塔-034\nstatus_before: CANDIDATE_ACKED_CONTINUITY_ROUTE_PROVEN_URL_CORRECTED_R3_V2_PASS_NOT_ACTIVE\nstatus_after: ACTIVE\nconversation_id: 6ac3b22a-a830-83ee-bd71-85838e5f1392\nconversation_url: https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhuan-an/c/6ac3b22a-a830-83ee-bd71-85838e5f1392\nsingle_active_control: true\ngeneration032: EXHAUSTED_NEVER_ACTIVE\npre_switch_candidate_active: false\npost_switch_candidate_active: true\n\nPRESERVED_WORK_AND_BOUNDARIES\nowner_restoration_goal: #43/5921003901 NOT_COMPLETE\ncurrent_start_and_registry_preserved_pre_switch: #43/5995536451 V245 and #81/5995555623 V141\nlatest_test_only_closeout: #162/5986648408 V9 FINAL_CONTROL_ACCEPTED_TEST_ONLY_REPAIR\nresidual_card: #162/5995937256 V3\nresidual_worker_start: #162/5996002623\nresidual_worker_terminal: #162/5996042154 BLOCKED_AMBIGUOUS_RESIDUAL_TARGET; not adjudicated by this switch\nnon_durable_UI_claim: #162/5996037281 NOT_DURABLE / exact GET HTTP 404\noriginal_canary_send_count: 1\noriginal_canary_event_replayed: false\nsemantic_adjudication: false\nworker_dispatched: false\nindex_update_in_this_switch: false\nruntime_product_mutation_activation_review_merge_release_deploy: false\ngeneration034_lease: NONE\nmatching_fresh_heartbeat: NONE\nwatcher_running: false\nmonitoring_claimed: false\nuser_relay_count: 0\n\nPOST_SWITCH\nnext_action: after exact-reading this switch, publish/read back current #43/#81 indexes bound to this switch, then send exactly one minimal active-rehydration pointer to generation 034 and exact-read its own ACTIVE_CONTROL_REHYDRATION_ACK_V1 before semantic work\nfirst_semantic_successor_after_rehydration: Active Control adjudication of #162/5996042154; do not replay the Luna wake and do not act on #162/5996037281\nsemantic_work_authorized_now: false\nruntime_product_mutation_activation_review_merge_release_deploy: false\nreadback_required: true"
  },
  "rehydrationAck": {
    "id": 5997220300,
    "url": "https://github.com/D22977/gpt-browser-bridge/issues/88#issuecomment-5997220300",
    "user": {
      "login": "D22977",
      "name": "D22977",
      "email": null,
      "avatar_url": "https://avatars.githubusercontent.com/u/55701413?v=4",
      "id": 55701413
    },
    "body": "ACTIVE_CONTROL_REHYDRATION_ACK_V1\nstate: ACTIVE_REHYDRATED_ACKNOWLEDGED\nrecorded_by_role: ACTIVE_CONTROL\nrepository: D22977/gpt-browser-bridge\nissue: 88\nrotation_id: GBB-CONTROL-ROTATION-033-034-20261005-01\ngeneration: 034\ndisplay_name: 控制塔-034\nconversation_id: 6ac3b22a-a830-83ee-bd71-85838e5f1392\nconversation_url: https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhuan-an/c/6ac3b22a-a830-83ee-bd71-85838e5f1392\n\nREQUEST_AND_SWITCH\nrequest: #88/5997202272 exact GET matched\natomic_switch: #88/5997153160 exact GET matched\ncurrent_start: #43/5997180468 V246 exact GET matched\ncurrent_registry: #81/5997189759 V142 exact GET matched\ncandidate_binding: #88/5996425489 exact GET matched\ngeneration_ACK: #88/5996475036 exact GET matched\ncontinuity_ACK: #88/5996481102 exact GET matched\noriginal_canary_request: #88/5996530780 exact GET matched\ncandidate_route_result: #88/5996822042 exact GET matched\ncandidate_result_correction: #88/5997032073 exact GET matched\nindependent_R3_v2: #88/5997109138 PASS_R3_CANARY_TRANSPORT_ONLY exact GET matched\n\nACTIVE_STATE\nsole_active_control_generation: 034\nsole_active_control_identity_match: true\nold033_status: RETIRED\ngeneration032_status: EXHAUSTED_NEVER_ACTIVE\nsingle_active_control: true\nstate_pointer_consistency: matched\n\nPRESERVED_WORK\nowner_restoration_goal: #43/5921003901 NOT_COMPLETE exact GET matched\npreserved_residual_terminal: #162/5996042154 BLOCKED_AMBIGUOUS_RESIDUAL_TARGET exact GET matched\nnon_durable_UI_claim: #162/5996037281 NOT_DURABLE / exact GET HTTP 404\nresidual_terminal_adjudicated: false\n\nNO_ACTION_STATE\nsemantic_adjudication_performed: false\nsuccessor_authorized_or_dispatched: false\nruntime_activation_performed: false\nreview_performed: false\ngeneration034_lease: NONE\nmatching_fresh_heartbeat: NONE\nwatcher_running: false\nmonitoring_claimed: false\nworker_rebind_or_dispatch: false\nluna_wake_replayed: false\naction_on_non_durable_5996037281: false\nuser_relay_count: 0\n\nidempotency_key: GBB-CONTROL-G34-ACTIVE-REHYDRATION-ACK-20261005-01\nreadback_required: true"
  },
  "index43": {
    "id": 6020264986,
    "url": "https://github.com/D22977/gpt-browser-bridge/issues/43#issuecomment-6020264986",
    "user": {
      "login": "D22977",
      "name": "D22977",
      "email": null,
      "avatar_url": "https://avatars.githubusercontent.com/u/55701413?v=4",
      "id": 55701413
    },
    "body": "CURRENT_REHYDRATION_INDEX_V264\nstate: G34_OPERATIONAL_SOURCE_RUNTIME_PROVENANCE_SPEC_WORKER_CONSUMED_STARTED\nrecorded_by_role: ACTIVE_CONTROL\nrepository: D22977/gpt-browser-bridge\ncontrol_generation: 034 ACTIVE\nsupersedes: #43/6019929502 V263\nregistry_current: #81/6019938137 V158 exact GET matched\nGitHub_sole_durable_semantic_authority: true\n\nG34_GOVERNANCE_PHASE\ncandidate_branch: work/gbb-g34-option3-governance-rework2-20261006-01\ncandidate_head: a0ac6092f6ad64d3037d2aca1550dd0b42ce4d97\nfresh_gpt-6-sol_high_review: #162/6019411388 exact GET matched / PASS\nControl_ACK: #162/6019488883 exact GET matched / governance phase closeout only\ncandidate remains unmerged; runtime_multi_lane remains NOT_IMPLEMENTED\n\nOWNER_RESTORATION_AUTHORITY_AND_ARCH_RECONCILIATION\nowner_goal: #43/5921003901 exact GET matched / NOT_COMPLETE\nactive G34 switch: #88/5997153160 exact GET matched\nactive rehydration ACK: #88/5997220300 exact GET matched\nfresh read-only inventory: #162/6019861481 exact GET matched\narchitecture review card/binding/dispatch/start: #162/6019888042, #6019896726, #6019903452, #6019917811 exact GET matched\narchitecture review terminal: #162/6019992885 exact GET matched / NEXT_CARD_SPECIFIED\nfinding: G13 is enabled/Ready/IgnoreNew and TEMP is disabled/Parallel; accepted governance resolves static task identity/policy for design. G14 runtime remains stale and incompatible with G34 markers; runtime/source lineage NOT_DURABLY_MAPPED. No mutation or activation authority follows from this.\n\nCURRENT_LEGAL_SUCCESSOR\nprovenance_scope_card: #162/6020132060 exact GET matched / READ_ONLY_PROVENANCE_AND_IMPLEMENTATION_SCOPE\nbinding: #162/6020168250 exact GET matched\ndispatch: #162/6020183397 exact GET matched / DISPATCH_REQUEST_WRITTEN\nworker_start: #162/6020230765 exact GET matched / CONSUMED_STARTED\nworker: /root/gbb_g34_source_runtime_provenance_luna_worker_01 / gpt-6-luna / xhigh / executor_kind=MODEL_SUBAGENT\nHerdr_visible_worker: NOT_BOUND; this bounded subagent analysis does not satisfy the owner's exact visible Herdr executor restoration criterion\nterminal: PENDING\nscope: exact source/runtime provenance and smallest versioned implementation/test scope only; no tests, writes, runtime copy, task/process action, wake, lease, heartbeat, monitor, activation, integration, merge, release, deploy, or product dispatch\nnext: await the exact worker terminal, then Control adjudicates one next card or a typed blocker\noverall_operational_restoration: NOT_COMPLETE\nuser_relay_count: 0\nreadback_required: true\nidempotency_key: CURRENT-REHYDRATION-V264-G34-PROVENANCE-WORKER-20261007-01"
  },
  "index81": {
    "id": 6020285672,
    "url": "https://github.com/D22977/gpt-browser-bridge/issues/81#issuecomment-6020285672",
    "user": {
      "login": "D22977",
      "name": "D22977",
      "email": null,
      "avatar_url": "https://avatars.githubusercontent.com/u/55701413?v=4",
      "id": 55701413
    },
    "body": "CURRENT_REGISTRY_INDEX_V159\nstate: G34_OPERATIONAL_SOURCE_RUNTIME_PROVENANCE_SPEC_WORKER_CONSUMED_STARTED\nrecorded_by_role: ACTIVE_CONTROL\nrepository: D22977/gpt-browser-bridge\ncontrol_generation: 034 ACTIVE\nsupersedes: #81/6019938137 V158\ncurrent_control: #43/6020264986 V264 exact GET matched\nactive_control_id: 6ac3b22a-a830-83ee-bd71-85838e5f1392\nsingle_active_control: true\nGitHub_sole_durable_semantic_authority: true\n\nGOVERNANCE_PHASE\ncandidate_head: a0ac6092f6ad64d3037d2aca1550dd0b42ce4d97\nformal_review: #162/6019411388 exact GET matched / PASS / gpt-6-sol high\nControl_ACK: #162/6019488883 exact GET matched / governance closeout only\ncandidate remains unmerged; runtime multi-lane remains NOT_IMPLEMENTED\n\nRUNTIME_AND_ARCHITECTURE\ninventory_receipt: #162/6019861481 exact GET matched\narchitecture_review_terminal: #162/6019992885 exact GET matched / NEXT_CARD_SPECIFIED\nG13 enabled Ready / IgnoreNew; TEMP disabled / Parallel\nlocal watcher and state remain G14; runtime-to-repository lineage NOT_DURABLY_MAPPED\nno resident liveness, G34 consume, or activation proven\n\nCURRENT_WORKER\ncard: #162/6020132060 exact GET matched\nbinding: #162/6020168250 exact GET matched\ndispatch: #162/6020183397 exact GET matched\nCONSUMED_STARTED: #162/6020230765 exact GET matched\nworker: /root/gbb_g34_source_runtime_provenance_luna_worker_01 / gpt-6-luna / xhigh / MODEL_SUBAGENT\nHerdr_visible_worker: NOT_BOUND; no Luna was present in fresh Herdr list; this read-only subtask does not satisfy the final exact visible Herdr executor criterion\nterminal: PENDING\nscope: read-only exact lineage and implementation/test allowlist specification; no mutation, tests, activation, copy, integration, task/process action, or transport action\n\nowner_goal: #43/5921003901 exact GET matched / NOT_COMPLETE\noverall_operational_restoration: NOT_COMPLETE\nnext: await exact worker terminal, then Control publishes one next card or a typed blocker\nuser_relay_count: 0\nreadback_required: true\nidempotency_key: CURRENT-REGISTRY-034-V159-G34-PROVENANCE-WORKER-20261007-01"
  }
};
const authority = parseActiveControlAuthority(structuredClone(authorityRecords));
const event = {
  event_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  state: "DELIVERED",
  source_comment_id: "6083328488",
  comment_id: "9001",
  source_issue_number: 211,
  source_repository_full_name: "D22977/gpt-browser-bridge",
  expected_author: "D22977",
  source_body_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  body: [
    "marker=GITHUB_SOURCE_EVENT_V1",
    "event_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "source_comment_id=6083328488",
    "source_body_sha256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  ].join("\n"),
};
const activeId = "6ac3b22a-a830-83ee-bd71-85838e5f1392";

function controlReceipt(overrides = {}) {
  const fields = {
    state: "SUCCESSOR_ACCEPTED",
    recorded_by_role: "ACTIVE_CONTROL",
    control_generation: "034",
    active_control_id: activeId,
    source_event_id: event.event_id,
    source_event_comment_id: event.comment_id,
    worker_receipt_comment_id: event.source_comment_id,
    current_switch_comment_id: authority.record_ids.switch_comment_id,
    current_index43_comment_id: authority.record_ids.index43_comment_id,
    current_index81_comment_id: authority.record_ids.index81_comment_id,
    independent_review_comment_id: "8500",
    independent_review_decision: "PASS",
    adjudication_comment_id: "8600",
    adjudication_state: "ACCEPTED",
    semantic_sequence: "WORKER_RECEIPT_SOURCE_EVENT_ACTIVE_CONTROL_ADJUDICATION_INDEPENDENT_REVIEW_CURRENT_CONTROL_ACK",
    successor_count: "1",
    successor_comment_id: "7002",
    successor_agent_session: "session-next",
    successor_pane: "w3:p11",
    successor_terminal: "term-next",
    ...overrides,
  };
  return {
    id: "7001",
    url: "https://github.com/D22977/gpt-browser-bridge/issues/88#issuecomment-7001",
    user: { login: "D22977" },
    body: "CONTROL_SUCCESSOR_ACCEPTANCE_V1\n" + Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n"),
  };
}

function githubFor(receipt, override) {
  return {
    async getCurrentAuthorityRecords() { return structuredClone(authorityRecords); },
    async getIssueComment(id) {
      for (const candidate of Object.values(authorityRecords)) {
        if (String(candidate.id) === String(id)) return structuredClone(candidate);
      }
      if (String(id) === "8500") return {
        id: "8500",
        url: "https://github.com/D22977/gpt-browser-bridge/issues/209#issuecomment-8500",
        user: { login: "D22977" },
        body: "GBB_G34_INDEPENDENT_REVIEW_RESULT_V1\ndecision: PASS\nstate: REVIEW_TERMINAL\nrole: NEW_INDEPENDENT_GPT_6_SOL_HIGH_REVIEWER",
      };
      if (String(id) === "8600") return {
        id: "8600",
        url: "https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-8600",
        user: { login: "D22977" },
        body: `ACTIVE_CONTROL_ADJUDICATION_V1\nstate: ACCEPTED\nrecorded_by_role: ACTIVE_CONTROL\nactive_control_id: ${activeId}\nsource_event_id: ${event.event_id}\nreview_comment_id: 8500`,
      };
      if (String(id) === event.comment_id) return {
        id: event.comment_id,
        url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${event.comment_id}`,
        user: { login: "D22977" },
        body: event.body,
      };
      if (override) return override(id, receipt);
      return structuredClone(receipt);
    },
  };
}

const workerBinding = {
  card_comment_id: "211",
  binding_comment_id: "6001",
  dispatch_comment_id: "6002",
  agent_name: "worker-luna",
  agent_session: "session-worker",
  pane: "collaboration-managed",
  terminal: "collaboration-managed",
  cwd: "C:\\worker\\g34",
  model: "gpt-6-luna",
  reasoning_effort: "low",
  branch: "work/gbb-g34-review-repair-20261009-01",
  base_sha: "a05c12fab0bf68bcdc35fe1170fb9f7eb0aca1b0",
};
function workerComment(id, marker, state, head, overrides = {}) {
  const fields = {
    state,
    card_comment_id: workerBinding.card_comment_id,
    binding_comment_id: workerBinding.binding_comment_id,
    dispatch_comment_id: workerBinding.dispatch_comment_id,
    control_generation: "034",
    control_conversation_id: activeId,
    repository: "D22977/gpt-browser-bridge",
    branch: workerBinding.branch,
    base_sha: workerBinding.base_sha,
    head_sha: head,
    agent_name: workerBinding.agent_name,
    agent_session: workerBinding.agent_session,
    pane: workerBinding.pane,
    terminal: workerBinding.terminal,
    cwd: workerBinding.cwd,
    model: workerBinding.model,
    reasoning_effort: workerBinding.reasoning_effort,
    user_relay_count: "0",
    ...overrides,
  };
  return {
    id,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
    user: { login: "D22977" },
    body: marker + "\n" + Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n"),
  };
}

function fakeSourceGithub(sourceComments) {
  const all = new Map(sourceComments.map((comment) => [comment.id, comment]));
  let nextId = 9001;
  return {
    async getIssueComment(id) { return structuredClone(all.get(String(id))); },
    async findEventComments() { return []; },
    async createIssueComment(issueNumber, body) {
      const id = String(nextId++);
      const comment = {
        id, url: `https://github.com/D22977/gpt-browser-bridge/issues/${issueNumber}#issuecomment-${id}`,
        user: { login: "D22977" }, body,
      };
      all.set(id, comment);
      return { id };
    },
  };
}

test("only exact-read, authenticated current Control acceptance after review and adjudication authorizes one successor", async () => {
  const receipt = controlReceipt();
  assert.deepEqual(await authorizeControlSuccessor({ event, authority, controlReceipt: receipt, github: githubFor(receipt) }), {
    comment_id: "7002", agent_session: "session-next", pane: "w3:p11", terminal: "term-next",
  });
});

test("successor gate rejects markerless, stale, unauthenticated, unreviewed, duplicate, or non-current decisions", async () => {
  const invalid = [
    controlReceipt().body.replace("CONTROL_SUCCESSOR_ACCEPTANCE_V1", "ARBITRARY_COMMENT"),
    controlReceipt({ active_control_id: "7ac3b22a-a830-83ee-bd71-85838e5f1392" }),
    controlReceipt({ independent_review_decision: "PENDING" }),
    controlReceipt({ adjudication_state: "PENDING" }),
    controlReceipt({ successor_count: "2" }),
    controlReceipt({ current_index43_comment_id: "1" }),
  ];
  for (const receipt of invalid) {
    const item = typeof receipt === "string" ? { ...controlReceipt(), body: receipt } : receipt;
    await assert.rejects(() => authorizeControlSuccessor({ event, authority, controlReceipt: item, github: githubFor(item) }));
  }
  const unauthorized = controlReceipt();
  unauthorized.user.login = "not-control";
  await assert.rejects(() => authorizeControlSuccessor({ event, authority, controlReceipt: unauthorized, github: githubFor(unauthorized) }));
  const changedOnReread = controlReceipt();
  await assert.rejects(() => authorizeControlSuccessor({
    event, authority, controlReceipt: changedOnReread,
    github: githubFor(changedOnReread, async () => ({ ...changedOnReread, body: "changed" })),
  }));
});

test("resident publishes only Worker start/result receipts bound to the exact claim, tuple, branch, base, and receipt chain", async () => {
  const start = workerComment("4001", "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1", "CONSUMED_STARTED", workerBinding.base_sha);
  const head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const terminal = workerComment("4002", "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1", "READY_FOR_FRESH_REVIEW", head, {
    worker_start_comment_id: "4001",
  });
  const github = fakeSourceGithub([start, terminal]);
  const results = await runG34ResidentCycle({
    sourceComments: [start, terminal], currentAuthority: structuredClone(authorityRecords), binding: workerBinding,
    issueNumber: 211, runtimeRoot: await mkdtemp(path.join(tmpdir(), "g34-cycle-")), github,
    repositoryFullName: "D22977/gpt-browser-bridge", branch: workerBinding.branch,
    baseSha: workerBinding.base_sha, headSha: head, publisherAuthor: "D22977",
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].event.source_comment_id, "4001");
  assert.equal(results[1].event.source_comment_id, "4002");
  assert.match(results[1].event.body, /worker_start_comment_id=4001/);
});

test("resident rejects a terminal receipt with missing start link or mismatched Worker claim fields", async () => {
  const head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const start = workerComment("4001", "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1", "CONSUMED_STARTED", workerBinding.base_sha);
  const unlinked = workerComment("4002", "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1", "READY_FOR_FRESH_REVIEW", head);
  const altered = workerComment("4003", "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1", "CONSUMED_STARTED", workerBinding.base_sha, {
    card_comment_id: "unrelated-card",
  });
  for (const sourceComments of [[unlinked], [altered]]) {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-cycle-"));
    await assert.rejects(() => runG34ResidentCycle({
      sourceComments, currentAuthority: structuredClone(authorityRecords), binding: workerBinding,
      issueNumber: 211, runtimeRoot,
      github: fakeSourceGithub(sourceComments), repositoryFullName: "D22977/gpt-browser-bridge",
      branch: workerBinding.branch, baseSha: workerBinding.base_sha, headSha: head, publisherAuthor: "D22977",
    }));
  }
  assert.equal(start.id, "4001");
});

test("failed or ambiguous successor delivery is uncertain, never consumed, and reconciles without re-delivery", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-successor-"));
  const eventDir = path.join(runtimeRoot, "events");
  await mkdir(eventDir);
  await writeFile(path.join(eventDir, "g34-source-events.json"), JSON.stringify({
    [event.event_id]: { state: "DELIVERED", source_comment_id: event.source_comment_id, comment_id: event.comment_id },
  }));
  const receipt = controlReceipt();
  let deliveries = 0;
  const args = {
    event, authority, controlReceipt: receipt, github: githubFor(receipt), runtimeRoot,
    deliver: async () => { deliveries++; throw new Error("transport response lost"); },
  };
  assert.equal((await consumeDeliveredControlSuccessor(args)).state, "DELIVERY_UNCERTAIN");
  let ledger = JSON.parse(await readFile(path.join(eventDir, "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "SUCCESSOR_DELIVERY_UNCERTAIN");
  assert.notEqual(ledger[event.event_id].state, "CONSUMED");

  assert.equal((await consumeDeliveredControlSuccessor({
    ...args, reconcile: async () => ({ state: "UNRESOLVED" }),
  })).state, "DELIVERY_UNCERTAIN");
  assert.equal(deliveries, 1);

  assert.equal((await consumeDeliveredControlSuccessor({
    ...args, reconcile: async () => ({ state: "DELIVERED", receipt_id: "9901" }),
  })).state, "CONSUMED");
  assert.equal(deliveries, 1);
  ledger = JSON.parse(await readFile(path.join(eventDir, "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "CONSUMED");
  assert.equal(ledger[event.event_id].successor_delivery_receipt_id, "9901");
});

test("a second delivery call without reconciliation never sends again", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-successor-"));
  const eventDir = path.join(runtimeRoot, "events");
  await mkdir(eventDir);
  await writeFile(path.join(eventDir, "g34-source-events.json"), JSON.stringify({
    [event.event_id]: {
      state: "SUCCESSOR_SEND_ATTEMPTED",
      source_comment_id: event.source_comment_id,
      comment_id: event.comment_id,
      control_comment_id: "7001",
      successor_comment_id: "7002",
    },
  }));
  const receipt = controlReceipt();
  let deliveries = 0;
  const result = await consumeDeliveredControlSuccessor({
    event, authority, controlReceipt: receipt, github: githubFor(receipt), runtimeRoot,
    deliver: async () => { deliveries++; return { state: "DELIVERED", receipt_id: "9901" }; },
  });
  assert.equal(result.state, "DELIVERY_UNCERTAIN");
  assert.equal(deliveries, 0);
});

