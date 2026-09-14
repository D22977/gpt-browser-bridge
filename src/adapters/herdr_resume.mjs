// Deterministic GitHub-first transport seam for a resident Herdr consumer.
//
// This module is intentionally model-free. GitHub supplies the decision and
// durable delivery history; Herdr supplies only the current physical target.
// The adapter never chooses semantic work, a successor, a Reviewer verdict,
// a merge, a release, or a deployment.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const HERDR_RESUME_DELIVERY_PROTOCOL = "HERDR_RESUME_DELIVERY_V1";
export const CONTROL_DECISION_PROTOCOL = "CONTROL_DECISION_V1";
export const DEFAULT_GH = "gh";
export const DEFAULT_HERDR_EXE = "herdr";

const SEND_PENDING = "SEND_PENDING";
const DELIVERED = "DELIVERED";
const UNCERTAIN_SEND = "UNCERTAIN_SEND";

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

function parseSectionedBody(body) {
  const values = Object.create(null);
  const conflicts = [];
  let section = "top";
  for (const rawLine of splitLines(body)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.includes(":") && /^[A-Z][A-Z0-9 _-]{1,60}$/.test(line)) {
      section = line;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = `${section}.${line.slice(0, colon).trim()}`;
    const value = line.slice(colon + 1).trim();
    if (values[key] !== undefined && values[key] !== value) conflicts.push(key);
    values[key] = value;
  }
  return { values, conflicts };
}

export function parseControlDecision(body) {
  const lines = splitLines(body).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== CONTROL_DECISION_PROTOCOL) {
    return { ok: false, reason: "NOT_CONTROL_DECISION_V1", protocol: lines[0] ?? "" };
  }
  const { values, conflicts } = parseSectionedBody(lines.slice(1).join("\n"));
  if (conflicts.length > 0) return { ok: false, reason: "CONFLICTING_DECISION_FIELDS", fields: conflicts };

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
  herdr_agent_provider: z.string().min(1).optional(),
  herdr_model: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  HEAD: z.string().min(1).optional(),
  require_visible: z.boolean().default(false),
  herdr_allowed_statuses: z.array(z.string()).min(1).default(["idle", "working", "ready"]),
  forbidden_pane_ids: z.array(z.string()).default([]),
  forbidden_task_card_ids: z.array(z.string()).default([]),
}).passthrough();

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
    const firstLine = splitLines(body)[0]?.trim();
    if (firstLine !== protocol) continue;
    const match = /(?:^|\n)logical_event_key:\s*(\S+)/.exec(body);
    if (match?.[1] !== logicalKey) continue;
    const state = /(?:^|\n)state:\s*(\S+)/.exec(body)?.[1] ?? null;
    if (!["CONSUMED_STARTED", "UNCERTAIN_SEND"].includes(state)) continue;
    return { receipt_id: comment?.id ?? null, created_at: comment?.created_at ?? null, state };
  }
  return null;
}

function sessionValue(value) {
  if (typeof value === "string") return value;
  return value?.value ?? value?.id ?? "";
}

function normalizeAgent(item) {
  const session = item.agent_session ?? item.session;
  const provider = String(item.agent_provider ?? item.provider ?? session?.source ?? "");
  const sessionAgent = session?.agent ?? "";
  const explicitKind = item.agent_kind ?? item.kind;
  const legacyKind = typeof item.agent === "string" && ["codex", "opencode", "claude"].includes(item.agent)
    ? item.agent
    : "";
  const agentKind = String(explicitKind ?? sessionAgent ?? legacyKind);
  const agentName = String(item.agent_name ?? item.name ?? item.agent ?? agentKind);
  const visibility = typeof item.visible === "boolean"
    ? item.visible
    : typeof item.pane_visible === "boolean"
      ? item.pane_visible
      : undefined;
  return {
    ...item,
    agent_kind: agentKind,
    agent_name: agentName,
    agent_provider: provider,
    agent_session: sessionValue(session),
    model: String(item.model ?? item.agent_model ?? ""),
    workspace_id: String(item.workspace_id ?? ""),
    pane_id: String(item.pane_id ?? ""),
    task_card_id: String(item.task_card_id ?? item.card_id ?? item.task_id ?? ""),
    cwd: String(item.cwd ?? ""),
    branch: String(item.branch ?? item.git_branch ?? ""),
    HEAD: String(item.HEAD ?? item.head ?? item.git_head ?? ""),
    status: String(item.agent_status ?? item.status ?? ""),
    visible: visibility,
  };
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
  return agents.map(normalizeAgent);
}

