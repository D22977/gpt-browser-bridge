import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { locateChatgptTab, readBaseline, sendJob } from "./gpt_send.mjs";
import { readConversationSnapshot } from "./gpt_watch.mjs";

export const G28_CONTROL = Object.freeze({
  generation: 28,
  conversation_id: "6ab7caf8-facc-83ee-800c-685720d895b2",
  conversation_url: "https://chatgpt.com/g/g-p-6a7b34dba7448191ac48d7789054813b-kong-zhi-ta-zhu-an/c/6ab7caf8-facc-83ee-800c-685720d895b2",
});

const RECEIPT_STAGES = ["attempted", "delivered", "consumed", "ack", "uncertain"];
const IDENTITY_KEYS = ["idempotency_key", "source_card", "prompt_sha256", "control_generation", "conversation_id", "conversation_url"];

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function eventDir(runtimeRoot, idempotencyKey) {
  if (typeof runtimeRoot !== "string" || !runtimeRoot.trim()) throw new Error("G28 runtimeRoot is required");
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(idempotencyKey)) {
    throw new Error("G28 idempotencyKey must be 1-160 safe ASCII characters");
  }
  return path.join(path.resolve(runtimeRoot), "events", sha256(idempotencyKey));
}

function bindingStatus(binding) {
  if (typeof binding?.session !== "string" || !binding.session.trim() || binding.session !== binding.session.trim()) {
    return "CONTROL_REQUIRED_PLAYWRIGHT_SESSION_BINDING_MISSING";
  }
  if (
    binding.generation !== G28_CONTROL.generation ||
    binding.conversation_id !== G28_CONTROL.conversation_id ||
    binding.conversation_url !== G28_CONTROL.conversation_url
  ) {
    return "CONTROL_REQUIRED_EXACT_CONTROL_IDENTITY_SOURCE";
  }
  return null;
}

async function readReceipt(dir, stage) {
  try {
    const raw = await readFile(path.join(dir, `${stage}.json`), "utf8");
    return { receipt: JSON.parse(raw), receipt_sha256: sha256(raw) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) error.code = "CONTROL_REQUIRED_RECEIPT_CORRUPT";
    throw error;
  }
}

