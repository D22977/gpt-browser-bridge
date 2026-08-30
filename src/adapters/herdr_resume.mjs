// GPT_BROWSER_BRIDGE - bounded Control -> Herdr resume delivery.
//
// This is the smallest reusable seam from Issue #89 / PR #90. GitHub remains
// the authority. The adapter only matches an exact decision to an exact
// registered wait tuple, resolves one current Herdr 0.8 physical target, and
// performs one prompt. It never chooses semantic work, a successor, a repair,
// a Reviewer, or a product action.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const HERDR_RESUME_DELIVERY_PROTOCOL = "HERDR_RESUME_DELIVERY_V1";
export const CONTROL_DECISION_PROTOCOL = "CONTROL_DECISION_V1";
export const DEFAULT_GH = "gh";
export const DEFAULT_HERDR_EXE =
  "C:\\Users\\Lupun\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe";

export class ResumeDeliveryError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "ResumeDeliveryError";
    this.code = code;
  }
}

export function parseReceiptRef(value) {
  if (typeof value !== "string") return null;
  const match = /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+Issue\s+#(\d+)\s+receipt\s+(\d+)/i.exec(value.trim());
  if (!match) return null;
  return { repo: match[1], issue: Number(match[2]), receipt_id: Number(match[3]) };
}

function splitLines(body) {
  return String(body ?? "").split(/\r?\n/);
}

export function parseControlDecision(body) {
  const lines = splitLines(body).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== CONTROL_DECISION_PROTOCOL) {
    return { ok: false, reason: "NOT_CONTROL_DECISION_V1", protocol: lines[0] ?? "" };
  }
  const values = Object.create(null);
  let section = "top";
  for (const line of lines.slice(1)) {
    if (!line.includes(":") && /^[A-Z][A-Z0-9 _-]{1,60}$/.test(line)) {
      section = line;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    values[`${section}.${line.slice(0, colon).trim()}`] = line.slice(colon + 1).trim();
  }
  const generation = Number(values["top.control_generation"]);
  if (!Number.isInteger(generation) || generation <= 0) {
    return { ok: false, reason: "MISSING_CONTROL_GENERATION" };
  }
  const sourceRef = parseReceiptRef(values["SOURCE_BINDING.source_terminal_receipt"]);
  const sourceGeneration = Number(
    values["SOURCE_BINDING.source_control_generation"] ?? values["top.control_generation"],
  );
  if (!Number.isInteger(sourceGeneration) || sourceGeneration <= 0) {
    return { ok: false, reason: "MISSING_SOURCE_CONTROL_GENERATION" };
  }
  return {
    ok: true,
    decision: {
      state: values["top.state"] ?? "",
      control_generation: generation,
      decision_topic: values["top.decision_topic"] ?? "",
      source_terminal_receipt_id: sourceRef?.receipt_id ?? null,
      source_terminal_receipt_ref: values["SOURCE_BINDING.source_terminal_receipt"] ?? "",
      source_control_generation: sourceGeneration,
      resume_card_id: values["SOURCE_BINDING.resume_card_id"] ?? values["SOURCE_BINDING.resume_card"] ?? "",
      target: {
        role: values["EXACT_TARGET.executor_role"] ?? "",
        agent_name: values["EXACT_TARGET.agent_name"] ?? "",
        executor_instance_id: values["EXACT_TARGET.executor_instance_id"] ?? "",
        surface: values["EXACT_TARGET.surface"] ?? "",
      },
      wake_action: values["EXACT_TARGET.wake_action"] ?? "",
      minimal_wake: values["EXACT_TARGET.minimal_wake"] ?? "",
    },
  };
}

const targetSchema = z.object({
  agent_name: z.string().min(1),
  executor_instance_id: z.string().min(1),
  surface: z.string().min(1),
  herdr_agent: z.string().min(1),
  herdr_workspace_id: z.string().min(1),
  herdr_pane_id: z.string().min(1).optional(),
  herdr_agent_session: z.string().min(1).optional(),
  herdr_agent_kind: z.string().min(1),
  forbidden_pane_ids: z.array(z.string()).default([]),
  forbidden_task_card_ids: z.array(z.string()).default([]),
  herdr_allowed_statuses: z.array(z.string()).min(1).default(["idle", "working"]),
});

export const waitTupleSchema = z.object({
  source_terminal_receipt: z.number().int().positive(),
  control_generation: z.number().int().positive(),
  card_id: z.string().min(1),
  allowed_action_class: z.string().min(1),
  target: targetSchema,
});

export function validateWaitTuple(value) {
  const parsed = waitTupleSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  }
  return { ok: true, waitTuple: parsed.data };
}

