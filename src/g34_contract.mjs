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
  claim_comment_id: commentId,
  acceptance_comment_id: commentId,
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
  worker_start_comment_id: commentId.optional(),
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
  let section = null;
  for (const [index, line] of record.body.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (index === 0 && /^[A-Z][A-Z0-9_]*_V[0-9]+$/.test(trimmed)) {
      fields.marker = trimmed;
      continue;
    }
    if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
      section = trimmed.toLowerCase();
      if (Object.hasOwn(fields, section)) throw new Error(`duplicate G34 receipt section: ${section}`);
      fields[section] = {};
      continue;
    }
    const match = /^([a-z][a-z0-9_ ]*):\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const target = section ? fields[section] : fields;
    if (Object.hasOwn(target, key)) throw new Error(`duplicate G34 receipt field: ${key}`);
    target[key] = match[2];
  }
  return fields;
}

function requireRecord(record, label, issueNumber) {
  if (!record || !/^[1-9][0-9]*$/.test(String(record.id ?? ""))) {
    throw new Error(`${label} exact GitHub comment record is required`);
  }
  const id = String(record.id);
  const normalizedUrl = record.url;
  const issueUrl = record.issue_url;
  const normalizedMatch = typeof normalizedUrl === "string"
    ? /^https:\/\/github\.com\/D22977\/gpt-browser-bridge\/issues\/(\d+)#issuecomment-(\d+)$/.exec(normalizedUrl)
    : null;
  const apiMatch = typeof issueUrl === "string"
    ? /^https:\/\/api\.github\.com\/repos\/D22977\/gpt-browser-bridge\/issues\/(\d+)$/.exec(issueUrl)
    : null;
  const issueFromUrl = normalizedMatch ? Number(normalizedMatch[1]) : apiMatch ? Number(apiMatch[1]) : null;
  const idFromUrl = normalizedMatch?.[2];
  if (issueFromUrl !== issueNumber || (idFromUrl && idFromUrl !== id)) {
    throw new Error(`${label} is not the exact current GitHub comment read-back`);
  }
  if (!normalizedMatch && (!apiMatch || !/^[1-9][0-9]*$/.test(id))) {
    throw new Error(`${label} exact GitHub comment URL is required`);
  }
  return { ...parseG34ReceiptFields(record), _record_id: id, _author: record.user?.login };
}

export function parseActiveControlAuthority({ switchReceipt, index43, index81, rehydrationAck }) {
  const switched = requireRecord(switchReceipt, "switch", 88);
  const indexA = requireRecord(index43, "#43 index", 43);
  const indexB = requireRecord(index81, "#81 index", 81);
  const ack = requireRecord(rehydrationAck, "rehydration ACK", 88);
  const next = switched.new_control;
  const old = switched.old_control;
  const activeId = next?.conversation_id;
  if (
    switched.marker !== "CONTROL_GENERATION_ATOMIC_SWITCH_V1" ||
    switched.state !== "ACTIVE_SWITCH_COMMITTED_READBACK_REQUIRED" ||
    old?.generation !== "033" || old.status_after !== "RETIRED" ||
    next?.generation !== "034" || next.status_after !== "ACTIVE" ||
    next.single_active_control !== "true" ||
    !controlId.safeParse(activeId).success
  ) throw new Error("G34 active Control switch is invalid");

  if (switched._author !== "D22977" || indexA._author !== switched._author ||
      indexB._author !== switched._author || ack._author !== switched._author) {
    throw new Error("G34 authority records are not authenticated Control publications");
  }
  const generation = /^034 ACTIVE$/.test(indexA.control_generation ?? "") &&
    /^034 ACTIVE$/.test(indexB.control_generation ?? "");
  const switchPointer = new RegExp(`^#88/${switchReceipt.id}\\b`).test(
    indexA.owner_restoration_authority_and_arch_reconciliation?.["active g34 switch"] ?? "",
  );
  const currentIndexPointer = new RegExp(`^#43/${index43.id}\\b`).test(indexB.current_control ?? "");
  if (!generation || !switchPointer || !currentIndexPointer ||
      indexB.active_control_id !== activeId || indexB.single_active_control !== "true" ||
      String(index43.id) === String(index81.id)) {
    throw new Error("current indexes do not confirm the exact sole active G34 Control");
  }
  const activeState = ack.active_state;
  if (
    ack.marker !== "ACTIVE_CONTROL_REHYDRATION_ACK_V1" ||
    ack.state !== "ACTIVE_REHYDRATED_ACKNOWLEDGED" || ack.generation !== "034" ||
    ack.conversation_id !== activeId ||
    activeState?.sole_active_control_generation !== "034" ||
    activeState.sole_active_control_identity_match !== "true" ||
    activeState.single_active_control !== "true" ||
    activeState.state_pointer_consistency !== "matched" ||
    !new RegExp(`^#88/${switchReceipt.id}\\b`).test(ack.request_and_switch?.atomic_switch ?? "")
  ) throw new Error("G34 active Control rehydration ACK is invalid");

  const authority = {
    control_generation: "034",
    active_control_id: activeId,
    control_conversation_id: activeId,
    publisher_login: switched._author,
    record_ids: {
      switch_comment_id: switched._record_id,
      index43_comment_id: indexA._record_id,
      index81_comment_id: indexB._record_id,
      rehydration_ack_comment_id: ack._record_id,
    },
  };
  Object.defineProperty(authority, "source_records", {
    value: { switchReceipt, index43, index81, rehydrationAck },
    enumerable: false,
  });
  return authority;
}