function targetInputWithAliases(targetInput) {
  const input = { ...targetInput };
  input.herdr_agent ??= input.agent_kind ?? input.executor_kind ?? input.provider;
  input.herdr_agent_kind ??= input.agent_kind ?? input.executor_kind ?? input.herdr_agent;
  input.agent_name ??= input.executor_agent_name ?? input.name;
  input.herdr_workspace_id ??= input.workspace_id;
  input.herdr_pane_id ??= input.pane_id;
  input.herdr_agent_session ??= input.agent_session ?? input.session;
  return input;
}

export function resolveExactHerdrTarget(targetInput, agents) {
  const parsed = targetSchema.safeParse(targetInputWithAliases(targetInput ?? {}));
  if (!parsed.success) return { ok: false, reason: "MISSING_PHYSICAL_TARGET_BINDING" };
  const target = parsed.data;
  const candidates = (Array.isArray(agents) ? agents : []).map(normalizeAgent).filter((candidate) => {
    const names = [candidate.agent_name, candidate.agent_kind, candidate.agent].map(String);
    if (candidate.workspace_id !== target.herdr_workspace_id) return false;
    if (target.herdr_pane_id && candidate.pane_id !== target.herdr_pane_id) return false;
    if (target.herdr_agent_session && candidate.agent_session !== target.herdr_agent_session) return false;
    if (candidate.agent_kind !== target.herdr_agent_kind) return false;
    if (!names.includes(target.herdr_agent)) return false;
    if (target.herdr_agent_provider && candidate.agent_provider !== target.herdr_agent_provider) return false;
    if (target.herdr_model && candidate.model !== target.herdr_model) return false;
    if (!target.herdr_allowed_statuses.includes(candidate.status)) return false;
    if (target.require_visible && candidate.visible !== true) return false;
    if (candidate.visible === false) return false;
    if (target.cwd && candidate.cwd !== target.cwd) return false;
    if (target.branch && candidate.branch !== target.branch) return false;
    if (target.HEAD && candidate.HEAD !== target.HEAD) return false;
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
      agent_provider: candidate.agent_provider,
      model: candidate.model,
      agent_session: candidate.agent_session,
      workspace_id: candidate.workspace_id,
      pane_id: candidate.pane_id,
      terminal_id: candidate.terminal_id ?? null,
      cwd: candidate.cwd || null,
      branch: candidate.branch || null,
      HEAD: candidate.HEAD || null,
      status: candidate.status,
      visible: candidate.visible,
      task_card_id: candidate.task_card_id || null,
    },
  };
}

