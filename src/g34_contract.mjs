import { z } from "zod";

const controlId = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
const commentId = z.string().regex(/^[1-9][0-9]*$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const fieldText = z.string().min(1).refine((value) => !/[\r\n]/.test(value));

export const sourceEventSchema = z.object({
  marker: z.literal("GITHUB_SOURCE_EVENT_V1"),
  event_id: sha256,
  control_generation: z.literal("034"),
  active_control_id: controlId,
  control_conversation_id: controlId,
  event_kind: z.enum(["WORKER_STARTED", "WORKER_TERMINAL_RESULT"]),
  source_comment_id: commentId,
  source_body_sha256: sha256,
  card_comment_id: commentId,
  binding_comment_id: commentId,
  dispatch_comment_id: commentId,
  agent_name: fieldText,
  agent_session: fieldText,
  pane: fieldText,
  terminal: fieldText,
  cwd: fieldText,
  model: fieldText,
  reasoning_effort: fieldText,
  state: fieldText,
  branch: fieldText,
  base_sha: z.string().regex(/^[0-9a-f]{40}$/),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  terminal_comment_id: commentId.optional(),
  review_comment_id: commentId.optional(),
  user_relay_count: z.literal(0),
}).strict().superRefine((event, ctx) => {
  if (event.active_control_id !== event.control_conversation_id) {
    ctx.addIssue({ code: "custom", path: ["control_conversation_id"], message: "must match active Control" });
  }
});

export function parseG34ReceiptFields(record) {
  if (!record || typeof record.body !== "string" || !record.body.trim()) {
    throw new Error("G34 receipt body is required");
  }
  const fields = {};
  for (const [index, line] of record.body.split(/\r?\n/).entries()) {
    if (index === 0 && /^[A-Z][A-Z0-9_]*_V[0-9]+$/.test(line.trim())) {
      fields.marker = line.trim();
      continue;
    }
    const match = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (Object.hasOwn(fields, key)) throw new Error(`duplicate G34 receipt field: ${key}`);
    fields[key] = match[2];
  }
  return fields;
}

function requireRecord(record, label, issueNumber) {
  if (!record || !/^[1-9][0-9]*$/.test(String(record.id ?? ""))) {
    throw new Error(`${label} exact GitHub comment record is required`);
  }
  if (Number(record.issue_number) !== issueNumber || String(record.pointer_id) !== String(record.id)) {
    throw new Error(`${label} is not the exact current pointer read-back`);
  }
  return parseG34ReceiptFields(record);
}

export function parseActiveControlAuthority({ switchReceipt, index43, index81, rehydrationAck }) {
  const switched = requireRecord(switchReceipt, "switch", 88);
  const indexA = requireRecord(index43, "#43 index", 43);
  const indexB = requireRecord(index81, "#81 index", 81);
  const ack = requireRecord(rehydrationAck, "rehydration ACK", 88);
  const activeId = switched.conversation_id;
  if (
    switched.marker !== "CONTROL_GENERATION_ATOMIC_SWITCH_V1" ||
    switched.transition !== "NEW_CONTROL" || switched.generation !== "034" ||
    switched.status_after !== "ACTIVE" || !controlId.safeParse(activeId).success
  ) throw new Error("G34 active Control switch is invalid");

  for (const [label, fields] of [["#43", indexA], ["#81", indexB]]) {
    if (fields.generation !== "034" || fields.status !== "ACTIVE" ||
        fields.active_control_id !== activeId || fields.single_active_control !== "true") {
      throw new Error(`${label} current index does not confirm the sole active G34 Control`);
    }
  }
  if (String(index43.id) === String(index81.id)) throw new Error("current index records must be distinct");
  if (
    ack.marker !== "ACTIVE_CONTROL_REHYDRATION_ACK_V1" || ack.generation !== "034" ||
    ack.status !== "ACTIVE" || ack.active_control_id !== activeId || ack.conversation_id !== activeId
  ) throw new Error("G34 active Control rehydration ACK is invalid");

  return {
    control_generation: "034",
    active_control_id: activeId,
    control_conversation_id: activeId,
  };
}
