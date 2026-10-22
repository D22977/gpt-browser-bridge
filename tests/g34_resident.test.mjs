import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseActiveControlAuthority } from "../src/g34_contract.mjs";
import { authorizeControlSuccessor as authorizeControlSuccessorCore, consumeDeliveredControlSuccessor, runG34ResidentCycle } from "../src/g34_resident.mjs";
import { beginSuccessorDelivery, recordSuccessorDelivery } from "../src/g34_source_event_publisher.mjs";

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
  comment_id: "8400",
  head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  tree_sha: "d".repeat(40),
  agent_session: "worker-session-211",
  agent_name: "/root/g34_211_worker_luna1",
  branch: "work/gbb-g34-review-repair-20261009-01",
  claim_comment_id: "3001",
  acceptance_comment_id: "3002",
  binding_comment_id: "3000",
  dispatch_comment_id: "3004",
  source_issue_number: 211,
  source_repository_full_name: "D22977/gpt-browser-bridge",
  expected_author: "D22977",
  source_body_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  body: [
    "marker=GITHUB_SOURCE_EVENT_V1",
    "event_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "source_comment_id=6083328488",
    "source_body_sha256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "claim_comment_id=3001",
    "acceptance_comment_id=3002",
    "binding_comment_id=3000",
    "dispatch_comment_id=3004",
    "agent_name=/root/g34_211_worker_luna1",
    "agent_session=worker-session-211",
    "state=DELIVERED",
    "branch=work/gbb-g34-review-repair-20261009-01",
    "head_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    `tree_sha=${"d".repeat(40)}`,
  ].join("\n"),
};
const activeId = "6ac3b22a-a830-83ee-bd71-85838e5f1392";

const authorizeControlSuccessor = (args) => authorizeControlSuccessorCore({
  ...args,
  publication: args.publication ?? {
    state: "DELIVERED",
    comment_id: args.event.comment_id,
    source_comment_id: args.event.source_comment_id,
  },
});

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
    independent_review_card_issue_number: "219",
    reviewed_exact_head_sha: event.head_sha,
    independent_review_decision: "APPROVE",
    adjudication_comment_id: "8450",
    adjudication_state: "ACCEPTED",
    semantic_sequence: "WORKER_RECEIPT_SOURCE_EVENT_ACTIVE_CONTROL_ADJUDICATION_INDEPENDENT_REVIEW_CURRENT_CONTROL_ACK",
    successor_count: "1",
    successor_comment_id: "9002",
    successor_agent_name: workerBinding.agent_name,
    successor_agent_session: workerBinding.agent_session,
    successor_pane: workerBinding.pane,
    successor_terminal: workerBinding.terminal,
    ...overrides,
  };
  return {
    id: "8701",
    url: "https://github.com/D22977/gpt-browser-bridge/issues/88#issuecomment-8701",
    user: { login: "D22977" },
    body: "CONTROL_SUCCESSOR_ACCEPTANCE_V1\n" + Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n"),
  };
}

function githubFor(receipt, override) {
  const issue211 = (id, body) => ({ id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`, user: { login: "D22977" }, body });
  const workerRecords = new Map([
    ["3000", issue211("3000", `GBB_G036_211_CONTROL_ROUTE_AMENDMENT_V1\nstate: ONE_ALTERNATE_LOW_COST_WORKER_ROUTE_AUTHORIZED\n\nCANDIDATE_BINDING\ntask_name: ${workerBinding.agent_name}\nrole: Worker\nmodel_effort: ${workerBinding.model} / ${workerBinding.reasoning_effort}\nruntime_surface: ${workerBinding.runtime_surface}`)],
    ["3001", issue211("3001", `CLAIM_REQUESTED_V1\nstate: CLAIM_REQUESTED\nwork_order: D22977/gpt-browser-bridge#211\nrole: Worker\nmodel_effort: ${workerBinding.model} / ${workerBinding.reasoning_effort}\nbranch: ${workerBinding.branch}\nexecutor_identity: collaboration task ${workerBinding.agent_name}`)],
    ["3002", issue211("3002", `CLAIM_ACCEPTED_V1\nstate: CLAIM_ACCEPTED\nwork_order: D22977/gpt-browser-bridge#211 / GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1\naccepted_claim: #211/3001 exact GET\nbranch: ${workerBinding.branch}\nexecutor_identity: collaboration task ${workerBinding.agent_name}`)],
    ["3004", issue211("3004", `GBB_211_REVIEW_REMEDIATION_SHIFT_V1\nstate: SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root\nexecutor_identity: collaboration task ${workerBinding.agent_name}\nattempt_id: ${workerBinding.attempt_id}\nlease_id: ${workerBinding.lease_id}\nbranch: ${workerBinding.branch}\nexact_remote_base_sha: ${event.base_sha ?? event.head_sha}`)],
    ["3005", issue211("3005", `GBB_211_REVIEW_REMEDIATION_SHIFT_V1\nstate: SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root\nexecutor_identity: collaboration task ${workerBinding.agent_name}\nattempt_id: ${workerBinding.attempt_id}\nlease_id: ${workerBinding.lease_id}\nbranch: ${workerBinding.branch}\nexact_remote_base_sha: ${event.head_sha}`)],
    ["4001", issue211("4001", `GBB_G34_EXECUTOR_CONSUMED_STARTED_V1\nstate: CONSUMED_STARTED\ncard_comment_id: 211\nclaim_comment_id: 3001\nacceptance_comment_id: 3002\nbinding_comment_id: 3000\ndispatch_comment_id: 3004\nexecutor_identity: collaboration task ${workerBinding.agent_name}\nagent_name: ${workerBinding.agent_name}\nagent_session: ${workerBinding.agent_session}\npane: ${workerBinding.pane}\nterminal: ${workerBinding.terminal}\ncwd: ${workerBinding.cwd}\nmodel: ${workerBinding.model}\nreasoning_effort: ${workerBinding.reasoning_effort}\nbranch: ${workerBinding.branch}\nbase_sha: ${event.base_sha ?? event.head_sha}\nhead_sha: ${event.base_sha ?? event.head_sha}\nlease_id: ${workerBinding.lease_id}\nattempt_id: ${workerBinding.attempt_id}`)],
    [event.source_comment_id, issue211(event.source_comment_id, `GBB_G34_EXECUTOR_CONSUMED_STARTED_V1\nstate: CONSUMED_STARTED\ncard_comment_id: 211\nclaim_comment_id: ${event.claim_comment_id}\nacceptance_comment_id: ${event.acceptance_comment_id}\nbinding_comment_id: ${event.binding_comment_id}\ndispatch_comment_id: ${event.dispatch_comment_id}\nexecutor_identity: collaboration task ${event.agent_name}\nagent_name: ${event.agent_name}\nagent_session: ${event.agent_session}\npane: ${workerBinding.pane}\nterminal: ${workerBinding.terminal}\ncwd: ${workerBinding.cwd}\nmodel: ${workerBinding.model}\nreasoning_effort: ${workerBinding.reasoning_effort}\nbranch: ${event.branch}\nbase_sha: ${event.base_sha ?? event.head_sha}\nhead_sha: ${event.base_sha ?? event.head_sha}\nlease_id: ${workerBinding.lease_id}\nattempt_id: ${workerBinding.attempt_id}\nrepository: D22977/gpt-browser-bridge`)],
    ["9002", issue211("9002", `GBB_G34_EXECUTOR_CONSUMED_STARTED_V1\nstate: CONSUMED_STARTED\ncard_comment_id: 211\nclaim_comment_id: 3001\nacceptance_comment_id: 3002\nbinding_comment_id: 3000\ndispatch_comment_id: 3005\nexecutor_identity: collaboration task ${workerBinding.agent_name}\nagent_name: ${workerBinding.agent_name}\nagent_session: ${workerBinding.agent_session}\npane: ${workerBinding.pane}\nterminal: ${workerBinding.terminal}\ncwd: ${workerBinding.cwd}\nmodel: ${workerBinding.model}\nreasoning_effort: ${workerBinding.reasoning_effort}\nbranch: ${workerBinding.branch}\nbase_sha: ${event.head_sha}\nhead_sha: ${event.head_sha}\nlease_id: ${workerBinding.lease_id}\nattempt_id: ${workerBinding.attempt_id}`)],
  ]);
  for (const startId of ["4001", "9002"]) {
    workerRecords.get(startId).body += "\nrepository: D22977/gpt-browser-bridge";
  }
  return {
    async getCurrentAuthorityRecords() { return structuredClone(authorityRecords); },
    async getIssueComment(id) {
      for (const candidate of Object.values(authorityRecords)) {
        if (String(candidate.id) === String(id)) return structuredClone(candidate);
      }
      if (override) {
        const alternate = await override(id, receipt);
        if (alternate !== undefined) return alternate;
      }
      if (String(id) === "8500") return {
        id: "8500",
        url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8500",
        user: { login: "D22977" },
        body: `GBB_G34_FRESH_INDEPENDENT_REVIEW_RESULT_V1\ndecision: APPROVE\nstate: REVIEW_TERMINAL\ncard: #219\nreviewer_binding_comment_id: 8499\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nreviewer_task_identity: /root/g34_219_sol_high_review\nreviewed_repository: D22977/gpt-browser-bridge\nreviewed_branch: ${workerBinding.branch}\nreviewed_exact_head: ${event.head_sha}\nreviewed_tree: ${"d".repeat(40)}`,
      };
      if (String(id) === "8499") return {
        id: "8499", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8499",
        user: { login: "D22977" },
        body: `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root\nworker_task_identity: ${workerBinding.agent_name}\ncard_issue_number: 219\nreviewer_task_identity: /root/g34_219_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}`,
      };
      if (String(id) === "8450") return {
        id: "8450",
        url: "https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-8450",
        user: { login: "D22977" },
        body: `ACTIVE_CONTROL_ADJUDICATION_V1\nstate: ACCEPTED\nrecorded_by_role: ACTIVE_CONTROL\nactive_control_id: ${activeId}\nsource_event_id: ${event.event_id}\nsource_event_comment_id: ${event.comment_id}`,
      };
      if (String(id) === event.comment_id) return {
        id: event.comment_id,
        url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${event.comment_id}`,
        user: { login: "D22977" }, body: event.body,
      };
      if (workerRecords.has(String(id))) return structuredClone(workerRecords.get(String(id)));
      if (String(id) === "9901") return {
        id: "9901",
        url: "https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-9901",
        user: { login: "D22977" },
        body: `GBB_G34_SUCCESSOR_DELIVERY_RECEIPT_V1\nstate: DELIVERED\nevent_id: ${event.event_id}\nsource_event_comment_id: ${event.comment_id}\ncontrol_comment_id: 8701\nsuccessor_comment_id: 9002\nsuccessor_agent_name: ${workerBinding.agent_name}\nsuccessor_agent_session: ${workerBinding.agent_session}\nsuccessor_pane: ${workerBinding.pane}\nsuccessor_terminal: ${workerBinding.terminal}\nsource_claim_comment_id: ${event.claim_comment_id}\nsource_acceptance_comment_id: ${event.acceptance_comment_id}\nsource_binding_comment_id: ${event.binding_comment_id}\nsource_dispatch_comment_id: ${event.dispatch_comment_id}\nsource_worker_start_comment_id: ${event.worker_start_comment_id ?? event.source_comment_id}\nconsumer_ack_comment_id: 9899`,
      };
      if (String(id) === "9899") return issue211("9899", `GBB_G34_EXECUTOR_CONSUMED_ACK_V1\nstate: CONSUMED_ACK\ncard_comment_id: 211\nevent_id: ${event.event_id}\nsource_event_comment_id: ${event.comment_id}\nsource_claim_comment_id: ${event.claim_comment_id}\nsource_acceptance_comment_id: ${event.acceptance_comment_id}\nsource_binding_comment_id: ${event.binding_comment_id}\nsource_dispatch_comment_id: ${event.dispatch_comment_id}\nsource_worker_start_comment_id: ${event.worker_start_comment_id ?? event.source_comment_id}\ncontrol_comment_id: 8701\nsuccessor_comment_id: 9002\nsuccessor_agent_name: ${workerBinding.agent_name}\nagent_name: ${workerBinding.agent_name}\nagent_session: ${workerBinding.agent_session}\npane: ${workerBinding.pane}\nterminal: ${workerBinding.terminal}\nexecutor_identity: collaboration task ${workerBinding.agent_name}\nclaim_comment_id: 3001\nacceptance_comment_id: 3002\nbinding_comment_id: 3000\ndispatch_comment_id: 3005\nworker_start_comment_id: 9002`);
      if (String(id) === event.comment_id) return {
        id: event.comment_id,
        url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${event.comment_id}`,
        user: { login: "D22977" },
        body: event.body,
      };
      if (override) {
        const alternate = await override(id, receipt);
        if (alternate !== undefined) return alternate;
      }
      return structuredClone(receipt);
    },
    async getIssue(issueNumber) {
      if (Number(issueNumber) !== 219) return null;
      return { number: 219, title: "GBB G34: fresh review of remediation head", body: `GBB_G34_FRESH_REVIEW_REMEDIATION_WORK_ORDER_V1\nstate: OPEN_FOR_ONE_FRESH_INDEPENDENT_REVIEW\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}\nreviewer_binding_comment_id: 8499`, state: "open" };
    },
  };
}