export function matchWaitToDecision(waitTuple, decision) {
  if (!decision?.ok) return { ok: false, reason: decision?.reason ?? "INVALID_DECISION" };
  const d = decision.decision;
  if (d.state !== "EXECUTE_NOW") return { ok: false, reason: "DECISION_NOT_EXECUTE_NOW", state: d.state };
  if (d.control_generation !== waitTuple.control_generation) {
    return { ok: false, reason: "WRONG_GENERATION", got: d.control_generation, expected: waitTuple.control_generation };
  }
  if (d.source_terminal_receipt_id !== waitTuple.source_terminal_receipt) {
    return { ok: false, reason: "WRONG_SOURCE_TERMINAL", got: d.source_terminal_receipt_id, expected: waitTuple.source_terminal_receipt };
  }
  if (d.source_control_generation !== waitTuple.control_generation) {
    return { ok: false, reason: "WRONG_SOURCE_GENERATION", got: d.source_control_generation, expected: waitTuple.control_generation };
  }
  if (!d.resume_card_id.toLowerCase().includes(waitTuple.card_id.toLowerCase())) {
    return { ok: false, reason: "WRONG_CARD", got: d.resume_card_id, expected: waitTuple.card_id };
  }
  if (d.target.agent_name !== waitTuple.target.agent_name) {
    return { ok: false, reason: "WRONG_TARGET_AGENT", got: d.target.agent_name, expected: waitTuple.target.agent_name };
  }
  if (d.target.executor_instance_id !== waitTuple.target.executor_instance_id) {
    return { ok: false, reason: "WRONG_TARGET_INSTANCE", got: d.target.executor_instance_id, expected: waitTuple.target.executor_instance_id };
  }
  if (d.target.surface !== waitTuple.target.surface) {
    return { ok: false, reason: "WRONG_TARGET_SURFACE", got: d.target.surface, expected: waitTuple.target.surface };
  }
  const pointer = (d.minimal_wake || d.wake_action || "").trim();
  if (!pointer) return { ok: false, reason: "MISSING_WAKE_POINTER" };
  return { ok: true, pointer, decision: d };
}

export function buildLogicalEventKey(waitTuple, decision) {
  const d = decision?.decision ?? {};
  return [
    String(waitTuple.source_terminal_receipt),
    String(waitTuple.control_generation),
    waitTuple.card_id,
    d.target?.agent_name ?? waitTuple.target.agent_name,
    d.target?.executor_instance_id ?? waitTuple.target.executor_instance_id,
  ].join("|");
}

export function findExistingDelivery(comments, logicalKey, protocol = HERDR_RESUME_DELIVERY_PROTOCOL) {
  for (const comment of Array.isArray(comments) ? comments : []) {
    const body = String(comment?.body ?? "");
    const firstLine = body.split(/\r?\n/, 1)[0]?.trim();
    if (firstLine !== protocol) continue;
    const match = /logical_event_key:\s*(\S+)/.exec(body);
    if (match?.[1] === logicalKey) {
      const state = /(?:^|\n)state:\s*(\S+)/.exec(body)?.[1] ?? null;
      if (!["CONSUMED_STARTED", "UNCERTAIN_SEND"].includes(state)) continue;
      return { receipt_id: comment?.id ?? null, created_at: comment?.created_at ?? null, state };
    }
  }
  return null;
}

function sessionValue(value) {
  if (typeof value === "string") return value;
  return value?.value ?? value?.id ?? "";
}

export function parseHerdrAgentList(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new ResumeDeliveryError("HERDR_AGENT_LIST_INVALID_JSON");
    }
  }
  const agents = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.result?.agents)
      ? parsed.result.agents
      : Array.isArray(parsed?.agents)
        ? parsed.agents
        : Array.isArray(parsed?.result?.panes)
          ? parsed.result.panes
          : null;
  if (!agents) throw new ResumeDeliveryError("HERDR_AGENT_LIST_INVALID");
  return agents.map((item) => ({
    ...item,
    agent_kind: String(item.agent_kind ?? item.kind ?? item.agent ?? ""),
    agent_name: String(item.agent_name ?? item.name ?? item.agent ?? ""),
    agent_session: sessionValue(item.agent_session ?? item.session),
    workspace_id: String(item.workspace_id ?? ""),
    pane_id: String(item.pane_id ?? ""),
    task_card_id: String(item.task_card_id ?? item.card_id ?? item.task_id ?? ""),
    status: String(item.agent_status ?? item.status ?? ""),
  }));
}

