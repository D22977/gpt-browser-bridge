import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  G28_CONTROL,
  dispatchG28Doorbell,
  recordG28Consumed,
  recordG28Ack,
} from "../src/g28_control_doorbell.mjs";

const SESSION = {
  session: "g28-current-playwright-session",
  generation: 28,
  conversation_id: G28_CONTROL.conversation_id,
  conversation_url: G28_CONTROL.conversation_url,
};

async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "g28-doorbell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function cliStub({ url = G28_CONTROL.conversation_url, failClick = false, assistantMessages = [] } = {}) {
  const calls = [];
  const exec = async (_cliPath, args) => {
    const command = args[2];
    calls.push(command);
    if (command === "tab-list") {
      return { stdout: JSON.stringify({ result: `- 0: (current) [Control](${url})` }) };
    }
    if (command === "tab-select" || command === "fill") return { stdout: JSON.stringify({ result: null }) };
    if (command === "click" && failClick) throw new Error("simulated post-attempt send uncertainty");
    if (command === "click") return { stdout: JSON.stringify({ result: null }) };
    if (command === "eval") {
      return { stdout: JSON.stringify({ result: { url, assistantMessages, visibilityState: "visible", stopVisible: false } }) };
    }
    throw new Error(`unexpected CLI command: ${command}`);
  };
  return { exec, calls };
}

function event(overrides = {}) {
  return {
    runtimeRoot: "",
    idempotencyKey: "g28-test-event-01",
    sourceCard: "Issue #162 comment 5847605398",
    prompt: "Read the exact current Control card and continue the bounded task.",
    sessionBinding: SESSION,
    ...overrides,
  };
}

test("missing exact Playwright binding stops before creating an attempt or sending", async (t) => {
  const runtimeRoot = await tempRoot(t);
  const { exec, calls } = cliStub();

  const result = await dispatchG28Doorbell(event({ runtimeRoot, sessionBinding: null }), { exec });

  assert.equal(result.status, "CONTROL_REQUIRED_PLAYWRIGHT_SESSION_BINDING_MISSING");
  assert.deepEqual(calls, []);
  await assert.rejects(readFile(path.join(runtimeRoot, "events")), { code: "ENOENT" });
});

test("exact target sends once and a restart reads DELIVERED without replay", async (t) => {
  const runtimeRoot = await tempRoot(t);
  const { exec, calls } = cliStub();

  const first = await dispatchG28Doorbell(event({ runtimeRoot }), { exec });
  const restarted = await dispatchG28Doorbell(event({ runtimeRoot }), { exec });

  assert.equal(first.status, "DELIVERED");
  assert.equal(first.receipts.attempted.receipt.status, "ATTEMPTED");
  assert.equal(first.receipts.delivered.receipt.status, "DELIVERED");
  assert.equal(restarted.status, "DELIVERED");
  assert.equal(restarted.duplicate, true);
  assert.equal(calls.filter((name) => name === "click").length, 1);
  assert.equal(calls.filter((name) => name === "fill").length, 1);
});

test("a failed send remains UNCERTAIN_SEND and is never retried after restart", async (t) => {
  const runtimeRoot = await tempRoot(t);
  const { exec, calls } = cliStub({ failClick: true });

  const first = await dispatchG28Doorbell(event({ runtimeRoot }), { exec });
  const restarted = await dispatchG28Doorbell(event({ runtimeRoot }), { exec });

  assert.equal(first.status, "UNCERTAIN_SEND");
  assert.equal(restarted.status, "UNCERTAIN_SEND");
  assert.equal(restarted.duplicate, true);
  assert.equal(calls.filter((name) => name === "click").length, 1);
});

test("CONSUMED and ACK receipts require the exact event, target, and receipt chain", async (t) => {
  const runtimeRoot = await tempRoot(t);
  const input = event({ runtimeRoot });
  const marker = `GBB_G28_CONSUMED_ACK_V1\nevent_id: ${input.idempotencyKey}\ncontrol_generation: 028\nconversation_id: ${G28_CONTROL.conversation_id}\nsource_card: ${input.sourceCard}`;
  const { exec } = cliStub({ assistantMessages: [marker] });
  const delivered = await dispatchG28Doorbell(input, { exec });

  const consumed = await recordG28Consumed({ ...input, exec });
  const ack = await recordG28Ack({
    ...input,
    evidence: {
      event_id: input.idempotencyKey,
      control_generation: 28,
      conversation_id: G28_CONTROL.conversation_id,
      conversation_url: G28_CONTROL.conversation_url,
      source_card: input.sourceCard,
      consumed_receipt_sha256: consumed.receipt_sha256,
      readback_comment_id: 5847635518,
      readback_body: `GBB_G28_CONTROL_ACK_V1\nevent_id: ${input.idempotencyKey}\ncontrol_generation: 028\nconversation_id: ${G28_CONTROL.conversation_id}\nsource_card: ${input.sourceCard}\nconsumed_receipt_sha256: ${consumed.receipt_sha256}`,
    },
  });

  assert.equal(consumed.status, "CONSUMED");
  assert.equal(ack.status, "ACK");
  assert.equal(delivered.status, "DELIVERED");
  await assert.rejects(
    () => recordG28Ack({ ...input, evidence: { event_id: "wrong", readback_comment_id: 1 } }),
    { code: "CONTROL_REQUIRED_ACK_BINDING_MISMATCH" },
  );
});