const workerBinding = {
  card_comment_id: "211",
  claim_comment_id: "3001",
  acceptance_comment_id: "3002",
  binding_comment_id: "3000",
  dispatch_comment_id: "3004",
  agent_name: "/root/g34_211_worker_luna1",
  agent_session: "GBB-G036-211-LUNA-COLLAB-G13-20261021-01",
  pane: "collaboration-managed",
  terminal: "collaboration-managed",
    runtime_surface: "collaboration-managed GPT-6 Luna agent session with shared local workspace tools and GitHub MCP connector",
  cwd: "C:\\Users\\Lupun\\AppData\\Local\\codex-with-chatgpt\\GBB-G34-WORKER-211-G036-LUNA-20261021-01",
  model: "gpt-6-luna",
  reasoning_effort: "low",
  branch: "work/gbb-g34-review-repair-20261009-01",
  base_sha: "8fc68fe06231d3c9c07630273f3d0e70bda1f9a6",
  base_tree_sha: "d".repeat(40),
  lease_id: "GBB-211-LEASE-20261021-13",
  attempt_id: "GBB-G036-211-LUNA-COLLAB-G13-20261021-01",
};
function workerComment(id, marker, state, head, overrides = {}) {
  const fields = {
    state,
    card_comment_id: workerBinding.card_comment_id,
    claim_comment_id: workerBinding.claim_comment_id,
    acceptance_comment_id: workerBinding.acceptance_comment_id,
    binding_comment_id: workerBinding.binding_comment_id,
    dispatch_comment_id: workerBinding.dispatch_comment_id,
    executor_identity: `collaboration task ${workerBinding.agent_name}`,
    control_generation: "034",
    control_conversation_id: activeId,
    repository: "D22977/gpt-browser-bridge",
    branch: workerBinding.branch,
    base_sha: workerBinding.base_sha,
    base_tree_sha: workerBinding.base_tree_sha,
    tree_sha: workerBinding.base_tree_sha,
    head_sha: head,
    agent_name: workerBinding.agent_name,
    agent_session: workerBinding.agent_session,
    pane: workerBinding.pane,
    terminal: workerBinding.terminal,
    cwd: workerBinding.cwd,
    model: workerBinding.model,
    reasoning_effort: workerBinding.reasoning_effort,
    runtime_surface: workerBinding.runtime_surface,
    user_relay_count: "0",
    lease_id: workerBinding.lease_id,
    attempt_id: workerBinding.attempt_id,
    ...overrides,
  };
  return {
    id,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
    user: { login: "D22977" },
    body: marker + "\n" + Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n"),
  };
}

