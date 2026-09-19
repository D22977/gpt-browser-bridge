import test from "node:test";
import assert from "node:assert/strict";

import { sendHerdrOnce } from "../runtime/control-doorbell/watcher.mjs";

test("Herdr send fence permits one prompt and never retries an ambiguous attempt", async () => {
  let receiptWrites = 0;
  let receiptReads = 0;
  let promptCalls = 0;
  const target = { role: "HERDR", id: "w2:p1", session: "session-1", cwd: "C:/WINDOWS/system32" };
  const authority = {
    generation: "013",
    conversationId: "conversation-1",
    comment_ids: { control_switch: "switch-1", start: "start-1", registry: "registry-1" }
  };
  const event = {
    fields: {
      logical_event_id: "event-1",
      idempotency_key: "idempotency-1",
      issue: "162",
      card_or_authority_comment: "card-1",
      control_generation: "013",
      active_control_conversation_id: "conversation-1",
      direction: "A",
      requested_action: "wake",
      wake_at_if_any: "2026-09-19T00:00:00.000Z",
      exact_target_role: "HERDR",
      target_id: target.id
    }
  };
  const card = {
    marker: "GBB_G13_WAKE_OPERATIONAL_CARD_V1",
    comment_id: "card-1",
    issue_number: "162",
    author_login: "D22977",
    author_association: "OWNER",
    fields: {
      state: "AUTHORIZED_BOUNDED_OPERATIONAL_SEND",
      repository: "D22977/gpt-browser-bridge",
      issue: "162",
      control_generation: "013",
      active_control_conversation_id: "conversation-1",
      requested_action: "wake",
      direction: "A",
      exact_target_role: "HERDR",
      target_id: target.id,
      logical_event_id: "event-1",
      idempotency_key: "idempotency-1",
      operational_capability: "HERDR_SINGLE_PANE_WAKE",
      canary_scope: "issue162-single-event",
      expires_at: "2099-09-19T00:00:00.000Z"
    }
  };
  const claimed = {
    logical_event_id: event.fields.logical_event_id,
    idempotency_key: event.fields.idempotency_key,
    state: "CLAIMED",
    target_role: "HERDR",
    target_id: target.id,
    target_session: target.session,
    target_cwd: target.cwd
  };
  const io = {
    now: () => "2026-09-19T00:00:00.000Z",
    readAuthoritySnapshot: async () => ({ authority }),
    readTargets: async () => [target],
    createIssueComment: async (body) => {
      receiptWrites += 1;
      io.receiptBody = body;
      return { id: "9001", body };
    },
    fetchComment: async (id) => {
      receiptReads += 1;
      assert.equal(String(id), "9001");
      return { id: "9001", body: io.receiptBody, issue_number: "162", user: { login: "D22977" }, author_association: "OWNER" };
    },
    prompt: async () => {
      promptCalls += 1;
      throw new Error("post-boundary timeout");
    }
  };

  const first = await sendHerdrOnce({ event, record: claimed, authority, card, io });
  assert.equal(first.record.state, "UNCERTAIN_SEND");
  assert.equal(first.record.decision, "NO_BLIND_RETRY");
  assert.equal(receiptWrites, 1);
  assert.equal(receiptReads, 1);
  assert.equal(promptCalls, 1);

  const second = await sendHerdrOnce({ event, record: first.record, authority, card, io });
  assert.equal(second.outcome, "NO_OP_NO_BLIND_RETRY");
  assert.equal(receiptWrites, 1);
  assert.equal(receiptReads, 1);
  assert.equal(promptCalls, 1);
});

