import { z } from "zod";

const controlId = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
const commentId = z.string().regex(/^[1-9][0-9]*$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const fieldText = z.string().min(1).refine((value) => !/[\r\n]/.test(value));
const REPOSITORY = "D22977/gpt-browser-bridge";

export const sourceEventSchema = z.object({
  marker: z.literal("GITHUB_SOURCE_EVENT_V1"),
  event_id: sha256,
  control_generation: z.literal("034"),
  active_control_id: controlId,
  control_conversation_id: controlId,
  event_kind: z.enum(["WORKER_STARTED", "WORKER_TERMINAL_RESULT"]),
  source_comment_id: commentId,
  source_body_sha256: sha256,
  repository: z.literal(REPOSITORY),
  card_comment_id: commentId,
  binding_comment_id: commentId,
  dispatch_comment_id: commentId,
  claim_comment_id: commentId,
  claim_acceptance_comment_id: commentId,
  attempt_id: fieldText,
  lease_id: fieldText,
  lease_generation: fieldText,
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
  start_receipt_comment_id: commentId.optional(),
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
  const fields = { sections: Object.create(null) };
  let section = null;
  for (const [index, raw] of record.body.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (index === 0 && /^[A-Z][A-Z0-9_]*_V[0-9]+$/.test(line)) {
      fields.marker = line;
      continue;
    }
    if (/^[A-Z][A-Z0-9_]*$/.test(line)) {
      section = line;
      if (Object.hasOwn(fields.sections, section)) throw new Error(`duplicate G34 receipt section: ${section}`);
      fields.sections[section] = Object.create(null);
      continue;
    }
    const match = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    const target = section ? fields.sections[section] : fields;
    const key = match[1].toLowerCase();
    if (Object.hasOwn(target, key)) throw new Error(`duplicate G34 receipt field: ${section ? section + "." : ""}${key}`);
    target[key] = match[2];
  }
  return fields;
}

export function g34Field(fields, key, sectionOrder = []) {
  for (const section of sectionOrder) {
    if (Object.hasOwn(fields?.sections?.[section] ?? {}, key)) return fields.sections[section][key];
  }
  if (Object.hasOwn(fields ?? {}, key)) return fields[key];
  const matches = Object.values(fields?.sections ?? {}).filter((section) => Object.hasOwn(section, key));
  if (matches.length > 1) throw new Error(`ambiguous G34 receipt field across sections: ${key}`);
  return matches[0]?.[key];
}

export function githubCommentIdentity(record, label = "GitHub comment") {
  const id = String(record?.id ?? "");
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error(`${label} exact GitHub comment id is required`);
  const metadataIssue = /^https:\/\/api\.github\.com\/repos\/D22977\/gpt-browser-bridge\/issues\/([1-9][0-9]*)$/.exec(record?.issue_url ?? "");
  const apiComment = /^https:\/\/api\.github\.com\/repos\/D22977\/gpt-browser-bridge\/issues\/comments\/([1-9][0-9]*)$/.exec(record?.url ?? "");
  const webComment = /^https:\/\/github\.com\/D22977\/gpt-browser-bridge\/issues\/([1-9][0-9]*)#issuecomment-([1-9][0-9]*)$/.exec(record?.html_url ?? record?.url ?? "");
  const webIssue = /^https:\/\/github\.com\/D22977\/gpt-browser-bridge\/issues\/([1-9][0-9]*)$/.exec(record?.html_url ?? "");
  const issueNumber = metadataIssue ? Number(metadataIssue[1]) : webComment ? Number(webComment[1]) : webIssue ? Number(webIssue[1]) : null;
  const urlCommentId = apiComment?.[1] ?? webComment?.[2];
  if (!issueNumber || (metadataIssue && webComment && Number(webComment[1]) !== issueNumber) ||
      (urlCommentId && urlCommentId !== id) || (!metadataIssue && !webComment && !webIssue)) {
    throw new Error(`${label} is not the exact current GitHub GET comment identity`);
  }
  return { id, issue_number: issueNumber };
}

function requireRecord(record, label, issueNumber) {
  const identity = githubCommentIdentity(record, label);
  if (identity.issue_number !== issueNumber) throw new Error(`${label} is not from issue #${issueNumber}`);
  return { ...parseG34ReceiptFields(record), id: identity.id, author: record.user?.login };
}

function field(fields, key, section) {
  return section ? fields.sections?.[section]?.[key] : fields[key];
}

function requireIndex(fields, label, activeId) {
  const generation = fields.control_generation ?? fields.generation;
  const active = fields.active_control_id ?? fields.sections?.CURRENT_CONTROL?.conversation_id;
  const sole = fields.single_active_control ?? fields.sections?.CURRENT_CONTROL?.single_active_control;
  const current = generation === "034 ACTIVE" ||
    (fields.generation === "034" && fields.status === "ACTIVE");
  if (!current || active !== activeId || sole !== "true") {
    throw new Error(`${label} current index does not confirm the sole active G34 Control`);
  }
}

function linkedCommentId(value, issueNumber) {
  const match = new RegExp(`(?:^|\\s)#${issueNumber}/([1-9][0-9]*)(?:\\s|$)`).exec(String(value ?? ""));
  return match?.[1] ?? null;
}

export function parseActiveControlAuthority({ switchReceipt, index43, index81, rehydrationAck }) {
  const switched = requireRecord(switchReceipt, "switch", 88);
  const indexA = requireRecord(index43, "#43 index", 43);
  const indexB = requireRecord(index81, "#81 index", 81);
  const ack = requireRecord(rehydrationAck, "rehydration ACK", 88);

  const activeId = field(switched, "conversation_id", "NEW_CONTROL");
  const activeGeneration = field(switched, "generation", "NEW_CONTROL");
  if (
    switched.marker !== "CONTROL_GENERATION_ATOMIC_SWITCH_V1" ||
    switched.repository !== REPOSITORY ||
    field(switched, "status_after", "NEW_CONTROL") !== "ACTIVE" ||
    activeGeneration !== "034" || !controlId.safeParse(activeId).success ||
    field(switched, "status_after", "OLD_CONTROL") !== "RETIRED" ||
    switched.author !== ack.author || !switched.author
  ) throw new Error("G34 active Control switch is invalid");

  requireIndex(indexA, "#43", activeId);
  requireIndex(indexB, "#81", activeId);
  if (index43.id === index81.id) throw new Error("current index records must be distinct");
  if (indexA.repository !== REPOSITORY || indexB.repository !== REPOSITORY) {
    throw new Error("current indexes are not for the exact G34 repository");
  }
  if (linkedCommentId(indexA.atomic_switch, 88) !== switched.id ||
      linkedCommentId(indexB.atomic_switch, 88) !== switched.id ||
      linkedCommentId(indexB.current_start, 43) !== indexA.id) {
    throw new Error("current Control indexes do not point to the exact switch and each other");
  }
  const ackState = ack.sections?.ACTIVE_STATE;
  if (
    ack.marker !== "ACTIVE_CONTROL_REHYDRATION_ACK_V1" ||
    ack.repository !== REPOSITORY ||
    ack.state !== "ACTIVE_REHYDRATED_ACKNOWLEDGED" ||
    ack.generation !== "034" || ack.conversation_id !== activeId ||
    ackState?.sole_active_control_generation !== "034" ||
    ackState?.sole_active_control_identity_match !== "true" ||
    ackState?.old033_status !== "RETIRED" ||
    ackState?.generation032_status !== "EXHAUSTED_NEVER_ACTIVE" ||
    ackState?.single_active_control !== "true" ||
    ackState?.state_pointer_consistency !== "matched" ||
    linkedCommentId(ack.atomic_switch, 88) !== switched.id ||
    linkedCommentId(ack.current_start, 43) !== indexA.id ||
    linkedCommentId(ack.current_registry, 81) !== indexB.id
  ) throw new Error("G34 active Control rehydration ACK is invalid");

  return {
    control_generation: "034",
    active_control_id: activeId,
    control_conversation_id: activeId,
    active_control_github_login: switched.author,
    source_comment_ids: {
      switch: switched.id,
      index43: indexA.id,
      index81: indexB.id,
      rehydration_ack: ack.id,
    },
  };
}