export function resolveExactHerdrTarget(targetInput, agents) {
  const parsed = targetSchema.safeParse(targetInput);
  if (!parsed.success) return { ok: false, reason: "MISSING_PHYSICAL_TARGET_BINDING" };
  const target = parsed.data;
  const candidates = (Array.isArray(agents) ? agents : []).filter((candidate) => {
    const names = [candidate.agent_name, candidate.agent_kind, candidate.agent, candidate.name].map(String);
    if (candidate.workspace_id !== target.herdr_workspace_id) return false;
    if (target.herdr_pane_id && candidate.pane_id !== target.herdr_pane_id) return false;
    if (target.herdr_agent_session && candidate.agent_session !== target.herdr_agent_session) return false;
    if (candidate.agent_kind !== target.herdr_agent_kind) return false;
    if (!names.includes(target.herdr_agent)) return false;
    if (!target.herdr_allowed_statuses.includes(candidate.status)) return false;
    if (target.forbidden_pane_ids.includes(candidate.pane_id)) return false;
    if (candidate.task_card_id && target.forbidden_task_card_ids.includes(candidate.task_card_id)) return false;
    return true;
  });
  if (candidates.length === 0) return { ok: false, reason: "NO_ELIGIBLE_PHYSICAL_TARGET", count: 0 };
  if (candidates.length !== 1) return { ok: false, reason: "AMBIGUOUS_PHYSICAL_TARGET", count: candidates.length };
  const candidate = candidates[0];
  return {
    ok: true,
    target: {
      agent_kind: candidate.agent_kind,
      agent_name: candidate.agent_name,
      agent_session: candidate.agent_session,
      workspace_id: candidate.workspace_id,
      pane_id: candidate.pane_id,
      terminal_id: candidate.terminal_id ?? null,
      cwd: candidate.cwd ?? null,
      status: candidate.status,
      task_card_id: candidate.task_card_id || null,
    },
  };
}

function samePhysicalTarget(left, right) {
  return left?.workspace_id === right?.workspace_id
    && left?.pane_id === right?.pane_id
    && left?.agent_session === right?.agent_session
    && left?.agent_kind === right?.agent_kind;
}

function defaultExec(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(error.message), { cause: error, stderr }));
      else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export function createHerdrPrompter({ herdrExe = DEFAULT_HERDR_EXE, exec = defaultExec, runtimeIdentity = null } = {}) {
  const listAgents = async () => {
    const { stdout } = await exec(herdrExe, ["agent", "list"]);
    return parseHerdrAgentList(stdout);
  };
  return {
    listAgents,
    prompt: async (target, text) => {
      const first = resolveExactHerdrTarget(target, await listAgents());
      if (!first.ok) throw new ResumeDeliveryError(first.reason);
      const second = resolveExactHerdrTarget(target, await listAgents());
      if (!second.ok) throw new ResumeDeliveryError("STALE_PHYSICAL_TARGET", { cause: second.reason });
      if (!samePhysicalTarget(first.target, second.target)) throw new ResumeDeliveryError("STALE_PHYSICAL_TARGET");
      await exec(herdrExe, ["agent", "prompt", second.target.pane_id, text]);
      return {
        accepted: true,
        runtime: runtimeIdentity ?? "herdr",
        target: second.target,
        ...second.target,
        prompt_target: second.target.pane_id,
      };
    },
  };
}

export function classifyFutureConsumerBinding(binding) {
  const valid = Boolean(
    binding
    && binding.resident === true
    && binding.restartable === true
    && typeof binding.source === "string"
    && Array.isArray(binding.event_classes)
    && binding.event_classes.includes(CONTROL_DECISION_PROTOCOL),
  );
  if (!valid) return { state: "CONTROL_REQUIRED_FUTURE_CONSUMER_BINDING_MISSING", bound: false };
  return { state: "FUTURE_WAKE_BOUND", bound: true, source: binding.source };
}

export function resolveActiveControlBinding(body) {
  const lines = splitLines(body);
  if (lines[0]?.trim() !== "CONTROL_GENERATION_SWITCH_V1") return { ok: false, reason: "NOT_CONTROL_SWITCH" };
  const values = Object.create(null);
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon !== -1) values[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const generation = Number(values.new_generation);
  if (!Number.isInteger(generation) || generation <= 0) return { ok: false, reason: "MISSING_ACTIVE_GENERATION" };
  if (values.new_generation_status !== "ACTIVE" || !values.new_conversation_id) {
    return { ok: false, reason: "ACTIVE_CONTROL_NOT_PROVEN" };
  }
  return { ok: true, generation, conversation_id: values.new_conversation_id };
}