function fakeSourceGithub(sourceComments, overrides = {}, firstEventCommentId = 9001) {
  const all = new Map(sourceComments.map((comment) => [comment.id, comment]));
  const linked = [
    [workerBinding.claim_comment_id, `CLAIM_REQUESTED_V1\nstate: CLAIM_REQUESTED\nwork_order: D22977/gpt-browser-bridge#211\nrole: Worker\nmodel_effort: ${workerBinding.model} / ${workerBinding.reasoning_effort}\nbranch: ${workerBinding.branch}\nexecutor_identity: collaboration task ${workerBinding.agent_name}`],
    [workerBinding.acceptance_comment_id, `CLAIM_ACCEPTED_V1\nstate: CLAIM_ACCEPTED\nwork_order: D22977/gpt-browser-bridge#211 / GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1\naccepted_claim: #211/${workerBinding.claim_comment_id}\nbranch: ${workerBinding.branch}\nexecutor_identity: collaboration task ${workerBinding.agent_name}`],
    [workerBinding.binding_comment_id, `GBB_G036_211_CONTROL_ROUTE_AMENDMENT_V1\nstate: ONE_ALTERNATE_LOW_COST_WORKER_ROUTE_AUTHORIZED\n\nCANDIDATE_BINDING\ntask_name: ${workerBinding.agent_name}\nrole: Worker\nmodel_effort: ${workerBinding.model} / ${workerBinding.reasoning_effort}\nruntime_surface: ${workerBinding.runtime_surface}`],
    [workerBinding.dispatch_comment_id, `GBB_211_REVIEW_REMEDIATION_SHIFT_V1\nstate: SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root\nexecutor_identity: collaboration task ${workerBinding.agent_name}\nattempt_id: ${workerBinding.attempt_id}\nlease_id: ${workerBinding.lease_id}\nbranch: ${workerBinding.branch}\nexact_remote_base_sha: ${workerBinding.base_sha}`],
  ];
  for (const [id, body] of linked) all.set(id, { id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`, user: { login: "D22977" }, body });
  let nextId = firstEventCommentId;
  return {
    async getIssueComment(id) { return structuredClone(overrides[String(id)] ?? all.get(String(id))); },
    async getIssue(number) { return { number, state: "open", body: "GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1\nstate: OPEN_FOR_SINGLE_CLAIM" }; },
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
    comment_id: "9002", agent_name: workerBinding.agent_name, agent_session: workerBinding.agent_session,
    pane: workerBinding.pane, terminal: workerBinding.terminal,
  });
});

test("primary authorization rejects a distinct Control identity outside the exact Control dispatch", async () => {
  const receipt = controlReceipt();
  const wrongControlBinding = `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root/another-control\nworker_task_identity: ${event.agent_name}\ncard_issue_number: 219\nreviewer_task_identity: /root/g34_219_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}`;
  const github = githubFor(receipt, (id) => id === "8499" ? {
    id: "8499", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8499",
    user: { login: "D22977" }, body: wrongControlBinding,
  } : undefined);
  await assert.rejects(() => authorizeControlSuccessor({ event, authority, controlReceipt: receipt, github }));
});

test("primary authorization accepts the actual #223 candidate card with its exact tree pin", async () => {
  const cardTree = "c8b65ef8d9496286ce9f254504b1945fdf65979a";
  const cardHead = "62c4c8e9433fa0ae4e23e8e54645c64db464b264";
  const actualEvent = {
    ...event, head_sha: cardHead, tree_sha: cardTree,
    body: event.body.replace(`head_sha=${event.head_sha}`, `head_sha=${cardHead}`)
      .replace(`branch=${event.branch}`, `branch=${workerBinding.branch}`)
      .replace(`tree_sha=${event.tree_sha}`, `tree_sha=${cardTree}`),
  };
  const receipt = controlReceipt({
    source_event_id: actualEvent.event_id, source_event_comment_id: actualEvent.comment_id,
    worker_receipt_comment_id: actualEvent.source_comment_id,
    independent_review_card_issue_number: "223", reviewed_exact_head_sha: cardHead,
  });
  const actualCard = {
    number: 223, state: "open",
    body: `GBB_G34_FRESH_REVIEW_REMEDIATION_WORK_ORDER_V1\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_base_sha: e21dfc19329c167c4ed0fbedf091a5fdb9a27960\ncandidate_exact_head_sha: ${cardHead}\ncandidate_tree_sha: ${cardTree}\nreviewer_binding_comment_id: 8499`,
  };
  const bindingBody = `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root\ncard_issue_number: 223\nreviewer_task_identity: /root/g34_223_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\nparent_work_order: D22977/gpt-browser-bridge#211\nworker_task_identity: ${actualEvent.agent_name}\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_base_sha: e21dfc19329c167c4ed0fbedf091a5fdb9a27960\ncandidate_exact_head_sha: ${cardHead}\ncandidate_tree_sha: ${cardTree}`;
  const reviewBody = `GBB_G34_FRESH_INDEPENDENT_REVIEW_RESULT_V1\ndecision: APPROVE\nstate: REVIEW_TERMINAL\ncard: #223\nreviewer_binding_comment_id: 8499\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nreviewer_task_identity: /root/g34_223_sol_high_review\nreviewed_repository: D22977/gpt-browser-bridge\nreviewed_branch: ${workerBinding.branch}\nreviewed_exact_head: ${cardHead}\nreviewed_tree: ${cardTree}`;
  const github = githubFor(receipt, (id) => id === "8499" ? {
    id: "8499", url: "https://github.com/D22977/gpt-browser-bridge/issues/223#issuecomment-8499",
    user: { login: "D22977" }, body: bindingBody,
  } : id === "8500" ? {
    id: "8500", url: "https://github.com/D22977/gpt-browser-bridge/issues/223#issuecomment-8500",
    user: { login: "D22977" }, body: reviewBody,
  } : id === actualEvent.comment_id ? {
    id: actualEvent.comment_id,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${actualEvent.comment_id}`,
    user: { login: "D22977" }, body: actualEvent.body,
  } : undefined);
  github.getIssue = async (number) => Number(number) === 223 ? actualCard : null;
  assert.deepEqual(await authorizeControlSuccessor({ event: actualEvent, authority, controlReceipt: receipt, github }), {
    comment_id: "9002", agent_name: workerBinding.agent_name, agent_session: workerBinding.agent_session,
    pane: workerBinding.pane, terminal: workerBinding.terminal,
  });
});

test("successor gate rejects markerless, stale, unauthenticated, unreviewed, duplicate, or non-current decisions", async () => {
  const invalid = [
    controlReceipt().body.replace("CONTROL_SUCCESSOR_ACCEPTANCE_V1", "ARBITRARY_COMMENT"),
    controlReceipt({ active_control_id: "7ac3b22a-a830-83ee-bd71-85838e5f1392" }),
    controlReceipt({ independent_review_decision: "FIX_REQUIRED" }),
    controlReceipt({ adjudication_state: "PENDING" }),
    controlReceipt({ successor_count: "2" }),
    controlReceipt({ current_index43_comment_id: "1" }),
    controlReceipt({ independent_review_card_issue_number: "218" }),
    controlReceipt({ independent_review_comment_id: "1" }),
    controlReceipt({ reviewed_exact_head_sha: "cccccccccccccccccccccccccccccccccccccccc" }),
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

test("review approval cannot self-assert an identity or head outside the exact review card binding", async () => {
  const receipt = controlReceipt();
  await assert.rejects(() => authorizeControlSuccessor({
    event, authority, controlReceipt: receipt,
    github: githubFor(receipt, (id) => id === "8500" ? {
      id: "8500", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8500",
      user: { login: "D22977" },
      body: `GBB_G34_FRESH_INDEPENDENT_REVIEW_RESULT_V1\ndecision: PASS\nstate: REVIEW_TERMINAL\ncard: #219\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nreviewer_task_identity: ${workerBinding.agent_name}\nreviewed_repository: D22977/gpt-browser-bridge\nreviewed_branch: ${workerBinding.branch}\nreviewed_exact_head: ${event.head_sha}\nreviewed_tree: ${"d".repeat(40)}`,
    } : undefined),
  }));
  await assert.rejects(() => authorizeControlSuccessor({
    event, authority, controlReceipt: controlReceipt({ reviewed_exact_head_sha: "cccccccccccccccccccccccccccccccccccccccc" }),
    github: githubFor(controlReceipt()),
  }));
  await assert.rejects(() => authorizeControlSuccessor({
    event, authority, controlReceipt: controlReceipt(),
    github: githubFor(controlReceipt(), (id) => id === "8499" ? {
      id: "8499", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8499",
      user: { login: "D22977" },
      body: `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root\nworker_task_identity: ${workerBinding.agent_name}\ncard_issue_number: 219\nreviewer_task_identity: ${workerBinding.agent_name}\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}`,
    } : undefined),
  }));

  for (const badBinding of [
    `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: D22977\ncontrol_task_identity: /root\nworker_task_identity: ${workerBinding.agent_name}\ncard_issue_number: 219\nreviewer_task_identity: /root/g34_219_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}`,
    `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root/g34_219_sol_high_review\nworker_task_identity: ${workerBinding.agent_name}\ncard_issue_number: 219\nreviewer_task_identity: /root/g34_219_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}`,
  ]) {
    await assert.rejects(() => authorizeControlSuccessor({
      event, authority, controlReceipt: controlReceipt(),
      github: githubFor(controlReceipt(), (id) => id === "8499" ? {
        id: "8499", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8499",
        user: { login: "D22977" }, body: badBinding,
      } : undefined),
    }));
  }

  for (const controlTaskIdentity of [
    event.agent_name,
    event.agent_session,
    `collaboration task ${event.agent_name}`,
  ]) {
    const workerCollisionBinding = `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: ${controlTaskIdentity}\nworker_task_identity: ${workerBinding.agent_name}\ncard_issue_number: 219\nreviewer_task_identity: /root/g34_219_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}`;
    const collidedGithub = githubFor(controlReceipt(), (id) => id === "8499" ? {
      id: "8499", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8499",
      user: { login: "D22977" }, body: workerCollisionBinding,
    } : undefined);
    await assert.rejects(() => authorizeControlSuccessor({
      event, authority, controlReceipt: controlReceipt(), github: collidedGithub,
    }));
  }

  const lateBindingGithub = githubFor(controlReceipt(), (id) => id === "8501" ? {
    id: "8501", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8501",
    user: { login: "D22977" },
    body: `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root\nworker_task_identity: ${workerBinding.agent_name}\ncard_issue_number: 219\nreviewer_task_identity: /root/g34_219_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}`,
  } : id === "8500" ? {
    id: "8500", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8500",
    user: { login: "D22977" },
    body: `GBB_G34_FRESH_INDEPENDENT_REVIEW_RESULT_V1\ndecision: APPROVE\nstate: REVIEW_TERMINAL\ncard: #219\nreviewer_binding_comment_id: 8501\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nreviewer_task_identity: /root/g34_219_sol_high_review\nreviewed_repository: D22977/gpt-browser-bridge\nreviewed_branch: ${workerBinding.branch}\nreviewed_exact_head: ${event.head_sha}\nreviewed_tree: ${"d".repeat(40)}`,
  } : undefined);
  lateBindingGithub.getIssue = async () => ({
    number: 219, title: "review", body: `GBB_G34_FRESH_REVIEW_REMEDIATION_WORK_ORDER_V1\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}\nreviewer_binding_comment_id: 8501`, state: "open",
  });
  await assert.rejects(() => authorizeControlSuccessor({
    event, authority, controlReceipt: controlReceipt(), github: lateBindingGithub,
  }));

  const wrongTreeGithub = githubFor(controlReceipt(), (id) => id === "8500" ? {
    id: "8500", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8500",
    user: { login: "D22977" },
    body: `GBB_G34_FRESH_INDEPENDENT_REVIEW_RESULT_V1\ndecision: APPROVE\nstate: REVIEW_TERMINAL\ncard: #219\nreviewer_binding_comment_id: 8499\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nreviewer_task_identity: /root/g34_219_sol_high_review\nreviewed_repository: D22977/gpt-browser-bridge\nreviewed_branch: ${workerBinding.branch}\nreviewed_exact_head: ${event.head_sha}\nreviewed_tree: ${"e".repeat(40)}`,
  } : undefined);
  await assert.rejects(() => authorizeControlSuccessor({
    event, authority, controlReceipt: controlReceipt(), github: wrongTreeGithub,
  }));
});