test("Herdr send fence refuses a rotated claimed authority before writing", async () => {
  const staleAuthority = {
    generation: "013",
    conversationId: "conversation-1",
    comment_ids: { control_switch: "switch-1", start: "start-1", registry: "registry-1" }
  };
  const freshAuthority = { ...staleAuthority, generation: "014", conversationId: "conversation-2" };
  const event = { fields: {
    logical_event_id: "event-rotated",
    idempotency_key: "idempotency-rotated",
    control_generation: "013",
    active_control_conversation_id: "conversation-1",
    direction: "A",
    exact_target_role: "HERDR"
  } };
  const record = { logical_event_id: "event-rotated", idempotency_key: "idempotency-rotated", state: "CLAIMED", target_role: "HERDR", target_id: "w2:p1" };
  let writes = 0;
  let prompts = 0;
  const result = await sendHerdrOnce({
    event,
    record,
    authority: staleAuthority,
    io: {
      readAuthoritySnapshot: async () => ({ authority: freshAuthority }),
      readTargets: async () => [{ role: "HERDR", id: "w2:p1", session: "session-1" }],
      createIssueComment: async () => { writes += 1; return { id: "9002" }; },
      prompt: async () => { prompts += 1; }
    }
  });
  assert.equal(result.outcome, "CONTROL_REQUIRED_NO_SEND");
  assert.equal(result.record.reason, "CONTROL_REQUIRED_NO_SEND");
  assert.equal(writes, 0);
  assert.equal(prompts, 0);
});

test("Herdr send fence persists no-blind-retry when SEND_ATTEMPTED readback is malformed", async () => {
  const authority = {
    generation: "013",
    conversationId: "conversation-1",
    comment_ids: { control_switch: "switch-1", start: "start-1", registry: "registry-1" }
  };
  const target = { role: "HERDR", id: "w2:p1", session: "session-1", cwd: "C:/WINDOWS/system32" };
  const event = { fields: {
    logical_event_id: "event-malformed",
    idempotency_key: "idempotency-malformed",
    issue: "162",
    card_or_authority_comment: "card-2",
    control_generation: "013",
    active_control_conversation_id: "conversation-1",
    direction: "A",
    requested_action: "wake",
    wake_at_if_any: "2026-09-19T00:00:00.000Z",
    exact_target_role: "HERDR",
    target_id: target.id
  } };
  const card = {
    marker: "GBB_G13_WAKE_OPERATIONAL_CARD_V1",
    comment_id: "card-2",
    issue_number: "162",
    author_login: "D22977",
    author_association: "OWNER",
    fields: {
      state: "AUTHORIZED_BOUNDED_OPERATIONAL_SEND",
      repository: "D22977/gpt-browser-bridge",
      issue: "162",
      control_generation: "013",
      active_control_conversation_id: "conversation-1",
      requested_action: "wake",
      direction: "A",
      exact_target_role: "HERDR",
      target_id: target.id,
      logical_event_id: "event-malformed",
      idempotency_key: "idempotency-malformed",
      operational_capability: "HERDR_SINGLE_PANE_WAKE",
      canary_scope: "issue162-single-event",
      expires_at: "2099-09-19T00:00:00.000Z"
    }
  };
  let promptCalls = 0;
  const io = {
    now: () => "2026-09-19T00:00:00.000Z",
    readAuthoritySnapshot: async () => ({ authority }),
    readTargets: async () => [target],
    createIssueComment: async () => ({ id: "9003" }),
    fetchComment: async () => ({ id: "9003", body: "GBB_G13_BIDIRECTIONAL_WAKE_RECEIPT_V1\nreceipt_state=SEND_ATTEMPTED" }),
    prompt: async () => { promptCalls += 1; }
  };
  const result = await sendHerdrOnce({ event, record: { ...event.fields, state: "CLAIMED", target_role: "HERDR" }, authority, card, io });
  assert.equal(result.outcome, "NO_BLIND_RETRY");
  assert.equal(result.record.state, "UNCERTAIN_SEND");
  assert.equal(result.record.decision, "NO_BLIND_RETRY");
  assert.equal(result.record.reason, "POST_BOUNDARY_AMBIGUOUS");
  assert.equal(promptCalls, 0);
});