function samePhysicalTarget(left, right) {
  return ["workspace_id", "pane_id", "agent_session", "agent_kind", "agent_name", "agent_provider", "model", "cwd", "branch", "HEAD", "status", "visible"]
    .every((key) => left?.[key] === right?.[key]);
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
      try {
        await exec(herdrExe, ["agent", "prompt", second.target.pane_id, text]);
      } catch (error) {
        throw Object.assign(new ResumeDeliveryError("SENDER_UNCERTAIN", { cause: error }), { cause: error });
      }
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

function stateForLogicalKey(deliveryState, logicalKey) {
  if (!deliveryState || deliveryState.logical_event_key !== logicalKey) return null;
  return deliveryState;
}

function normalizeGateResult(result) {
  if (result === false) return { allow: false, reason: "AUTHORITY_REVALIDATION_FAILED" };
  if (result && result.allow === false) return result;
  return { allow: true };
}

export async function deliverResumeOnce({
  waitTuple,
  decisionBody,
  comments,
  herdr,
  publishReceipt,
  protocol = HERDR_RESUME_DELIVERY_PROTOCOL,
  now = () => new Date().toISOString(),
  deliveryState = null,
  persistDeliveryState = null,
  beforeSend = null,
}) {
  const tupleCheck = validateWaitTuple(waitTuple);
  if (!tupleCheck.ok) return { decision: "REJECTED", reason: "INVALID_WAIT_TUPLE", errors: tupleCheck.errors };
  const tuple = tupleCheck.waitTuple;
  const parsed = parseControlDecision(decisionBody);
  const matched = matchWaitToDecision(tuple, parsed);
  if (!matched.ok) return { decision: "REJECTED", reason: matched.reason, detail: matched };
  const logicalKey = buildLogicalEventKey(tuple, parsed);
  const localState = stateForLogicalKey(deliveryState, logicalKey);
  if (localState?.state === DELIVERED) return { decision: "NO_OP_DUPLICATE", logical_key: logicalKey, existing_state: DELIVERED };
  if (localState?.state === SEND_PENDING || localState?.state === UNCERTAIN_SEND) {
    return { decision: "NO_BLIND_RETRY", logical_key: logicalKey, reason: localState.state };
  }
  const existing = findExistingDelivery(comments, logicalKey, protocol);
  if (existing) return { decision: "NO_OP_DUPLICATE", logical_key: logicalKey, existing_receipt_id: existing.receipt_id, existing_state: existing.state };

  if (beforeSend) {
    let gate;
    try {
      gate = normalizeGateResult(await beforeSend({ logicalKey, waitTuple: tuple, decision: parsed.decision }));
    } catch (error) {
      return { decision: "REJECTED", logical_key: logicalKey, reason: "AUTHORITY_REVALIDATION_FAILED", error: String(error?.message ?? error) };
    }
    if (!gate.allow) return { decision: gate.decision ?? "REJECTED", logical_key: logicalKey, reason: gate.reason };
  }

  const pendingState = {
    logical_event_key: logicalKey,
    state: SEND_PENDING,
    source_terminal_receipt: tuple.source_terminal_receipt,
    control_generation: tuple.control_generation,
    card_id: tuple.card_id,
    delivery_count: 0,
    updated_at: now(),
  };
  if (persistDeliveryState) {
    try {
      await persistDeliveryState(pendingState);
    } catch (error) {
      return { decision: "REJECTED", logical_key: logicalKey, reason: "PERSISTED_IDEMPOTENCY_WRITE_FAILED", error: String(error?.message ?? error) };
    }
  }

  let evidence;
  try {
    evidence = await herdr.prompt(tuple.target, matched.pointer);
  } catch (error) {
    const uncertain = {
      schema: protocol,
      protocol,
      state: UNCERTAIN_SEND,
      decision: "NO_BLIND_RETRY",
      source_terminal_receipt: tuple.source_terminal_receipt,
      control_generation: tuple.control_generation,
      card_id: tuple.card_id,
      logical_event_key: logicalKey,
      target_herdr_workspace_id: tuple.target.herdr_workspace_id,
      target_herdr_pane_id: tuple.target.herdr_pane_id,
      target_herdr_agent_session: tuple.target.herdr_agent_session,
      delivery_count: 0,
      delivery_status: UNCERTAIN_SEND,
      error_code: error?.code ?? "SENDER_UNCERTAIN",
      error: String(error?.message ?? error),
      user_relay_count: 0,
      delivered_at: now(),
    };
    try { if (persistDeliveryState) await persistDeliveryState({ ...pendingState, ...uncertain, state: UNCERTAIN_SEND, updated_at: now() }); } catch { /* no blind retry remains the safe result */ }
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
    target_cwd: evidence?.cwd ?? null,
    target_branch: evidence?.branch ?? null,
    target_HEAD: evidence?.HEAD ?? null,
    target_visible: evidence?.visible ?? null,
    delivery_count: 1,
    delivery_status: "CONSUMED_STARTED",
    logical_event_key: logicalKey,
    delivered_at: now(),
    herdr_evidence: evidence ?? null,
    user_relay_count: 0,
  };
  try {
    const published = await publishReceipt(receipt);
    if (persistDeliveryState) await persistDeliveryState({ ...pendingState, ...receipt, state: DELIVERED, receipt_id: published?.id ?? null, updated_at: now() });
    return { decision: "DELIVERED", logical_key: logicalKey, receipt_id: published?.id ?? null, receipt };
  } catch (error) {
    try { if (persistDeliveryState) await persistDeliveryState({ ...pendingState, ...receipt, state: UNCERTAIN_SEND, updated_at: now(), error_code: "RECEIPT_PUBLISH_UNCERTAIN" }); } catch { /* safe stop */ }
    return { decision: "NO_BLIND_RETRY", logical_key: logicalKey, receipt, publish_error: String(error?.message ?? error) };
  }
}

function authorityFingerprint(value) {
  if (value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function createResidentHerdrConsumer(config = {}) {
  return {
    async consumeOnce() {
      const consumer = classifyFutureConsumerBinding(config.futureConsumerBinding);
      if (!consumer.bound) return { decision: consumer.state, reason: consumer.state, delivered: false, duplicate: false };

      let initialAuthority = null;
      try {
        initialAuthority = config.readAuthority ? await config.readAuthority({ phase: "start" }) : null;
      } catch (error) {
        return { decision: "REJECTED", reason: "AUTHORITY_READ_FAILED", error: String(error?.message ?? error) };
      }
      if (initialAuthority?.ok === false) return { decision: "REJECTED", reason: initialAuthority.reason ?? "AUTHORITY_READ_FAILED" };
      const authority = initialAuthority?.value ?? initialAuthority ?? {};
      const waitTuple = authority.waitTuple ?? config.waitTuple;
      const decisionBody = authority.decisionBody ?? (config.readDecisionBody ? await config.readDecisionBody({ waitTuple }) : config.decisionBody);
      const comments = authority.comments ?? (config.readComments ? await config.readComments({ waitTuple }) : config.comments ?? []);
      const startingFingerprint = authorityFingerprint(authority.fingerprint ?? authority.binding ?? null);
      const deliveryState = config.readState ? await config.readState() : config.deliveryState ?? null;

      const result = await deliverResumeOnce({
        waitTuple,
        decisionBody,
        comments,
        herdr: config.herdr,
        publishReceipt: config.publishReceipt,
        protocol: config.protocol,
        now: config.now,
        deliveryState,
        persistDeliveryState: config.writeState,
        beforeSend: async (details) => {
          if (config.readAuthority) {
            const latestRaw = await config.readAuthority({ phase: "before_send", logicalKey: details.logicalKey });
            if (latestRaw?.ok === false) return { allow: false, reason: latestRaw.reason ?? "AUTHORITY_REVALIDATION_FAILED" };
            const latest = latestRaw?.value ?? latestRaw ?? {};
            const latestFingerprint = authorityFingerprint(latest.fingerprint ?? latest.binding ?? null);
            if (startingFingerprint !== null && latestFingerprint !== startingFingerprint) {
              return { allow: false, reason: "AUTHORITY_CHANGED" };
            }
          }
          if (config.readComments) {
            const latestComments = await config.readComments({ waitTuple: details.waitTuple, logicalKey: details.logicalKey });
            const duplicate = findExistingDelivery(latestComments, details.logicalKey, config.protocol);
            if (duplicate) return { allow: false, decision: "NO_OP_DUPLICATE", reason: "NO_OP_DUPLICATE" };
          }
          return { allow: true };
        },
      });
      return { ...result, delivered: result.decision === "DELIVERED", duplicate: result.decision === "NO_OP_DUPLICATE" };
    },
  };
}

export async function runResidentConsumerOnce(config) {
  return createResidentHerdrConsumer(config).consumeOnce();
}

function parseGhComments(stdout) {
  const raw = String(stdout ?? "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.flatMap((page) => Array.isArray(page) ? page : [page]);
    return [parsed];
  } catch {
    const comments = [];
    for (const line of String(stdout).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { comments.push(JSON.parse(line)); } catch { throw new ResumeDeliveryError("GITHUB_COMMENTS_INVALID_JSON"); }
    }
    return comments;
  }
}

export function createGhReader({ gh = DEFAULT_GH, exec = defaultExec } = {}) {
  return {
    readDecisionBody: async ({ repo, receiptId }) => {
      const { stdout } = await exec(gh, ["api", `repos/${repo}/issues/comments/${receiptId}`, "--jq", ".body"]);
      return stdout.trim();
    },
    readComments: async ({ repo, issue }) => {
      const { stdout } = await exec(gh, ["api", `repos/${repo}/issues/${issue}/comments`, "--paginate", "--slurp"]);
      return parseGhComments(stdout).map(({ id, created_at, body }) => ({ id, created_at, body }));
    },
    publishComment: async ({ repo, issue, body }) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "gbb-herdr-resume-"));
      const file = path.join(directory, "payload.json");
      try {
        await writeFile(file, JSON.stringify({ body }), "utf8");
        const { stdout } = await exec(gh, ["api", `repos/${repo}/issues/${issue}/comments`, "--input", file, "--jq", ".id"]);
        const id = Number(stdout.trim());
        if (!Number.isSafeInteger(id) || id <= 0) throw new ResumeDeliveryError("GITHUB_PUBLISH_INVALID_ID");
        return { id };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