test("resident publishes only Worker start/result receipts bound to the exact claim, tuple, branch, base, and receipt chain", async () => {
  const start = workerComment("4001", "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1", "CONSUMED_STARTED", workerBinding.base_sha);
  const head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const terminal = workerComment("4002", "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1", "READY_FOR_FRESH_REVIEW", head, {
    tree_sha: "d".repeat(40),
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

test("resident derives the source chain from the exact sparse G14 terminal and linked G14 start", async () => {
  const issue211 = (id, body) => ({ id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`, user: { login: "D22977" }, body });
  const actual = {
    "6306219207": issue211("6306219207", `GBB_G036_211_CONTROL_ROUTE_AMENDMENT_V1\nstate: ONE_ALTERNATE_LOW_COST_WORKER_ROUTE_AUTHORIZED\nrecorded_by_role: ACTIVE_CONTROL\nrepository: D22977/gpt-browser-bridge\nissue: #211\nsource_work_order: GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1\ncontrol_generation: 036 ACTIVE\n\nCANDIDATE_BINDING\ntask_name: /root/g34_211_worker_luna1\nrole: Worker\nruntime_surface: fresh collaboration-managed GPT-6 Luna agent session with shared local workspace tools and GitHub MCP connector\nmodel_effort: gpt-6-luna / low`),
    "6306230204": issue211("6306230204", `CLAIM_REQUESTED_V1\nstate: CLAIM_REQUESTED\nwork_order: D22977/gpt-browser-bridge#211\nexecutor_identity: collaboration task /root/g34_211_worker_luna1 (fresh collaboration-managed session)\nrole: Worker\nmodel_effort: gpt-6-luna / low\nbranch: ${workerBinding.branch}`),
    "6306245339": issue211("6306245339", `CLAIM_ACCEPTED_V1\nstate: CLAIM_ACCEPTED\nwork_order: D22977/gpt-browser-bridge#211 / GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1\naccepted_claim: #211/6306230204 exact GET\nexecutor_identity: collaboration task /root/g34_211_worker_luna1; fresh collaboration-managed session\nrole/model_effort: Worker / gpt-6-luna low\nbranch: ${workerBinding.branch}`),
    "6308671466": issue211("6308671466", `GBB_211_REVIEW_REMEDIATION_SHIFT_V1\nstate: SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES\nexecutor_identity: collaboration task /root/g34_211_worker_luna1\nlease_id: GBB-211-LEASE-20261021-14\nlease_generation: 14\nattempt_id: GBB-G036-211-LUNA-COLLAB-G14-20261021-01\nbranch: ${workerBinding.branch}\nexact_remote_base_sha: 9a1fb30b79cb64b26b81180483924ad1a2227cee`),
    "6308694953": issue211("6308694953", `GBB_G34_EXECUTOR_CONSUMED_STARTED_V1\nstate: CONSUMED_STARTED\nwork_order: D22977/gpt-browser-bridge#211 / GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1\nexecutor_identity: collaboration task /root/g34_211_worker_luna1\nrole: Worker\nmodel_effort: gpt-6-luna / low\nmodel: gpt-6-luna\nreasoning_effort: low\nruntime_surface: fresh collaboration-managed GPT-6 Luna agent session with shared local workspace tools and GitHub MCP connector\npublisher_identity: GitHub D22977 (publication identity distinct from executor identity)\ncard_comment_id: 211\nclaim_comment_id: 6306230204\nacceptance_comment_id: 6306245339\nbinding_comment_id: 6306219207\ndispatch_comment_id: 6308671466\ncontrol_generation: 034\ncontrol_conversation_id: ${activeId}\nagent_name: /root/g34_211_worker_luna1\nagent_session: GBB-G036-211-LUNA-COLLAB-G14-20261021-01\npane: collaboration-managed\nterminal: collaboration-managed\ncwd: ${workerBinding.cwd}\nrepository: D22977/gpt-browser-bridge\nlease_id: GBB-211-LEASE-20261021-14\nlease_generation: 14\nattempt_id: GBB-G036-211-LUNA-COLLAB-G14-20261021-01\nbranch: ${workerBinding.branch}\nbase_sha: 9a1fb30b79cb64b26b81180483924ad1a2227cee\nbase_tree_sha: bf50166719f641c5f06c935953767c1936ba9ec2\nhead_sha: 9a1fb30b79cb64b26b81180483924ad1a2227cee\nuser_relay_count: 0\nsource_access_state: NO_WORKTREE_OR_SOURCE_OR_TESTS_ACCESSED_BEFORE_THIS_START`),
    "6308893422": issue211("6308893422", `GBB_G34_EXECUTOR_TERMINAL_RESULT_V1\nstate: READY_FOR_FRESH_REVIEW\ntask_identity: /root/g34_211_worker_luna1\nrole: Worker\nmodel_effort: gpt-6-luna / low\nsession_surface: collaboration-managed\npublisher: D22977\nexecutor_identity: collaboration task /root/g34_211_worker_luna1\nlease_id: GBB-211-LEASE-20261021-14\nlease_generation: 14\nattempt_id: GBB-G036-211-LUNA-COLLAB-G14-20261021-01\nworker_start_comment_id: 6308694953\ncontrol_publication_readback_comment_id: 6308879515\nbranch: ${workerBinding.branch}\nbase_sha: 9a1fb30b79cb64b26b81180483924ad1a2227cee\nlocal_tested_commit: d04b56fdb3bbe41281c858cf6e9705f56d42e4b1\nlocal_tested_tree: 9ad949d21072b3e4a9733d42f8afa92ebcef530f\nremote_commit: c7e3b1d53b3fa5e94f7fa4c8701fda9c97760d1f\nremote_parent: 9a1fb30b79cb64b26b81180483924ad1a2227cee\nremote_tree: 9ad949d21072b3e4a9733d42f8afa92ebcef530f\nexact_branch_ref_readback: refs/heads/work/gbb-g34-review-repair-20261009-01 -> c7e3b1d53b3fa5e94f7fa4c8701fda9c97760d1f\nexact_commit_readback: commit c7e3b1d53b3fa5e94f7fa4c8701fda9c97760d1f; parent 9a1fb30b79cb64b26b81180483924ad1a2227cee; tree 9ad949d21072b3e4a9733d42f8afa92ebcef530f\nexact_recursive_tree_readback: 9ad949d21072b3e4a9733d42f8afa92ebcef530f; 154 entries; truncated=false\nverified_blob_paths:\nsrc/g34_contract.mjs: aea54ee7dfacd28fa501ff1c17732b2a7c6d0248\nsrc/g34_resident.mjs: 97526964acc3c085983935db7ac93a171edfbe9f\nsrc/g34_source_event_publisher.mjs: 14fd5e585f6b02a0a513af791932f47bf450d3b5\ntests/g34_contract.test.mjs: 7199c37e2088f8b4d24cbfdf9ba4593cd1e9844d\ntests/g34_resident.test.mjs: 0789352a7b3761b2373ec7ef3b70ec08c66fc7ad\ntests/g34_source_event_publisher.test.mjs: b6049e0544110a82a8a7c13d878e459a6d797ac8\nfocused_validation: node --test tests/g34_resident.test.mjs tests/g34_source_event_publisher.test.mjs tests/g34_contract.test.mjs — PASS 22/22\nfull_validation: npm test — PASS 197/197\ndiff_check: git diff --check — PASS`),
  };
  const terminal = actual["6308893422"];
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-actual-g14-"));
  const result = await runG34ResidentCycle({
    sourceComments: [terminal], currentAuthority: structuredClone(authorityRecords), binding: workerBinding,
    issueNumber: 211, runtimeRoot, github: fakeSourceGithub([terminal], actual),
    repositoryFullName: "D22977/gpt-browser-bridge", branch: workerBinding.branch,
    baseSha: "9a1fb30b79cb64b26b81180483924ad1a2227cee", headSha: "c7e3b1d53b3fa5e94f7fa4c8701fda9c97760d1f", publisherAuthor: "D22977",
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].event.source_comment_id, "6308893422");
  assert.match(result[0].event.body, /worker_start_comment_id=6308694953/);
  assert.match(result[0].event.body, /claim_comment_id=6306230204/);
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

test("resident rejects a source receipt when the exact-read accepted claim names another executor", async () => {
  const start = workerComment("4001", "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1", "CONSUMED_STARTED", workerBinding.base_sha);
  const forgedClaim = {
    id: workerBinding.acceptance_comment_id,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${workerBinding.acceptance_comment_id}`,
    user: { login: "D22977" },
    body: `CLAIM_ACCEPTED_V1\nstate: CLAIM_ACCEPTED\nwork_order: D22977/gpt-browser-bridge#211\naccepted_claim: #211/${workerBinding.claim_comment_id}\nbranch: ${workerBinding.branch}\nexecutor_identity: collaboration task /root/some-other-worker`,
  };
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-cycle-"));
  await assert.rejects(() => runG34ResidentCycle({
    sourceComments: [start], currentAuthority: structuredClone(authorityRecords), binding: workerBinding,
    issueNumber: 211, runtimeRoot,
    github: fakeSourceGithub([start], { [workerBinding.acceptance_comment_id]: forgedClaim }),
    repositoryFullName: "D22977/gpt-browser-bridge", branch: workerBinding.branch,
    baseSha: workerBinding.base_sha, headSha: workerBinding.base_sha, publisherAuthor: "D22977",
  }), /Worker chain/);

  const prefixCollision = {
    ...forgedClaim,
    body: `CLAIM_ACCEPTED_V1\nstate: CLAIM_ACCEPTED\nwork_order: D22977/gpt-browser-bridge#211 / GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1\naccepted_claim: #211/${workerBinding.claim_comment_id} exact GET\nbranch: ${workerBinding.branch}\nexecutor_identity: collaboration task ${workerBinding.agent_name}_other`,
  };
  const prefixRuntimeRoot = await mkdtemp(path.join(tmpdir(), "g34-cycle-"));
  await assert.rejects(() => runG34ResidentCycle({
    sourceComments: [start], currentAuthority: structuredClone(authorityRecords), binding: workerBinding,
    issueNumber: 211, runtimeRoot: prefixRuntimeRoot,
    github: fakeSourceGithub([start], { [workerBinding.acceptance_comment_id]: prefixCollision }),
    repositoryFullName: "D22977/gpt-browser-bridge", branch: workerBinding.branch,
    baseSha: workerBinding.base_sha, headSha: workerBinding.base_sha, publisherAuthor: "D22977",
  }), /Worker chain/);

  const substringCollision = {
    id: workerBinding.dispatch_comment_id,
    url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${workerBinding.dispatch_comment_id}`,
    user: { login: "D22977" },
    body: `GBB_211_REVIEW_REMEDIATION_SHIFT_V1\nstate: SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES\nexecutor_identity: collaboration task /root/other-worker; refers to ${workerBinding.agent_name}\nattempt_id: ${workerBinding.attempt_id}\nlease_id: ${workerBinding.lease_id}\nbranch: ${workerBinding.branch}\nexact_remote_base_sha: ${workerBinding.base_sha}`,
  };
  const substringRuntimeRoot = await mkdtemp(path.join(tmpdir(), "g34-cycle-"));
  await assert.rejects(() => runG34ResidentCycle({
    sourceComments: [start], currentAuthority: structuredClone(authorityRecords), binding: workerBinding,
    issueNumber: 211, runtimeRoot: substringRuntimeRoot,
    github: fakeSourceGithub([start], { [workerBinding.dispatch_comment_id]: substringCollision }),
    repositoryFullName: "D22977/gpt-browser-bridge", branch: workerBinding.branch,
    baseSha: workerBinding.base_sha, headSha: workerBinding.base_sha, publisherAuthor: "D22977",
  }), /Worker chain/);
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
    github: githubFor(receipt, (id) => id === "9901" ? {
      id: "9901", url: "https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-9901",
      user: { login: "D22977" }, body: `GBB_G34_SUCCESSOR_DELIVERY_RECEIPT_V1\nstate: DELIVERED\nevent_id: forged\nsource_event_comment_id: ${event.comment_id}\ncontrol_comment_id: ${receipt.id}\nsuccessor_comment_id: 9002\nsuccessor_agent_session: session-next`,
    } : undefined),
  })).state, "DELIVERY_UNCERTAIN");
  ledger = JSON.parse(await readFile(path.join(eventDir, "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "SUCCESSOR_DELIVERY_UNCERTAIN");

  assert.equal((await consumeDeliveredControlSuccessor({
    ...args, reconcile: async () => ({ state: "DELIVERED", receipt_id: "9901" }),
    github: githubFor(receipt, (id) => id === "3002" ? {
      id: "3002", url: "https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-3002",
      user: { login: "D22977" },
      body: `CLAIM_ACCEPTED_V1\nstate: CLAIM_ACCEPTED\nwork_order: D22977/gpt-browser-bridge#211 / GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1\naccepted_claim: #211/3001 exact GET\nbranch: ${workerBinding.branch}\nexecutor_identity: collaboration task /root/other-worker`,
    } : undefined),
  })).state, "DELIVERY_UNCERTAIN");

  assert.equal((await consumeDeliveredControlSuccessor({
    ...args, reconcile: async () => ({ state: "DELIVERED", receipt_id: "9901" }),
    github: githubFor(receipt, (id) => id === "3002" ? {
      id: "3002", url: "https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-3002",
      user: { login: "D22977" },
      body: `CLAIM_ACCEPTED_V1\nstate: CLAIM_ACCEPTED\nwork_order: D22977/gpt-browser-bridge#211 / GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1\naccepted_claim: #211/3001 exact GET\nbranch: ${workerBinding.branch}\nexecutor_identity: collaboration task ${workerBinding.agent_name}_suffix`,
    } : undefined),
  })).state, "DELIVERY_UNCERTAIN");

  await assert.rejects(consumeDeliveredControlSuccessor({
    ...args, reconcile: async () => ({ state: "DELIVERED", receipt_id: "9901" }),
    github: githubFor(receipt, (id) => id === "3004" ? {
      id: "3004", url: "https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-3004",
      user: { login: "D22977" },
      body: `GBB_211_REVIEW_REMEDIATION_SHIFT_V1\nstate: SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES\nexecutor_identity: collaboration task /root/other-worker; overlaps ${workerBinding.agent_name}\nattempt_id: ${workerBinding.attempt_id}\nlease_id: ${workerBinding.lease_id}\nbranch: ${workerBinding.branch}\nexact_remote_base_sha: ${event.head_sha}`,
    } : undefined),
  }));

  assert.equal((await consumeDeliveredControlSuccessor({
    ...args, reconcile: async () => ({ state: "DELIVERED", receipt_id: "9901" }),
    github: githubFor(receipt, (id) => id === "9002" ? {
      id: "9002", url: "https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-9002",
      user: { login: "D22977" }, body: `GBB_G34_EXECUTOR_CONSUMED_STARTED_V1\nstate: CONSUMED_STARTED\nagent_name: /root/other-worker`,
    } : undefined),
  })).state, "DELIVERY_UNCERTAIN");

  assert.equal((await consumeDeliveredControlSuccessor({
    ...args, reconcile: async () => ({ state: "DELIVERED", receipt_id: "9901" }),
  })).state, "CONSUMED");
  assert.equal(deliveries, 1);
  ledger = JSON.parse(await readFile(path.join(eventDir, "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "CONSUMED");
  assert.equal(ledger[event.event_id].successor_delivery_receipt_id, "9901");
});

test("CONSUMED revalidates Control-selected successor and exact delivered event at the exported boundary", async () => {
  const makePending = async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-selected-successor-"));
    await mkdir(path.join(runtimeRoot, "events"));
    await writeFile(path.join(runtimeRoot, "events", "g34-source-events.json"), JSON.stringify({
      [event.event_id]: {
        state: "SUCCESSOR_SEND_ATTEMPTED", source_comment_id: event.source_comment_id,
        comment_id: event.comment_id, control_comment_id: "8701", successor_comment_id: "9002",
      },
    }));
    return runtimeRoot;
  };
  const selectedOther = controlReceipt({
    successor_comment_id: "9003", successor_agent_name: "/root/control-selected-worker",
    successor_agent_session: "control-selected-session", successor_pane: "control-selected-pane",
    successor_terminal: "control-selected-terminal",
  });
  const selectedMismatchRoot = await makePending();
  const selectedMismatch = await recordSuccessorDelivery({
    eventId: event.event_id, receiptId: "9901", event, controlCommentId: selectedOther.id,
    successor: {
      comment_id: "9002", agent_name: workerBinding.agent_name, agent_session: workerBinding.agent_session,
      pane: workerBinding.pane, terminal: workerBinding.terminal,
    }, github: githubFor(selectedOther), runtimeRoot: selectedMismatchRoot,
  });
  assert.equal(selectedMismatch.state, "DELIVERY_UNCERTAIN");
  let ledger = JSON.parse(await readFile(path.join(selectedMismatchRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "SUCCESSOR_DELIVERY_UNCERTAIN");

  const forgedEventRoot = await makePending();
  const forgedEvent = { ...event, body: `${event.body}\nforged-event-payload` };
  const forgedEventResult = await recordSuccessorDelivery({
    eventId: event.event_id, receiptId: "9901", event: forgedEvent, controlCommentId: "8701",
    successor: {
      comment_id: "9002", agent_name: workerBinding.agent_name, agent_session: workerBinding.agent_session,
      pane: workerBinding.pane, terminal: workerBinding.terminal,
    }, github: githubFor(controlReceipt()), runtimeRoot: forgedEventRoot,
  });
  assert.equal(forgedEventResult.state, "DELIVERY_UNCERTAIN");
  ledger = JSON.parse(await readFile(path.join(forgedEventRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[event.event_id].state, "SUCCESSOR_DELIVERY_UNCERTAIN");

  const forgedControlBindingRoot = await makePending();
  const forgedControlBindingGithub = githubFor(controlReceipt(), (id) => id === "8499" ? {
    id: "8499", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8499",
    user: { login: "D22977" },
    body: `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: D22977\ncontrol_task_identity: /root\nworker_task_identity: ${event.agent_name}\ncard_issue_number: 219\nreviewer_task_identity: /root/g34_219_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}`,
  } : undefined);
  const forgedControlBinding = await recordSuccessorDelivery({
    eventId: event.event_id, receiptId: "9901", event, controlCommentId: "8701",
    successor: {
      comment_id: "9002", agent_name: workerBinding.agent_name, agent_session: workerBinding.agent_session,
      pane: workerBinding.pane, terminal: workerBinding.terminal,
    }, github: forgedControlBindingGithub, runtimeRoot: forgedControlBindingRoot,
  });
  assert.equal(forgedControlBinding.state, "DELIVERY_UNCERTAIN");

  const lateBindingRoot = await makePending();
  const lateBindingGithub = githubFor(controlReceipt(), (id) => id === "8500" ? {
    id: "8500", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8500",
    user: { login: "D22977" },
    body: `GBB_G34_FRESH_INDEPENDENT_REVIEW_RESULT_V1\ndecision: APPROVE\nstate: REVIEW_TERMINAL\ncard: #219\nreviewer_binding_comment_id: 8501\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nreviewer_task_identity: /root/g34_219_sol_high_review\nreviewed_repository: D22977/gpt-browser-bridge\nreviewed_branch: ${workerBinding.branch}\nreviewed_exact_head: ${event.head_sha}\nreviewed_tree: ${"d".repeat(40)}`,
  } : id === "8501" ? {
    id: "8501", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8501",
    user: { login: "D22977" },
    body: `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root\nworker_task_identity: ${event.agent_name}\ncard_issue_number: 219\nreviewer_task_identity: /root/g34_219_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}`,
  } : undefined);
  lateBindingGithub.getIssue = async () => ({
    number: 219, state: "open",
    body: `GBB_G34_FRESH_REVIEW_REMEDIATION_WORK_ORDER_V1\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${"d".repeat(40)}\nreviewer_binding_comment_id: 8501`,
  });
  const lateBinding = await recordSuccessorDelivery({
    eventId: event.event_id, receiptId: "9901", event, controlCommentId: "8701",
    successor: {
      comment_id: "9002", agent_name: workerBinding.agent_name, agent_session: workerBinding.agent_session,
      pane: workerBinding.pane, terminal: workerBinding.terminal,
    }, github: lateBindingGithub, runtimeRoot: lateBindingRoot,
  });
  assert.equal(lateBinding.state, "DELIVERY_UNCERTAIN");
});

test("CONSUMED rejects Worker-colliding Control identity and mismatched review-card candidate pins", async () => {
  const runtimeWithPendingDelivery = async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-control-card-binding-"));
    await mkdir(path.join(runtimeRoot, "events"));
    await writeFile(path.join(runtimeRoot, "events", "g34-source-events.json"), JSON.stringify({
      [event.event_id]: {
        state: "SUCCESSOR_SEND_ATTEMPTED", source_comment_id: event.source_comment_id,
        comment_id: event.comment_id, control_comment_id: "8701", successor_comment_id: "9002",
      },
    }));
    return runtimeRoot;
  };
  const runWith = async ({ controlTaskIdentity = "/root", cardFields = {}, reviewerCardNumber = "219" } = {}) => {
    const receipt = controlReceipt();
    const card = {
      candidate_repository: "D22977/gpt-browser-bridge",
      candidate_branch: workerBinding.branch,
      candidate_exact_head_sha: event.head_sha,
      candidate_tree_sha: "d".repeat(40),
      ...cardFields,
    };
    const reviewerBindingBody = `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: ${controlTaskIdentity}\nworker_task_identity: ${event.agent_name}\ncard_issue_number: ${reviewerCardNumber}\nreviewer_task_identity: /root/g34_219_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${workerBinding.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${card.candidate_tree_sha}`;
    const reviewBody = `GBB_G34_FRESH_INDEPENDENT_REVIEW_RESULT_V1\ndecision: APPROVE\nstate: REVIEW_TERMINAL\ncard: #219\nreviewer_binding_comment_id: 8499\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nreviewer_task_identity: /root/g34_219_sol_high_review\nreviewed_repository: D22977/gpt-browser-bridge\nreviewed_branch: ${workerBinding.branch}\nreviewed_exact_head: ${event.head_sha}\nreviewed_tree: ${card.candidate_tree_sha}`;
    const github = githubFor(receipt, (id) => id === "8499" ? {
      id: "8499", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8499",
      user: { login: "D22977" }, body: reviewerBindingBody,
    } : id === "8500" ? {
      id: "8500", url: "https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-8500",
      user: { login: "D22977" }, body: reviewBody,
    } : undefined);
    github.getIssue = async () => ({
      number: 219, title: "review", state: "open",
      body: `GBB_G34_FRESH_REVIEW_REMEDIATION_WORK_ORDER_V1\ncandidate_repository: ${card.candidate_repository}\ncandidate_branch: ${card.candidate_branch}\ncandidate_exact_head_sha: ${card.candidate_exact_head_sha}\ncandidate_tree_sha: ${card.candidate_tree_sha}\nreviewer_binding_comment_id: 8499`,
    });
    const runtimeRoot = await runtimeWithPendingDelivery();
    const result = await recordSuccessorDelivery({
      eventId: event.event_id, receiptId: "9901", event, controlCommentId: "8701",
      successor: {
        comment_id: "9002", agent_name: workerBinding.agent_name, agent_session: workerBinding.agent_session,
        pane: workerBinding.pane, terminal: workerBinding.terminal,
      }, github, runtimeRoot,
    });
    return result.state;
  };

  for (const controlTaskIdentity of [
    event.agent_name,
    event.agent_session,
    `collaboration task ${event.agent_name}`,
  ]) {
    assert.equal(await runWith({ controlTaskIdentity }), "DELIVERY_UNCERTAIN");
  }
  assert.equal(await runWith({ controlTaskIdentity: "/root/not-control" }), "DELIVERY_UNCERTAIN");
  for (const cardFields of [
    { candidate_repository: "D22977/other-repo" },
    { candidate_branch: "work/other-branch" },
    { candidate_exact_head_sha: "c".repeat(40) },
  ]) {
    assert.equal(await runWith({ cardFields }), "DELIVERY_UNCERTAIN");
  }
  assert.equal(await runWith({ reviewerCardNumber: "220" }), "DELIVERY_UNCERTAIN");
  assert.equal(await runWith({ cardFields: { candidate_tree_sha: "e".repeat(40) } }), "DELIVERY_UNCERTAIN");
});

test("CONSUMED binds review Control identity to source dispatch separately from successor dispatch", async () => {
  const runCase = async (reviewControlIdentity) => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-split-dispatch-"));
    await mkdir(path.join(runtimeRoot, "events"));
    await writeFile(path.join(runtimeRoot, "events", "g34-source-events.json"), JSON.stringify({
      [event.event_id]: {
        state: "SUCCESSOR_SEND_ATTEMPTED", source_comment_id: event.source_comment_id,
        comment_id: event.comment_id, control_comment_id: "8701", successor_comment_id: "9002",
      },
    }));
    const receipt = controlReceipt({ control_generation: "034" });
    const successorControlIdentity = "/root/other-control";
    const sourceDispatch = `GBB_211_REVIEW_REMEDIATION_SHIFT_V1\nstate: SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root\nexecutor_identity: collaboration task ${event.agent_name}\nattempt_id: ${workerBinding.attempt_id}\nlease_id: ${workerBinding.lease_id}\nbranch: ${event.branch}\nexact_remote_base_sha: ${event.base_sha ?? event.head_sha}`;
    const successorDispatch = `GBB_211_REVIEW_REMEDIATION_SHIFT_V1\nstate: SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: ${successorControlIdentity}\nexecutor_identity: collaboration task ${workerBinding.agent_name}\nattempt_id: ${workerBinding.attempt_id}\nlease_id: ${workerBinding.lease_id}\nbranch: ${workerBinding.branch}\nexact_remote_base_sha: ${event.head_sha}`;
    const reviewerBinding = `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: ${reviewControlIdentity}\nworker_task_identity: ${event.agent_name}\ncard_issue_number: 219\nreviewer_task_identity: /root/g34_219_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${event.branch}\ncandidate_exact_head_sha: ${event.head_sha}\ncandidate_tree_sha: ${event.tree_sha}`;
    const successorStart = `GBB_G34_EXECUTOR_CONSUMED_STARTED_V1\nstate: CONSUMED_STARTED\ncard_comment_id: 211\nclaim_comment_id: 3001\nacceptance_comment_id: 3002\nbinding_comment_id: 3000\ndispatch_comment_id: 3005\nexecutor_identity: collaboration task ${workerBinding.agent_name}\nagent_name: ${workerBinding.agent_name}\nagent_session: ${workerBinding.agent_session}\npane: ${workerBinding.pane}\nterminal: ${workerBinding.terminal}\ncwd: ${workerBinding.cwd}\nmodel: ${workerBinding.model}\nreasoning_effort: ${workerBinding.reasoning_effort}\nbranch: ${workerBinding.branch}\nbase_sha: ${event.head_sha}\nhead_sha: ${event.head_sha}\nlease_id: ${workerBinding.lease_id}\nattempt_id: ${workerBinding.attempt_id}\nrepository: D22977/gpt-browser-bridge`;
    const ack = `GBB_G34_EXECUTOR_CONSUMED_ACK_V1\nstate: CONSUMED_ACK\ncard_comment_id: 211\nevent_id: ${event.event_id}\nsource_event_comment_id: ${event.comment_id}\nsource_claim_comment_id: ${event.claim_comment_id}\nsource_acceptance_comment_id: ${event.acceptance_comment_id}\nsource_binding_comment_id: ${event.binding_comment_id}\nsource_dispatch_comment_id: ${event.dispatch_comment_id}\nsource_worker_start_comment_id: ${event.worker_start_comment_id ?? event.source_comment_id}\ncontrol_comment_id: 8701\nsuccessor_comment_id: 9002\nsuccessor_agent_name: ${workerBinding.agent_name}\nagent_name: ${workerBinding.agent_name}\nagent_session: ${workerBinding.agent_session}\npane: ${workerBinding.pane}\nterminal: ${workerBinding.terminal}\nexecutor_identity: collaboration task ${workerBinding.agent_name}\nclaim_comment_id: 3001\nacceptance_comment_id: 3002\nbinding_comment_id: 3000\ndispatch_comment_id: 3005\nworker_start_comment_id: 9002`;
    const github = githubFor(receipt, (id) => {
      if (id === "3004") return {
        id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
        user: { login: "D22977" }, body: sourceDispatch,
      };
      if (id === "3005") return {
        id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
        user: { login: "D22977" }, body: successorDispatch,
      };
      if (id === "8499") return {
        id, url: `https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-${id}`,
        user: { login: "D22977" }, body: reviewerBinding,
      };
      if (id === "9002") return {
        id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
        user: { login: "D22977" },
        body: successorStart,
      };
      if (id === "9899") return {
        id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
        user: { login: "D22977" }, body: ack,
      };
      return undefined;
    });
    const result = await recordSuccessorDelivery({
      eventId: event.event_id, receiptId: "9901", event, controlCommentId: receipt.id,
      successor: {
        comment_id: "9002", agent_name: workerBinding.agent_name, agent_session: workerBinding.agent_session,
        pane: workerBinding.pane, terminal: workerBinding.terminal,
      }, github, runtimeRoot,
    });
    return result.state;
  };

  assert.equal(await runCase("/root/other-control"), "DELIVERY_UNCERTAIN");
  assert.equal(await runCase("/root"), "CONSUMED");

  const original = { ...event };
  event.event_id = "f".repeat(64);
  event.event_kind = "WORKER_TERMINAL_RESULT";
  event.base_sha = "a".repeat(40);
  event.head_sha = "e".repeat(40);
  event.state = "READY_FOR_FRESH_REVIEW";
  event.worker_start_comment_id = event.source_comment_id;
  event.body = [
    "marker=GITHUB_SOURCE_EVENT_V1", `event_id=${event.event_id}`, "event_kind=WORKER_TERMINAL_RESULT",
    `source_comment_id=${event.source_comment_id}`, `source_body_sha256=${event.source_body_sha256}`,
    `claim_comment_id=${event.claim_comment_id}`, `acceptance_comment_id=${event.acceptance_comment_id}`,
    `binding_comment_id=${event.binding_comment_id}`, `dispatch_comment_id=${event.dispatch_comment_id}`,
    `agent_name=${event.agent_name}`, `agent_session=${event.agent_session}`, `state=${event.state}`,
    `branch=${event.branch}`, `base_sha=${event.base_sha}`, `head_sha=${event.head_sha}`,
    `tree_sha=${event.tree_sha}`, `worker_start_comment_id=${event.worker_start_comment_id}`,
  ].join("\n");
  assert.equal(await runCase("/root/other-control"), "DELIVERY_UNCERTAIN");
  assert.equal(await runCase("/root"), "CONSUMED");
  Object.assign(event, original);
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

test("terminal source state remains bound while exported delivery and successor consumption use transport state", async () => {
  const start = workerComment("4001", "GBB_G34_EXECUTOR_CONSUMED_STARTED_V1", "CONSUMED_STARTED", workerBinding.base_sha);
  const head = "e".repeat(40);
  const terminal = workerComment("4002", "GBB_G34_EXECUTOR_TERMINAL_RESULT_V1", "READY_FOR_FRESH_REVIEW", head, {
    worker_start_comment_id: "4001",
  });
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "g34-terminal-delivery-"));
  const published = await runG34ResidentCycle({
    sourceComments: [start, terminal], currentAuthority: structuredClone(authorityRecords), binding: workerBinding,
    issueNumber: 211, runtimeRoot, github: fakeSourceGithub([start, terminal], {}, 8300),
    repositoryFullName: "D22977/gpt-browser-bridge", branch: workerBinding.branch,
    baseSha: workerBinding.base_sha, headSha: head, publisherAuthor: "D22977",
  });
  const terminalResult = published.find(({ event: source }) => source.source_comment_id === "4002");
  assert.ok(terminalResult);
  assert.equal(terminalResult.event.state, "READY_FOR_FRESH_REVIEW");
  assert.match(terminalResult.event.body, /state=READY_FOR_FRESH_REVIEW/);
  assert.equal(terminalResult.publication.state, "DELIVERED");

  const sourceEvent = { ...terminalResult.event };
  sourceEvent.executor_identity = `collaboration task ${sourceEvent.agent_name}`;
  sourceEvent.worker_start_comment_id = "4001";
  const nextWorker = {
    name: "/root/g34_211_worker_luna2", session: "GBB-G036-211-LUNA-COLLAB-G16-20261021-01",
    lease: "GBB-211-LEASE-20261021-16", attempt: "GBB-G036-211-LUNA-COLLAB-G16-20261021-01",
  };
  const sourceDispatchId = "3004";
  const successorRouteId = "8000";
  const successorClaimId = "8001";
  const successorAcceptanceId = "8002";
  const successorDispatchId = "8003";
  const sourceStartId = "4001";
  const successorStartId = "9002";
  const sourceBaseSha = sourceEvent.base_sha ?? sourceEvent.head_sha;
  const sourceDispatchBody = `GBB_211_REVIEW_REMEDIATION_SHIFT_V1\nstate: SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root\nexecutor_identity: collaboration task ${sourceEvent.agent_name}\nattempt_id: ${workerBinding.attempt_id}\nlease_id: ${workerBinding.lease_id}\nbranch: ${sourceEvent.branch}\nexact_remote_base_sha: ${sourceBaseSha}`;
  const successorDispatchBody = `GBB_211_REVIEW_REMEDIATION_SHIFT_V1\nstate: SAME_WORKER_REASSIGNED_FOR_REVIEW_FIXES\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root/other-control\nexecutor_identity: collaboration task ${nextWorker.name}\nattempt_id: ${nextWorker.attempt}\nlease_id: ${nextWorker.lease}\nbranch: ${sourceEvent.branch}\nexact_remote_base_sha: ${sourceEvent.head_sha}`;
  const sourceBindingBody = `GBB_G34_REVIEWER_BINDING_V1\nstate: REVIEWER_ASSIGNED\nrecorded_by_role: LOCAL_CONTROL_TOWER\ncontrol_task_identity: /root\nworker_task_identity: ${sourceEvent.agent_name}\ncard_issue_number: 219\nreviewer_task_identity: /root/g34_219_sol_high_review\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nmodel: gpt-6-sol\nreasoning_effort: high\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${sourceEvent.branch}\ncandidate_exact_head_sha: ${sourceEvent.head_sha}\ncandidate_tree_sha: ${sourceEvent.tree_sha}`;
  const sourceReviewBody = `GBB_G34_FRESH_INDEPENDENT_REVIEW_RESULT_V1\ndecision: APPROVE\nstate: REVIEW_TERMINAL\ncard: #219\nreviewer_binding_comment_id: 8499\nrole: fresh independent GPT-6 Sol High read-only Reviewer\nreviewer_task_identity: /root/g34_219_sol_high_review\nreviewed_repository: D22977/gpt-browser-bridge\nreviewed_branch: ${sourceEvent.branch}\nreviewed_exact_head: ${sourceEvent.head_sha}\nreviewed_tree: ${sourceEvent.tree_sha}`;
  const sourceAdjudicationBody = `ACTIVE_CONTROL_ADJUDICATION_V1\nstate: ACCEPTED\nrecorded_by_role: ACTIVE_CONTROL\nactive_control_id: ${activeId}\nsource_event_id: ${sourceEvent.event_id}\nsource_event_comment_id: ${sourceEvent.comment_id}`;
  const cardBody = `GBB_G34_FRESH_REVIEW_REMEDIATION_WORK_ORDER_V1\ncandidate_repository: D22977/gpt-browser-bridge\ncandidate_branch: ${sourceEvent.branch}\ncandidate_exact_head_sha: ${sourceEvent.head_sha}\ncandidate_tree_sha: ${sourceEvent.tree_sha}\nreviewer_binding_comment_id: 8499`;
  const receipt = controlReceipt({
    source_event_id: sourceEvent.event_id, source_event_comment_id: sourceEvent.comment_id,
    worker_receipt_comment_id: sourceEvent.source_comment_id, reviewed_exact_head_sha: sourceEvent.head_sha,
    adjudication_comment_id: "8450",
  });
  receipt.body = receipt.body.replace(`successor_agent_name: ${workerBinding.agent_name}`, `successor_agent_name: ${nextWorker.name}`)
    .replace(`successor_agent_session: ${workerBinding.agent_session}`, `successor_agent_session: ${nextWorker.session}`)
    .replace(`successor_pane: ${workerBinding.pane}`, "successor_pane: collaboration-managed")
    .replace(`successor_terminal: ${workerBinding.terminal}`, "successor_terminal: collaboration-managed")
    .replace("successor_comment_id: 9002", `successor_comment_id: ${successorStartId}`);
  receipt.url = "https://github.com/D22977/gpt-browser-bridge/issues/88#issuecomment-8701";
  const github = githubFor(receipt, (id) => id === sourceEvent.comment_id ? {
    id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
    user: { login: "D22977" }, body: sourceEvent.body,
  } : id === "8499" ? {
    id, url: `https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-${id}`,
    user: { login: "D22977" }, body: sourceBindingBody,
  } : id === "8500" ? {
    id, url: `https://github.com/D22977/gpt-browser-bridge/issues/219#issuecomment-${id}`,
    user: { login: "D22977" }, body: sourceReviewBody,
  } : id === "8450" ? {
    id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
    user: { login: "D22977" }, body: sourceAdjudicationBody,
  } : id === sourceStartId ? {
    id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
    user: { login: "D22977" }, body: `GBB_G34_EXECUTOR_CONSUMED_STARTED_V1\nstate: CONSUMED_STARTED\ncard_comment_id: 211\nclaim_comment_id: ${sourceEvent.claim_comment_id}\nacceptance_comment_id: ${sourceEvent.acceptance_comment_id}\nbinding_comment_id: ${sourceEvent.binding_comment_id}\ndispatch_comment_id: ${sourceDispatchId}\nexecutor_identity: ${sourceEvent.executor_identity}\nagent_name: ${sourceEvent.agent_name}\nagent_session: ${sourceEvent.agent_session}\npane: ${sourceEvent.pane}\nterminal: ${sourceEvent.terminal}\nbase_sha: ${sourceBaseSha}\nhead_sha: ${sourceBaseSha}\nbranch: ${sourceEvent.branch}\nlease_id: ${workerBinding.lease_id}\nattempt_id: ${workerBinding.attempt_id}\nrepository: D22977/gpt-browser-bridge`,
  } : id === sourceDispatchId ? {
    id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
    user: { login: "D22977" }, body: sourceDispatchBody,
  } : id === successorStartId ? {
    id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
    user: { login: "D22977" }, body: `GBB_G34_EXECUTOR_CONSUMED_STARTED_V1\nstate: CONSUMED_STARTED\ncard_comment_id: 211\nclaim_comment_id: ${successorClaimId}\nacceptance_comment_id: ${successorAcceptanceId}\nbinding_comment_id: ${successorRouteId}\ndispatch_comment_id: ${successorDispatchId}\nexecutor_identity: collaboration task ${nextWorker.name}\nagent_name: ${nextWorker.name}\nagent_session: ${nextWorker.session}\npane: collaboration-managed\nterminal: collaboration-managed\nmodel: gpt-6-luna\nreasoning_effort: low\nruntime_surface: ${workerBinding.runtime_surface}\nbase_sha: ${sourceEvent.head_sha}\nhead_sha: ${sourceEvent.head_sha}\nbranch: ${sourceEvent.branch}\nlease_id: ${nextWorker.lease}\nattempt_id: ${nextWorker.attempt}\nrepository: D22977/gpt-browser-bridge`,
  } : id === successorDispatchId ? {
    id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
    user: { login: "D22977" }, body: successorDispatchBody,
  } : id === successorRouteId ? {
    id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
    user: { login: "D22977" }, body: `GBB_G036_211_CONTROL_ROUTE_AMENDMENT_V1\nstate: ONE_ALTERNATE_LOW_COST_WORKER_ROUTE_AUTHORIZED\nCANDIDATE_BINDING\ntask_name: ${nextWorker.name}\nrole: Worker\nmodel_effort: gpt-6-luna / low\nruntime_surface: ${workerBinding.runtime_surface}`,
  } : id === successorClaimId ? {
    id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
    user: { login: "D22977" }, body: `CLAIM_REQUESTED_V1\nstate: CLAIM_REQUESTED\nwork_order: D22977/gpt-browser-bridge#211\nrole: Worker\nmodel_effort: gpt-6-luna / low\nbranch: ${sourceEvent.branch}\nexecutor_identity: collaboration task ${nextWorker.name}`,
  } : id === successorAcceptanceId ? {
    id, url: `https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-${id}`,
    user: { login: "D22977" }, body: `CLAIM_ACCEPTED_V1\nstate: CLAIM_ACCEPTED\nwork_order: D22977/gpt-browser-bridge#211 / GBB_G34_REVIEW_REPAIR_WORK_ORDER_V1\naccepted_claim: #211/${successorClaimId} exact GET\nbranch: ${sourceEvent.branch}\nexecutor_identity: collaboration task ${nextWorker.name}`,
  } : id === "9901" ? {
    id: "9901", url: "https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-9901", user: { login: "D22977" },
    body: `GBB_G34_SUCCESSOR_DELIVERY_RECEIPT_V1\nstate: DELIVERED\nevent_id: ${sourceEvent.event_id}\nsource_event_comment_id: ${sourceEvent.comment_id}\ncontrol_comment_id: 8701\nsuccessor_comment_id: ${successorStartId}\nsuccessor_agent_name: ${nextWorker.name}\nsuccessor_agent_session: ${nextWorker.session}\nsuccessor_pane: collaboration-managed\nsuccessor_terminal: collaboration-managed\nsource_claim_comment_id: ${sourceEvent.claim_comment_id}\nsource_acceptance_comment_id: ${sourceEvent.acceptance_comment_id}\nsource_binding_comment_id: ${sourceEvent.binding_comment_id}\nsource_dispatch_comment_id: ${sourceEvent.dispatch_comment_id}\nsource_worker_start_comment_id: ${sourceEvent.worker_start_comment_id}\nconsumer_ack_comment_id: 9899`,
  } : id === "9899" ? {
    id: "9899", url: "https://github.com/D22977/gpt-browser-bridge/issues/211#issuecomment-9899", user: { login: "D22977" },
    body: `GBB_G34_EXECUTOR_CONSUMED_ACK_V1\nstate: CONSUMED_ACK\ncard_comment_id: 211\nevent_id: ${sourceEvent.event_id}\nsource_event_comment_id: ${sourceEvent.comment_id}\nsource_claim_comment_id: ${sourceEvent.claim_comment_id}\nsource_acceptance_comment_id: ${sourceEvent.acceptance_comment_id}\nsource_binding_comment_id: ${sourceEvent.binding_comment_id}\nsource_dispatch_comment_id: ${sourceEvent.dispatch_comment_id}\nsource_worker_start_comment_id: ${sourceEvent.worker_start_comment_id}\ncontrol_comment_id: 8701\nsuccessor_comment_id: ${successorStartId}\nsuccessor_agent_name: ${nextWorker.name}\nagent_name: ${nextWorker.name}\nagent_session: ${nextWorker.session}\npane: collaboration-managed\nterminal: collaboration-managed\nexecutor_identity: collaboration task ${nextWorker.name}\nclaim_comment_id: ${successorClaimId}\nacceptance_comment_id: ${successorAcceptanceId}\nbinding_comment_id: ${successorRouteId}\ndispatch_comment_id: ${successorDispatchId}\nworker_start_comment_id: ${successorStartId}`,
  } : undefined);
  github.getIssue = async (number) => number === 219 ? { number, state: "open", body: cardBody } : null;
  const sourceLedgerPath = path.join(runtimeRoot, "events", "g34-source-events.json");
  const sourceLedgerBefore = await readFile(sourceLedgerPath, "utf8");
  const rejectedRuntimeRoot = await mkdtemp(path.join(tmpdir(), "g34-terminal-wrong-control-"));
  await mkdir(path.join(rejectedRuntimeRoot, "events"));
  const rejectedLedgerPath = path.join(rejectedRuntimeRoot, "events", "g34-source-events.json");
  await writeFile(rejectedLedgerPath, sourceLedgerBefore);
  const wrongControlGithub = githubFor(receipt, async (id) => {
    const record = await github.getIssueComment(id);
    if (String(id) !== "8499" || !record) return undefined;
    return { ...record, body: record.body.replace("control_task_identity: /root", `control_task_identity: ${sourceEvent.agent_name}`) };
  });
  wrongControlGithub.getIssue = github.getIssue;
  let refusedDeliveries = 0;
  await assert.rejects(consumeDeliveredControlSuccessor({
    event: sourceEvent, authority, controlReceipt: receipt, runtimeRoot: rejectedRuntimeRoot, github: wrongControlGithub,
    deliver: async () => { refusedDeliveries++; return { state: "DELIVERED", receipt_id: "9901" }; },
  }));
  assert.equal(refusedDeliveries, 0);
  assert.equal(await readFile(rejectedLedgerPath, "utf8"), sourceLedgerBefore);
  let deliveries = 0;
  const consumed = await consumeDeliveredControlSuccessor({
    event: sourceEvent, authority, controlReceipt: receipt, runtimeRoot, github,
    deliver: async () => { deliveries++; return { state: "DELIVERED", receipt_id: "9901" }; },
  });
  assert.equal(deliveries, 1);
  assert.equal(consumed.state, "CONSUMED");
  assert.equal(sourceEvent.state, "READY_FOR_FRESH_REVIEW");
  assert.match(sourceEvent.body, /state=READY_FOR_FRESH_REVIEW/);
  const ledger = JSON.parse(await readFile(path.join(runtimeRoot, "events", "g34-source-events.json"), "utf8"));
  assert.equal(ledger[sourceEvent.event_id].state, "CONSUMED");
  assert.equal(ledger[sourceEvent.event_id].successor_delivery_receipt_id, "9901");
});