async function writeReceiptOnce(dir, stage, receipt) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stage}.json`);
  const raw = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(raw, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { receipt, receipt_sha256: sha256(raw), created: true };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readReceipt(dir, stage);
    if (!existing) throw new Error("CONTROL_REQUIRED_RECEIPT_RACE");
    return { ...existing, created: false };
  }
}

async function readChain(dir) {
  const chain = {};
  for (const stage of RECEIPT_STAGES) chain[stage] = await readReceipt(dir, stage);
  if (!chain.attempted && Object.values(chain).some(Boolean)) {
    const error = new Error("CONTROL_REQUIRED_RECEIPT_CHAIN_CORRUPT");
    error.code = "CONTROL_REQUIRED_RECEIPT_CHAIN_CORRUPT";
    throw error;
  }
  if ((chain.consumed && !chain.delivered) || (chain.ack && !chain.consumed) || (chain.uncertain && chain.delivered)) {
    const error = new Error("CONTROL_REQUIRED_RECEIPT_CHAIN_CORRUPT");
    error.code = "CONTROL_REQUIRED_RECEIPT_CHAIN_CORRUPT";
    throw error;
  }
  let previous = null;
  for (const stage of ["attempted", "delivered", "consumed", "ack", "uncertain"]) {
    const entry = chain[stage];
    if (!entry) continue;
    const expectedStatus = stage === "uncertain" ? "UNCERTAIN_SEND" : stage.toUpperCase();
    if (!entry.receipt || typeof entry.receipt !== "object" || Array.isArray(entry.receipt) || entry.receipt.status !== expectedStatus) {
      const error = new Error("CONTROL_REQUIRED_RECEIPT_CHAIN_CORRUPT");
      error.code = "CONTROL_REQUIRED_RECEIPT_CHAIN_CORRUPT";
      throw error;
    }
    if (entry.receipt.previous_receipt_sha256 !== (previous?.receipt_sha256 ?? null)) {
      const error = new Error("CONTROL_REQUIRED_RECEIPT_CHAIN_CORRUPT");
      error.code = "CONTROL_REQUIRED_RECEIPT_CHAIN_CORRUPT";
      throw error;
    }
    if (previous && !identityMatches(entry.receipt, previous.receipt)) {
      const error = new Error("CONTROL_REQUIRED_RECEIPT_CHAIN_CORRUPT");
      error.code = "CONTROL_REQUIRED_RECEIPT_CHAIN_CORRUPT";
      throw error;
    }
    previous = entry;
  }
  return chain;
}

function stateFromChain(chain) {
  if (chain.ack) return { status: "ACK", receipt: chain.ack.receipt, receipt_sha256: chain.ack.receipt_sha256 };
  if (chain.consumed) return { status: "CONSUMED", receipt: chain.consumed.receipt, receipt_sha256: chain.consumed.receipt_sha256 };
  if (chain.delivered) return { status: "DELIVERED", receipt: chain.delivered.receipt, receipt_sha256: chain.delivered.receipt_sha256 };
  if (chain.uncertain || chain.attempted) return { status: "UNCERTAIN_SEND", receipt: (chain.uncertain ?? chain.attempted).receipt };
  return null;
}

function identityFor({ idempotencyKey, sourceCard, prompt }) {
  if (typeof sourceCard !== "string" || !sourceCard.trim() || /[\r\n]/.test(sourceCard)) throw new Error("G28 sourceCard is required as one line");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("G28 prompt is required");
  const body = `${prompt.trim()}\n\nAfter reading this exact Control card, reply with these lines so consumption is bound to this wake:\nGBB_G28_CONSUMED_ACK_V1\nevent_id: ${idempotencyKey}\ncontrol_generation: 028\nconversation_id: ${G28_CONTROL.conversation_id}\nsource_card: ${sourceCard}`;
  return {
    idempotency_key: idempotencyKey,
    source_card: sourceCard,
    prompt_sha256: sha256(body),
    control_generation: G28_CONTROL.generation,
    conversation_id: G28_CONTROL.conversation_id,
    conversation_url: G28_CONTROL.conversation_url,
    outbound_prompt: body,
  };
}

function identityMatches(receipt, identity) {
  return IDENTITY_KEYS.every((key) => receipt?.[key] === identity[key]);
}

function receiptIdentity(identity) {
  return Object.fromEntries(IDENTITY_KEYS.map((key) => [key, identity[key]]));
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function fromError(error, fallback) {
  return error?.code || fallback;
}

export async function dispatchG28Doorbell(input, { exec, cliPath, now = () => Date.now() } = {}) {
  const identity = identityFor(input);
  const dir = eventDir(input.runtimeRoot, input.idempotencyKey);
  const chain = await readChain(dir);
  if (chain.attempted) {
    if (!identityMatches(chain.attempted.receipt, identity)) return { status: "CONTROL_REQUIRED_IDEMPOTENCY_KEY_COLLISION" };
    return { ...stateFromChain(chain), duplicate: true, receipts: chain };
  }

  const bindingBlock = bindingStatus(input.sessionBinding);
  if (bindingBlock) return { status: bindingBlock, send_count: 0 };
  const cli = { session: input.sessionBinding.session, ...(exec ? { exec } : {}), ...(cliPath ? { cliPath } : {}) };
  try {
    const tab = await locateChatgptTab(G28_CONTROL.conversation_url, cli);
    if (tab.url !== G28_CONTROL.conversation_url) return { status: "CONTROL_REQUIRED_EXACT_CONTROL_TARGET", send_count: 0 };
    await readBaseline(G28_CONTROL.conversation_url, cli);
  } catch (error) {
    return { status: "CONTROL_REQUIRED_PLAYWRIGHT_SESSION_BINDING_UNAVAILABLE", detail: fromError(error, "PREFLIGHT_FAILED"), send_count: 0 };
  }

  const attempt = await writeReceiptOnce(dir, "attempted", {
    ...receiptIdentity(identity),
    status: "ATTEMPTED",
    playwright_session: input.sessionBinding.session,
    at: isoNow(now),
    previous_receipt_sha256: null,
  });
  if (!attempt.created) {
    const latest = await readChain(dir);
    return { ...stateFromChain(latest), duplicate: true, receipts: latest };
  }

  let sent;
  try {
    sent = await sendJob({
      prompt: identity.outbound_prompt,
      attempt: 1,
      conversationUrl: G28_CONTROL.conversation_url,
      runtimeRoot: input.runtimeRoot,
      now,
      ...cli,
    });
  } catch (error) {
    const uncertain = await writeReceiptOnce(dir, "uncertain", {
      ...receiptIdentity(identity),
      status: "UNCERTAIN_SEND",
      error_code: fromError(error, "SENDER_FAILED"),
      at: isoNow(now),
      previous_receipt_sha256: attempt.receipt_sha256,
    });
    return { status: "UNCERTAIN_SEND", receipt: uncertain.receipt, duplicate: false, receipts: await readChain(dir) };
  }

  if (!sent?.job?.job_id || sent.job.conversation_url !== G28_CONTROL.conversation_url) {
    const uncertain = await writeReceiptOnce(dir, "uncertain", {
      ...receiptIdentity(identity),
      status: "UNCERTAIN_SEND",
      error_code: "SENDER_RESULT_BINDING_MISMATCH",
      at: isoNow(now),
      previous_receipt_sha256: attempt.receipt_sha256,
    });
    return { status: "UNCERTAIN_SEND", receipt: uncertain.receipt, duplicate: false, receipts: await readChain(dir) };
  }

  const delivered = await writeReceiptOnce(dir, "delivered", {
    ...receiptIdentity(identity),
    status: "DELIVERED",
    sender_job_id: sent.job.job_id,
    job_path: sent.jobPath,
    at: isoNow(now),
    previous_receipt_sha256: attempt.receipt_sha256,
  });
  if (!delivered.created && !identityMatches(delivered.receipt, identity)) {
    return { status: "CONTROL_REQUIRED_RECEIPT_CONFLICT" };
  }
  return { status: "DELIVERED", receipt: delivered.receipt, receipt_sha256: delivered.receipt_sha256, duplicate: false, receipts: await readChain(dir) };
}

export async function watchG28Control(sessionBinding, opts = {}) {
  const bindingBlock = bindingStatus(sessionBinding);
  if (bindingBlock) return { status: bindingBlock };
  try {
    const snapshot = await readConversationSnapshot(G28_CONTROL.conversation_url, {
      session: sessionBinding.session,
      ...(opts.exec ? { exec: opts.exec } : {}),
      ...(opts.cliPath ? { cliPath: opts.cliPath } : {}),
    });
    if (snapshot.url !== G28_CONTROL.conversation_url) return { status: "CONTROL_REQUIRED_EXACT_CONTROL_TARGET" };
    return { status: "OBSERVED", snapshot };
  } catch (error) {
    return { status: "CONTROL_REQUIRED_PLAYWRIGHT_SESSION_BINDING_UNAVAILABLE", detail: fromError(error, "WATCH_FAILED") };
  }
}

export async function recordG28Consumed({ runtimeRoot, idempotencyKey, sessionBinding, exec, cliPath, now = () => Date.now() }) {
  const bindingBlock = bindingStatus(sessionBinding);
  if (bindingBlock) throw Object.assign(new Error(bindingBlock), { code: bindingBlock });
  const dir = eventDir(runtimeRoot, idempotencyKey);
  const chain = await readChain(dir);
  if (!chain.delivered) throw Object.assign(new Error("CONTROL_REQUIRED_DELIVERY_NOT_PROVEN"), { code: "CONTROL_REQUIRED_DELIVERY_NOT_PROVEN" });
  if (chain.ack) return { status: "ACK", receipt: chain.ack.receipt, receipt_sha256: chain.ack.receipt_sha256, duplicate: true };
  if (chain.consumed) return { status: "CONSUMED", receipt: chain.consumed.receipt, receipt_sha256: chain.consumed.receipt_sha256, duplicate: true };
  const observed = await watchG28Control(sessionBinding, { exec, cliPath });
  if (observed.status !== "OBSERVED") throw Object.assign(new Error(observed.status), { code: observed.status });
  const { snapshot } = observed;
  if (snapshot?.url !== G28_CONTROL.conversation_url || snapshot?.stopVisible !== false) {
    throw Object.assign(new Error("CONTROL_REQUIRED_CONSUMED_ACK_UNPROVEN"), { code: "CONTROL_REQUIRED_CONSUMED_ACK_UNPROVEN" });
  }
  const message = Array.isArray(snapshot?.assistantMessages) ? snapshot.assistantMessages.at(-1) : "";
  const marker = `GBB_G28_CONSUMED_ACK_V1\nevent_id: ${idempotencyKey}\ncontrol_generation: 028\nconversation_id: ${G28_CONTROL.conversation_id}\nsource_card: ${chain.attempted.receipt.source_card}`;
  if (typeof message !== "string" || !message.includes(marker)) {
    throw Object.assign(new Error("CONTROL_REQUIRED_CONSUMED_ACK_UNPROVEN"), { code: "CONTROL_REQUIRED_CONSUMED_ACK_UNPROVEN" });
  }
  const consumed = await writeReceiptOnce(dir, "consumed", {
    ...Object.fromEntries(Object.entries(chain.delivered.receipt).filter(([key]) => ["idempotency_key", "source_card", "prompt_sha256", "control_generation", "conversation_id", "conversation_url"].includes(key))),
    status: "CONSUMED",
    assistant_message_sha256: sha256(message),
    playwright_session: sessionBinding.session,
    at: isoNow(now),
    previous_receipt_sha256: chain.delivered.receipt_sha256,
  });
  return { status: "CONSUMED", receipt: consumed.receipt, receipt_sha256: consumed.receipt_sha256, duplicate: !consumed.created };
}

export async function recordG28Ack({ runtimeRoot, idempotencyKey, evidence, now = () => Date.now() }) {
  const dir = eventDir(runtimeRoot, idempotencyKey);
  const chain = await readChain(dir);
  const consumed = chain.consumed;
  if (
    !consumed ||
    evidence?.event_id !== idempotencyKey ||
    evidence?.control_generation !== G28_CONTROL.generation ||
    evidence?.conversation_id !== G28_CONTROL.conversation_id ||
    evidence?.conversation_url !== G28_CONTROL.conversation_url ||
    evidence?.source_card !== consumed.receipt.source_card ||
    evidence?.consumed_receipt_sha256 !== consumed.receipt_sha256 ||
    !Number.isInteger(evidence?.readback_comment_id) ||
    evidence.readback_comment_id <= 0
  ) {
    throw Object.assign(new Error("CONTROL_REQUIRED_ACK_BINDING_MISMATCH"), { code: "CONTROL_REQUIRED_ACK_BINDING_MISMATCH" });
  }
  const marker = `GBB_G28_CONTROL_ACK_V1\nevent_id: ${idempotencyKey}\ncontrol_generation: 028\nconversation_id: ${G28_CONTROL.conversation_id}\nsource_card: ${consumed.receipt.source_card}\nconsumed_receipt_sha256: ${consumed.receipt_sha256}`;
  if (typeof evidence.readback_body !== "string" || !evidence.readback_body.includes(marker)) {
    throw Object.assign(new Error("CONTROL_REQUIRED_ACK_BINDING_MISMATCH"), { code: "CONTROL_REQUIRED_ACK_BINDING_MISMATCH" });
  }
  if (chain.ack) return { status: "ACK", receipt: chain.ack.receipt, receipt_sha256: chain.ack.receipt_sha256, duplicate: true };
  const ack = await writeReceiptOnce(dir, "ack", {
    ...receiptIdentity(consumed.receipt),
    status: "ACK",
    consumed_receipt_sha256: consumed.receipt_sha256,
    readback_comment_id: evidence.readback_comment_id,
    readback_body_sha256: sha256(evidence.readback_body),
    at: isoNow(now),
    previous_receipt_sha256: consumed.receipt_sha256,
  });
  return { status: "ACK", receipt: ack.receipt, receipt_sha256: ack.receipt_sha256, duplicate: !ack.created };
}