export async function deliverResumeOnce({
  waitTuple,
  decisionBody,
  comments,
  herdr,
  publishReceipt,
  protocol = HERDR_RESUME_DELIVERY_PROTOCOL,
  now = () => new Date().toISOString(),
}) {
  const tupleCheck = validateWaitTuple(waitTuple);
  if (!tupleCheck.ok) return { decision: "REJECTED", reason: "INVALID_WAIT_TUPLE", errors: tupleCheck.errors };
  const tuple = tupleCheck.waitTuple;
  const parsed = parseControlDecision(decisionBody);
  const matched = matchWaitToDecision(tuple, parsed);
  if (!matched.ok) return { decision: "REJECTED", reason: matched.reason, detail: matched };
  const logicalKey = buildLogicalEventKey(tuple, parsed);
  const existing = findExistingDelivery(comments, logicalKey, protocol);
  if (existing) return { decision: "NO_OP_DUPLICATE", logical_key: logicalKey, existing_receipt_id: existing.receipt_id, existing_state: existing.state };

  let evidence;
  try {
    evidence = await herdr.prompt(tuple.target, matched.pointer);
  } catch (error) {
    const uncertain = {
      schema: protocol,
      protocol,
      state: "UNCERTAIN_SEND",
      decision: "NO_BLIND_RETRY",
      source_terminal_receipt: tuple.source_terminal_receipt,
      control_generation: tuple.control_generation,
      card_id: tuple.card_id,
      logical_event_key: logicalKey,
      target_herdr_workspace_id: tuple.target.herdr_workspace_id,
      target_herdr_pane_id: tuple.target.herdr_pane_id,
      target_herdr_agent_session: tuple.target.herdr_agent_session,
      delivery_count: 0,
      delivery_status: "UNCERTAIN_SEND",
      error_code: error?.code ?? "SENDER_UNCERTAIN",
      error: String(error?.message ?? error),
      user_relay_count: 0,
      delivered_at: now(),
    };
    try {
      const published = await publishReceipt(uncertain);
      return { decision: "NO_BLIND_RETRY", logical_key: logicalKey, receipt_id: published?.id ?? null, receipt: uncertain };
    } catch (publishError) {
      return { decision: "NO_BLIND_RETRY", logical_key: logicalKey, receipt: uncertain, publish_error: String(publishError?.message ?? publishError) };
    }
  }

  const receipt = {
    schema: protocol,
    protocol,
    state: "CONSUMED_STARTED",
    decision: "DELIVERED",
    source_terminal_receipt: tuple.source_terminal_receipt,
    control_generation: tuple.control_generation,
    card_id: tuple.card_id,
    allowed_action_class: tuple.allowed_action_class,
    target_agent_name: tuple.target.agent_name,
    target_executor_instance_id: tuple.target.executor_instance_id,
    target_surface: tuple.target.surface,
    target_herdr_agent: tuple.target.herdr_agent,
    target_herdr_workspace_id: evidence?.workspace_id ?? tuple.target.herdr_workspace_id,
    target_herdr_pane_id: evidence?.pane_id ?? tuple.target.herdr_pane_id,
    target_herdr_agent_session: evidence?.agent_session ?? tuple.target.herdr_agent_session,
    target_herdr_terminal_id: evidence?.terminal_id ?? null,
    delivery_count: 1,
    delivery_status: "CONSUMED_STARTED",
    logical_event_key: logicalKey,
    delivered_at: now(),
    herdr_evidence: evidence ?? null,
    user_relay_count: 0,
  };
  try {
    const published = await publishReceipt(receipt);
    return { decision: "DELIVERED", logical_key: logicalKey, receipt_id: published?.id ?? null, receipt };
  } catch (error) {
    return { decision: "NO_BLIND_RETRY", logical_key: logicalKey, receipt, publish_error: String(error?.message ?? error) };
  }
}

export function createGhReader({ gh = DEFAULT_GH, exec = defaultExec } = {}) {
  return {
    readDecisionBody: async ({ repo, receiptId }) => {
      const { stdout } = await exec(gh, ["api", `repos/${repo}/issues/comments/${receiptId}`, "--jq", ".body"]);
      return stdout.trim();
    },
    readComments: async ({ repo, issue }) => {
      const { stdout } = await exec(gh, ["api", `repos/${repo}/issues/${issue}/comments`, "--paginate", "--jq", ".[] | {id, created_at, body}"]);
      const comments = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          comments.push(JSON.parse(line));
        } catch {
          throw new ResumeDeliveryError("GITHUB_COMMENTS_INVALID_JSON");
        }
      }
      return comments;
    },
    publishComment: async ({ repo, issue, body }) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "gbb-herdr-resume-"));
      const file = path.join(directory, "payload.json");
      try {
        await writeFile(file, JSON.stringify({ body }), "utf8");
        const { stdout } = await exec(gh, ["api", `repos/${repo}/issues/${issue}/comments`, "--input", file, "--jq", ".id"]);
        const id = Number(stdout.trim());
        if (!Number.isInteger(id) || id <= 0) throw new ResumeDeliveryError("GITHUB_PUBLISH_INVALID_ID");
        return { id };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
