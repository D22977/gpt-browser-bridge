import { test } from "node:test";
import assert from "node:assert/strict";
import { parseActiveControlAuthority, parseG34ReceiptFields } from "../src/g34_contract.mjs";

const activeId = "6ac3b22a-a830-83ee-bd71-85838e5f1392";
const real = {
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

test("authority accepts exact sectioned GitHub switch, current indexes, and rehydration ACK", () => {
  assert.deepEqual(parseActiveControlAuthority(real), {
    control_generation: "034",
    active_control_id: activeId,
    control_conversation_id: activeId,
    publisher_login: "D22977",
    record_ids: {
      switch_comment_id: "5997153160",
      index43_comment_id: "6020264986",
      index81_comment_id: "6020285672",
      rehydration_ack_comment_id: "5997220300",
    },
  });
});

test("section parser keeps documented repeated keys in their own sections", () => {
  const fields = parseG34ReceiptFields(real.switchReceipt);
  assert.equal(fields.old_control.generation, "033");
  assert.equal(fields.new_control.generation, "034");
  assert.equal(fields.old_control.status_after, "RETIRED");
  assert.equal(fields.new_control.status_after, "ACTIVE");
});

test("authority rejects stale or forged switch, index, ACK, and publisher identity", () => {
  const cases = [
    (r) => { r.switchReceipt.body = r.switchReceipt.body.replace("status_after: ACTIVE", "status_after: RETIRED"); },
    (r) => { r.switchReceipt.body = r.switchReceipt.body.replace("generation: 034", "generation: 014"); },
    (r) => { r.index43.body = r.index43.body.replace("control_generation: 034 ACTIVE", "control_generation: 034 STALE"); },
    (r) => { r.index81.body = r.index81.body.replace(activeId, "7ac3b22a-a830-83ee-bd71-85838e5f1392"); },
    (r) => { r.rehydrationAck.body = r.rehydrationAck.body.replace("ACTIVE_REHYDRATED_ACKNOWLEDGED", "PENDING"); },
    (r) => { r.switchReceipt.user.login = "someone-else"; },
  ];
  for (const mutate of cases) {
    const copy = structuredClone(real);
    mutate(copy);
    assert.throws(() => parseActiveControlAuthority(copy));
  }
});

test("authority uses GitHub comment URL metadata instead of synthetic issue_number or pointer_id", () => {
  assert.equal("issue_number" in real.switchReceipt, false);
  assert.equal("pointer_id" in real.switchReceipt, false);
  for (const mutate of [
    (r) => { r.index43.url = r.index43.url.replace("/issues/43#", "/issues/44#"); },
    (r) => { r.switchReceipt.url = r.switchReceipt.url.replace("5997153160", "5997153161"); },
  ]) {
    const copy = structuredClone(real);
    mutate(copy);
    assert.throws(() => parseActiveControlAuthority(copy), /exact|URL|comment/i);
  }
});

test("authority rejects unsectioned synthetic switch records", () => {
  const synthetic = {
    switchReceipt: { id: "10", issue_number: 88, pointer_id: "10", body: "marker: CONTROL_GENERATION_ATOMIC_SWITCH_V1\ntransition: NEW_CONTROL\ngeneration: 034\nconversation_id: " + activeId + "\nstatus_after: ACTIVE" },
    index43: { id: "11", issue_number: 43, pointer_id: "11", body: "generation: 034\nstatus: ACTIVE\nactive_control_id: " + activeId + "\nsingle_active_control: true" },
    index81: { id: "12", issue_number: 81, pointer_id: "12", body: "generation: 034\nstatus: ACTIVE\nactive_control_id: " + activeId + "\nsingle_active_control: true" },
    rehydrationAck: { id: "13", issue_number: 88, pointer_id: "13", body: "marker: ACTIVE_CONTROL_REHYDRATION_ACK_V1\ngeneration: 034\nstatus: ACTIVE\nactive_control_id: " + activeId + "\nconversation_id: " + activeId },
  };
  assert.throws(() => parseActiveControlAuthority(synthetic));
});
