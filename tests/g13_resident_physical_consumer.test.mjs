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
      control_generation: "013",
      active_control_conversation_id: "conversation-1",
      direction: "A",
      requested_action: "wake",
      exact_target_role: "HERDR",
      target_id: target.id
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
      return { id: "9001", body: io.receiptBody };
    },
    prompt: async () => {
      promptCalls += 1;
      throw new Error("post-boundary timeout");
    }
  };

  const first = await sendHerdrOnce({ event, record: claimed, authority, io });
  assert.equal(first.record.state, "UNCERTAIN_SEND");
  assert.equal(first.record.decision, "NO_BLIND_RETRY");
  assert.equal(receiptWrites, 1);
  assert.equal(receiptReads, 1);
  assert.equal(promptCalls, 1);

  const second = await sendHerdrOnce({ event, record: first.record, authority, io });
  assert.equal(second.outcome, "NO_OP_NO_BLIND_RETRY");
  assert.equal(receiptWrites, 1);
  assert.equal(receiptReads, 1);
  assert.equal(promptCalls, 1);
});
