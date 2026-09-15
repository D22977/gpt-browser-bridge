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
export const CURRENT_COMMENT_READBACK_PROTOCOL = "GITHUB_ISSUE_COMMENTS_PAGINATED_READBACK_V1";
export const DEFAULT_GH = "gh";
export const DEFAULT_HERDR_EXE = "herdr";

const SEND_PENDING = "SEND_PENDING";
const DELIVERED = "DELIVERED";
const UNCERTAIN_SEND = "UNCERTAIN_SEND";
const RETRY_PENDING = "RETRY_PENDING";
const CONTROL_REQUIRED = "CONTROL_REQUIRED";

const RFC3339_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function normalizeWakeAt(value) {
  if (typeof value !== "string" || !RFC3339_OFFSET_PATTERN.test(value)) {
    return { ok: false, reason: "WAKE_AT_RFC3339_OFFSET_REQUIRED" };
  }
  const wakeAtMs = Date.parse(value);
  if (!Number.isFinite(wakeAtMs)) return { ok: false, reason: "WAKE_AT_INVALID" };
  return { ok: true, wake_at: new Date(wakeAtMs).toISOString(), wake_at_ms: wakeAtMs };
}

export function evaluateTimedQuotaState(state, { nowMs = Date.now(), hostId = null, authorizedHostIds = [] } = {}) {
  if (state?.state === DELIVERED) return { decision: "NO_OP_DUPLICATE", reason: DELIVERED };
  if (state?.consumer_host_id && state.consumer_host_id !== hostId && !authorizedHostIds.includes(hostId)) {
    return { decision: CONTROL_REQUIRED, reason: "HOST_IDENTITY_REJECTED" };
  }
  if ((Number.isInteger(state?.retry_count) && state.retry_count > 1) || (state?.state === RETRY_PENDING && state?.retry_count !== 1)) {
    return { decision: CONTROL_REQUIRED, reason: "RETRY_BUDGET_EXHAUSTED" };
  }
  if (state?.prompt_submitted === true || state?.physical_send_started === true) {
    return { decision: "NO_BLIND_RETRY", reason: "PHYSICAL_SEND_BOUNDARY_REACHED" };
  }
  if (state?.state === SEND_PENDING || state?.state === UNCERTAIN_SEND) {
    return { decision: "NO_BLIND_RETRY", reason: state.state };
  }
  if (state?.state === CONTROL_REQUIRED) return { decision: CONTROL_REQUIRED, reason: state.reason ?? CONTROL_REQUIRED };
  const wake = normalizeWakeAt(state?.wake_at);
  if (!wake.ok) return { decision: CONTROL_REQUIRED, reason: wake.reason };
  if (nowMs < wake.wake_at_ms) return { decision: "WAIT_UNTIL_WAKE", wake_at: wake.wake_at, wake_at_ms: wake.wake_at_ms };
  return { decision: "SEND_ALLOWED", wake_at: wake.wake_at, wake_at_ms: wake.wake_at_ms };
}

export function advanceTimedQuotaState(state, options = {}) {
  const evaluated = evaluateTimedQuotaState(state, options);
  const nextState = evaluated.wake_at
    ? { ...state, wake_at: evaluated.wake_at, wake_at_ms: evaluated.wake_at_ms }
    : state;
  return { ...evaluated, state: nextState };
}

function hasFallbackRoute(value) {
  return Object.keys(value).some((key) => /fallback/i.test(key));
}

export function validateFreeRoutePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return { ok: false, reason: "MISSING_ROUTE" };
  if (hasFallbackRoute(policy)) {
    return { ok: false, reason: "PAID_FALLBACK_FORBIDDEN" };
  }
  if (typeof policy.provider !== "string" || !policy.provider || typeof policy.model !== "string" || !policy.model) {
    return { ok: false, reason: "MISSING_ROUTE" };
  }
  if (policy.billing_class !== "FREE") return { ok: false, reason: "NON_FREE_ROUTE" };
  if (policy.max_cost !== 0) return { ok: false, reason: "NONZERO_COST_ROUTE" };
  return { ok: true, policy };
}

export function validateFreeRoute(route, policy) {
  if (!route || typeof route !== "object" || Array.isArray(route)) return { ok: false, reason: "MISSING_ROUTE" };
  const policyCheck = validateFreeRoutePolicy(policy);
  if (!policyCheck.ok) return policyCheck;
  if (hasFallbackRoute(route)) {
    return { ok: false, reason: "PAID_FALLBACK_FORBIDDEN" };
  }
  if (route.provider !== policy.provider) return { ok: false, reason: "WRONG_PROVIDER" };
  if (route.model !== policy.model) return { ok: false, reason: "WRONG_MODEL" };
  if (route.billing_class !== "FREE") return { ok: false, reason: "NON_FREE_ROUTE" };
  if (route.max_cost !== 0) return { ok: false, reason: "NONZERO_COST_ROUTE" };
  return { ok: true, route };
}

export function validateFreeRouteAgainstPhysicalTarget(policy, target) {
  const policyCheck = validateFreeRoutePolicy(policy);
  if (!policyCheck.ok) return policyCheck;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return { ok: false, reason: "MISSING_PHYSICAL_TARGET_BINDING" };
  }
  const provider = target.herdr_agent_provider ?? target.agent_provider;
  const model = target.herdr_model ?? target.model;
  if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) {
    return { ok: false, reason: "MISSING_PHYSICAL_TARGET_BINDING" };
  }
  if (provider !== policy.provider) return { ok: false, reason: "WRONG_PROVIDER" };
  if (model !== policy.model) return { ok: false, reason: "WRONG_MODEL" };
  return { ok: true, target };
}

export function parseAuthoritativeQuotaEvidence(evidence, { routePolicy = null, observedAtMs = Date.now() } = {}) {
  if (!evidence || typeof evidence !== "object" || evidence.authoritative !== true) {
    return { ok: false, reason: "QUOTA_EVIDENCE_NOT_AUTHORITATIVE" };
  }
  if (!Number.isFinite(observedAtMs)) return { ok: false, reason: "QUOTA_OBSERVED_TIME_INVALID" };
  const route = validateFreeRoute(evidence, routePolicy);
  if (!route.ok) return route;
  if (!evidence.provenance || typeof evidence.provenance !== "object" || typeof evidence.provenance.source !== "string" || !evidence.provenance.source) {
    return { ok: false, reason: "QUOTA_PROVENANCE_MISSING" };
  }
  const wakeCandidates = [];
  if (evidence.retry_after_seconds !== undefined) {
    const seconds = Number(evidence.retry_after_seconds);
    if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, reason: "INVALID_RETRY_AFTER" };
    wakeCandidates.push(observedAtMs + seconds * 1000);
  }
  if (evidence.reset_at !== undefined) {
    const reset = normalizeWakeAt(evidence.reset_at);
    if (!reset.ok) return { ok: false, reason: "INVALID_QUOTA_RESET" };
    wakeCandidates.push(reset.wake_at_ms);
  }
  if (wakeCandidates.length === 0) return { ok: false, reason: "QUOTA_RESET_MISSING" };
  const wakeAtMs = Math.max(...wakeCandidates);
  return {
    ok: true,
    wake_at: new Date(wakeAtMs).toISOString(),
    wake_at_ms: wakeAtMs,
    provider: evidence.provider,
    model: evidence.model,
    billing_class: evidence.billing_class,
    max_cost: evidence.max_cost,
    provenance: evidence.provenance,
  };
}

export function scheduleQuotaRetry(state, evidence, { observedAtMs = Date.now(), routePolicy = null } = {}) {
  if (!evidence?.ok) return { ok: false, reason: evidence?.reason ?? "QUOTA_EVIDENCE_INVALID" };
  if ([SEND_PENDING, UNCERTAIN_SEND].includes(state?.state) || state?.prompt_submitted === true || state?.physical_send_started === true) {
    return { ok: false, reason: "NO_BLIND_RETRY" };
  }
  const route = validateFreeRoute(evidence, routePolicy);
  if (!route.ok) return route;
  if (typeof evidence.wake_at !== "string" || !Number.isFinite(evidence.wake_at_ms) || !evidence.provenance || typeof evidence.provenance !== "object" || typeof evidence.provenance.source !== "string" || !evidence.provenance.source) {
    return { ok: false, reason: "QUOTA_EVIDENCE_INVALID" };
  }
  if (!Number.isInteger(state?.retry_count) || state.retry_count < 0) return { ok: false, reason: "RETRY_STATE_INVALID" };
  if (state.retry_count >= 1) return { ok: false, reason: "RETRY_BUDGET_EXHAUSTED" };
  if (!Number.isFinite(observedAtMs)) return { ok: false, reason: "QUOTA_OBSERVED_TIME_INVALID" };
  return {
    ok: true,
    state: {
      ...state,
      state: RETRY_PENDING,
      retry_count: 1,
      retry_budget: 1,
      wake_at: evidence.wake_at,
      wake_at_ms: evidence.wake_at_ms,
      quota_route: {
        provider: evidence.provider,
        model: evidence.model,
        billing_class: evidence.billing_class,
        max_cost: evidence.max_cost,
      },
      quota_evidence: evidence.provenance,
      prompt_submitted: false,
      physical_send_started: false,
      updated_at_ms: observedAtMs,
    },
  };
}

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
  const sourceGenerationValue = values["SOURCE_BINDING.source_control_generation"];
  const sourceGeneration = Number(sourceGenerationValue);
  if (!Number.isInteger(sourceGeneration) || sourceGeneration <= 0) {
    return { ok: false, reason: "MISSING_SOURCE_CONTROL_GENERATION" };
  }
  let timedWake = null;
  const wakeAtRaw = values["TIMED_QUOTA.wake_at"] ?? values["top.wake_at"];
  if (wakeAtRaw) {
    const normalized = normalizeWakeAt(wakeAtRaw);
    if (!normalized.ok) return { ok: false, reason: normalized.reason };
    timedWake = normalized;
  }
  const provider = values["TIMED_QUOTA.provider"];
  const model = values["TIMED_QUOTA.model"];
  const billingClass = values["TIMED_QUOTA.billing_class"];
  const maxCostRaw = values["TIMED_QUOTA.max_cost"];
  const quotaRoute = provider || model || billingClass || maxCostRaw !== undefined
    ? { provider: provider ?? "", model: model ?? "", billing_class: billingClass ?? "", max_cost: Number(maxCostRaw) }
    : null;
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
      wake_at: timedWake?.wake_at ?? null,
      wake_at_ms: timedWake?.wake_at_ms ?? null,
      quota_route: quotaRoute,
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
  executor_role: z.string().min(1),
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
  if (d.resume_card_id.trim().toLowerCase() !== waitTuple.card_id.trim().toLowerCase()) {
    return { ok: false, reason: "WRONG_CARD", got: d.resume_card_id, expected: waitTuple.card_id };
  }
  if (d.target.role !== waitTuple.executor_role) {
    return { ok: false, reason: "WRONG_EXECUTOR_ROLE", got: d.target.role, expected: waitTuple.executor_role };
  }
  if (d.decision_topic !== waitTuple.allowed_action_class) {
    return { ok: false, reason: "WRONG_DECISION_TOPIC", got: d.decision_topic, expected: waitTuple.allowed_action_class };
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
    physicalPromptBoundary: true,
    listAgents,
    prompt: async (target, text, { quotaRoutePolicy = null, beforePhysicalPrompt = null } = {}) => {
      const first = resolveExactHerdrTarget(target, await listAgents());
      if (!first.ok) throw new ResumeDeliveryError(first.reason);
      const second = resolveExactHerdrTarget(target, await listAgents());
      if (!second.ok) throw new ResumeDeliveryError("STALE_PHYSICAL_TARGET", { cause: second.reason });
      if (!samePhysicalTarget(first.target, second.target)) throw new ResumeDeliveryError("STALE_PHYSICAL_TARGET");
      if (quotaRoutePolicy) {
        const routeCheck = validateFreeRouteAgainstPhysicalTarget(quotaRoutePolicy, second.target);
        if (!routeCheck.ok) throw new ResumeDeliveryError(routeCheck.reason);
      }
      if (typeof beforePhysicalPrompt === "function") {
        let gate;
        try {
          gate = normalizeGateResult(await beforePhysicalPrompt({ target: second.target, text }));
        } catch (error) {
          throw Object.assign(new ResumeDeliveryError("CONTROL_REQUIRED_PHYSICAL_PROMPT_GATE_FAILED", { cause: error }), { physical_prompt_gate: true });
        }
        if (!gate.allow) {
          throw Object.assign(new ResumeDeliveryError(gate.reason ?? "CONTROL_REQUIRED_PHYSICAL_PROMPT_GATE_FAILED"), {
            physical_prompt_gate: true,
            physical_prompt_decision: gate.decision ?? CONTROL_REQUIRED,
          });
        }
      }
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

export function normalizeCurrentComments(value) {
  const comments = value && !Array.isArray(value) ? value.comments : null;
  const provenance = value && !Array.isArray(value) ? value.readback_provenance : null;
  const complete = value && !Array.isArray(value) && value.pagination_complete === true;
  const provenanceValid = Boolean(
    provenance
    && typeof provenance === "object"
    && !Array.isArray(provenance)
    && provenance.protocol === CURRENT_COMMENT_READBACK_PROTOCOL
    && provenance.source === "github"
    && provenance.method === "GET"
    && provenance.pagination === "complete"
    && provenance.readback === "exact_get"
    && typeof provenance.endpoint === "string"
    && provenance.endpoint.length > 0,
  );
  if (!Array.isArray(comments) || !complete || !provenanceValid) {
    throw new ResumeDeliveryError("GITHUB_COMMENTS_READBACK_AMBIGUOUS");
  }
  return comments;
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
  timedQuotaState = null,
  quotaRoutePolicy = null,
  consumerHostId = null,
  authorizedHostIds = [],
  persistDeliveryState = null,
  beforeSend = null,
  beforePhysicalSend = null,
}) {
  const tupleCheck = validateWaitTuple(waitTuple);
  if (!tupleCheck.ok) return { decision: "REJECTED", reason: "INVALID_WAIT_TUPLE", errors: tupleCheck.errors };
  const tuple = tupleCheck.waitTuple;
  const parsed = parseControlDecision(decisionBody);
  const matched = matchWaitToDecision(tuple, parsed);
  if (!matched.ok) return { decision: "REJECTED", reason: matched.reason, detail: matched };
  const logicalKey = buildLogicalEventKey(tuple, parsed);
  const timedStateBase = timedQuotaState ?? (parsed.decision.wake_at
    ? { state: "WAITING_FOR_WAKE", wake_at: parsed.decision.wake_at, wake_at_ms: parsed.decision.wake_at_ms, retry_count: 0, quota_route: parsed.decision.quota_route }
    : null);
  const activeTimedQuotaState = timedStateBase && consumerHostId && !timedStateBase.consumer_host_id
    ? { ...timedStateBase, consumer_host_id: consumerHostId }
    : timedStateBase;
  const activeQuotaRoutePolicy = quotaRoutePolicy;
  const localState = stateForLogicalKey(deliveryState, logicalKey);
  if (localState?.state === DELIVERED) return { decision: "NO_OP_DUPLICATE", logical_key: logicalKey, existing_state: DELIVERED };
  if (localState?.state === SEND_PENDING || localState?.state === UNCERTAIN_SEND) {
    return { decision: "NO_BLIND_RETRY", logical_key: logicalKey, reason: localState.state };
  }
  if (activeTimedQuotaState) {
    const rawNow = now();
    const nowMs = typeof rawNow === "number" ? rawNow : Date.parse(rawNow);
    const timed = evaluateTimedQuotaState(activeTimedQuotaState, { nowMs, hostId: consumerHostId, authorizedHostIds });
    if (timed.decision !== "SEND_ALLOWED") return { ...timed, logical_key: logicalKey };
    const policyCheck = validateFreeRoutePolicy(activeQuotaRoutePolicy);
    if (!policyCheck.ok) return { decision: CONTROL_REQUIRED, logical_key: logicalKey, reason: policyCheck.reason };
    if (parsed.decision.quota_route) {
      const decisionRouteCheck = validateFreeRoute(parsed.decision.quota_route, activeQuotaRoutePolicy);
      if (!decisionRouteCheck.ok) return { decision: CONTROL_REQUIRED, logical_key: logicalKey, reason: decisionRouteCheck.reason };
    }
    const targetRouteCheck = validateFreeRouteAgainstPhysicalTarget(activeQuotaRoutePolicy, tuple.target);
    if (!targetRouteCheck.ok) return { decision: CONTROL_REQUIRED, logical_key: logicalKey, reason: targetRouteCheck.reason };
  } else if (parsed.decision.quota_route) {
    const policyCheck = validateFreeRoutePolicy(activeQuotaRoutePolicy);
    if (!policyCheck.ok) return { decision: CONTROL_REQUIRED, logical_key: logicalKey, reason: policyCheck.reason };
    const decisionRouteCheck = validateFreeRoute(parsed.decision.quota_route, activeQuotaRoutePolicy);
    if (!decisionRouteCheck.ok) return { decision: CONTROL_REQUIRED, logical_key: logicalKey, reason: decisionRouteCheck.reason };
    const targetRouteCheck = validateFreeRouteAgainstPhysicalTarget(activeQuotaRoutePolicy, tuple.target);
    if (!targetRouteCheck.ok) return { decision: CONTROL_REQUIRED, logical_key: logicalKey, reason: targetRouteCheck.reason };
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

  let releasePhysicalSend = null;
  const physicalPromptBoundary = herdr?.physicalPromptBoundary === true;
  const beforePhysicalPrompt = beforePhysicalSend && physicalPromptBoundary
    ? async ({ target }) => {
        const physicalGate = normalizeGateResult(await beforePhysicalSend({
          logicalKey,
          waitTuple: tuple,
          decision: parsed.decision,
          target,
        }));
        if (physicalGate.allow) releasePhysicalSend = typeof physicalGate.release === "function" ? physicalGate.release : null;
        return physicalGate;
      }
    : null;
  if (beforePhysicalSend && !physicalPromptBoundary) {
    let physicalGate;
    try {
      physicalGate = normalizeGateResult(await beforePhysicalSend({ logicalKey, waitTuple: tuple, decision: parsed.decision }));
    } catch (error) {
      return { decision: CONTROL_REQUIRED, logical_key: logicalKey, reason: "CONTROL_REQUIRED_PHYSICAL_SEND_GATE_FAILED", error: String(error?.message ?? error) };
    }
    if (!physicalGate.allow) {
      return { decision: physicalGate.decision ?? CONTROL_REQUIRED, logical_key: logicalKey, reason: physicalGate.reason ?? CONTROL_REQUIRED };
    }
    releasePhysicalSend = typeof physicalGate.release === "function" ? physicalGate.release : null;
  }

  let evidence;
  try {
    const promptOptions = {
      quotaRoutePolicy: activeTimedQuotaState || parsed.decision.quota_route ? activeQuotaRoutePolicy : null,
    };
    if (beforePhysicalPrompt) promptOptions.beforePhysicalPrompt = beforePhysicalPrompt;
    evidence = await herdr.prompt(tuple.target, matched.pointer, promptOptions);
  } catch (error) {
    if (error?.physical_prompt_gate === true) {
      try { await releasePhysicalSend?.(); } catch (releaseError) {
        return { decision: CONTROL_REQUIRED, logical_key: logicalKey, reason: "CONTROL_REQUIRED_PHYSICAL_SEND_LEASE_UNREADABLE", error: String(releaseError?.message ?? releaseError) };
      }
      return {
        decision: error?.physical_prompt_decision ?? CONTROL_REQUIRED,
        logical_key: logicalKey,
        reason: error?.code ?? "CONTROL_REQUIRED_PHYSICAL_PROMPT_GATE_FAILED",
      };
    }
    const quotaFailure = error?.code === "PROVIDER_QUOTA" || error?.quota === true;
    if (activeTimedQuotaState && quotaFailure && error?.prompt_submitted === false) {
      try { await releasePhysicalSend?.(); } catch (releaseError) {
        return { decision: CONTROL_REQUIRED, logical_key: logicalKey, reason: "CONTROL_REQUIRED_PHYSICAL_SEND_LEASE_UNREADABLE", error: String(releaseError?.message ?? releaseError) };
      }
      const rawNow = now();
      const observedAtMs = typeof rawNow === "number" ? rawNow : Date.parse(rawNow);
      const quotaEvidence = parseAuthoritativeQuotaEvidence(error.quota_evidence, { routePolicy: activeQuotaRoutePolicy, observedAtMs });
      const scheduled = scheduleQuotaRetry(activeTimedQuotaState, quotaEvidence, { observedAtMs, routePolicy: activeQuotaRoutePolicy });
      if (!scheduled.ok) {
        const controlState = { ...activeTimedQuotaState, logical_event_key: logicalKey, state: CONTROL_REQUIRED, reason: scheduled.reason };
        try { if (persistDeliveryState) await persistDeliveryState(controlState); } catch { /* keep the no-prompt boundary */ }
        return { decision: CONTROL_REQUIRED, logical_key: logicalKey, reason: scheduled.reason };
      }
      const retryState = { ...scheduled.state, logical_event_key: logicalKey };
      try { if (persistDeliveryState) await persistDeliveryState(retryState); } catch (persistError) {
        return { decision: CONTROL_REQUIRED, logical_key: logicalKey, reason: "PERSISTED_IDEMPOTENCY_WRITE_FAILED", error: String(persistError?.message ?? persistError) };
      }
      return { decision: "RETRY_SCHEDULED", logical_key: logicalKey, state: retryState };
    }
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

export function validatePreSendAuthorityBinding(initial, latest) {
  if (!initial || !latest) return { ok: false, reason: "AUTHORITY_BINDING_MISSING" };
  const initialHead = initial.HEAD ?? initial.head;
  const latestHead = latest.HEAD ?? latest.head;
  const initialTree = initial.tree ?? initial.tree_sha ?? initial.TREE;
  const latestTree = latest.tree ?? latest.tree_sha ?? latest.TREE;
  const initialTarget = initial.target ?? {};
  const latestTarget = latest.target ?? {};
  const requiredTargetFields = ["agent_name", "executor_instance_id", "surface", "pane_id", "agent_session", "workspace_id", "cwd", "branch", "HEAD"];
  const hasText = (value) => typeof value === "string" && value.length > 0;
  if (!hasText(initial.card_id) || !hasText(latest.card_id) || !Number.isInteger(initial.control_generation) || initial.control_generation <= 0 || !Number.isInteger(latest.control_generation) || latest.control_generation <= 0 || !Number.isInteger(initial.source_control_generation) || initial.source_control_generation <= 0 || !Number.isInteger(latest.source_control_generation) || latest.source_control_generation <= 0 || !hasText(initialHead) || !hasText(latestHead) || !hasText(initialTree) || !hasText(latestTree) || requiredTargetFields.some((key) => !hasText(initialTarget[key]) || !hasText(latestTarget[key]))) {
    return { ok: false, reason: "AUTHORITY_BINDING_MISSING" };
  }
  if (initial.card_id !== latest.card_id) return { ok: false, reason: "AUTHORITY_CARD_CHANGED" };
  if (initial.control_generation !== latest.control_generation || initial.source_control_generation !== latest.source_control_generation) {
    return { ok: false, reason: "AUTHORITY_GENERATION_CHANGED" };
  }
  if (initialHead !== latestHead) return { ok: false, reason: "AUTHORITY_HEAD_CHANGED" };
  if (initialTree !== latestTree) return { ok: false, reason: "AUTHORITY_TREE_CHANGED" };
  if ((initial.branch ?? null) !== (latest.branch ?? null) || (initial.ref ?? null) !== (latest.ref ?? null)) {
    return { ok: false, reason: "AUTHORITY_REF_CHANGED" };
  }
  for (const key of ["agent_name", "executor_instance_id", "surface", "pane_id", "agent_session", "workspace_id", "cwd", "branch", "HEAD"]) {
    if ((initialTarget[key] ?? null) !== (latestTarget[key] ?? null)) return { ok: false, reason: "AUTHORITY_TARGET_CHANGED", field: key };
  }
  return { ok: true };
}

export function createResidentHerdrConsumer(config = {}) {
  return {
    async consumeOnce() {
      const consumer = classifyFutureConsumerBinding(config.futureConsumerBinding);
      if (!consumer.bound) return { decision: consumer.state, reason: consumer.state, delivered: false, duplicate: false };

      if (typeof config.readAuthority !== "function") return { decision: CONTROL_REQUIRED, reason: "CONTROL_REQUIRED_AUTHORITY_READER_MISSING", delivered: false, duplicate: false };
      if (typeof config.readComments !== "function") return { decision: CONTROL_REQUIRED, reason: "CONTROL_REQUIRED_COMMENTS_READER_MISSING", delivered: false, duplicate: false };
      let initialAuthority = null;
      let authority;
      let waitTuple;
      let decisionBody;
      let comments;
      try {
        initialAuthority = await config.readAuthority({ phase: "start" });
      } catch (error) {
        return { decision: CONTROL_REQUIRED, reason: "CONTROL_REQUIRED_AUTHORITY_READ_FAILED", error: String(error?.message ?? error), delivered: false, duplicate: false };
      }
      if (initialAuthority?.ok === false) return { decision: CONTROL_REQUIRED, reason: initialAuthority.reason ?? "CONTROL_REQUIRED_AUTHORITY_READ_FAILED", delivered: false, duplicate: false };
      authority = initialAuthority?.value ?? initialAuthority ?? {};
      waitTuple = authority.waitTuple ?? config.waitTuple;
      const initialBindingCheck = validatePreSendAuthorityBinding(authority.binding, authority.binding);
      if (!initialBindingCheck.ok) return { decision: CONTROL_REQUIRED, reason: initialBindingCheck.reason, delivered: false, duplicate: false };
      try {
        decisionBody = authority.decisionBody ?? (config.readDecisionBody ? await config.readDecisionBody({ waitTuple }) : config.decisionBody);
      } catch (error) {
        return { decision: CONTROL_REQUIRED, reason: "CONTROL_REQUIRED_DECISION_READ_FAILED", error: String(error?.message ?? error), delivered: false, duplicate: false };
      }
      try {
        comments = normalizeCurrentComments(await config.readComments({ waitTuple, phase: "initial" }));
      } catch (error) {
        const reason = error?.code === "GITHUB_COMMENTS_READBACK_AMBIGUOUS"
          ? "CONTROL_REQUIRED_COMMENTS_READBACK_AMBIGUOUS"
          : "CONTROL_REQUIRED_COMMENTS_READ_FAILED";
        return { decision: CONTROL_REQUIRED, reason, error: String(error?.message ?? error), delivered: false, duplicate: false };
      }
      const startingFingerprint = authorityFingerprint(authority.fingerprint ?? authority.binding ?? null);
      const deliveryState = config.readState ? await config.readState() : config.deliveryState ?? null;
      const timedQuotaState = config.timedQuotaState ?? (deliveryState?.wake_at ? deliveryState : null);

      const result = await deliverResumeOnce({
        waitTuple,
        decisionBody,
        comments,
        herdr: config.herdr,
        publishReceipt: config.publishReceipt,
        protocol: config.protocol,
        now: config.now,
        deliveryState,
        timedQuotaState,
        persistDeliveryState: config.writeState,
        quotaRoutePolicy: config.quotaRoutePolicy,
        consumerHostId: config.consumerHostId,
        authorizedHostIds: config.authorizedHostIds,
        beforeSend: async (details) => {
          try {
            const latestRaw = await config.readAuthority({ phase: "before_send", logicalKey: details.logicalKey });
            if (latestRaw?.ok === false) return { allow: false, decision: CONTROL_REQUIRED, reason: latestRaw.reason ?? "CONTROL_REQUIRED_AUTHORITY_REVALIDATION_FAILED" };
            const latest = latestRaw?.value ?? latestRaw ?? {};
            const bindingCheck = validatePreSendAuthorityBinding(authority.binding, latest.binding);
            if (!bindingCheck.ok) return { allow: false, decision: CONTROL_REQUIRED, reason: bindingCheck.reason };
            const latestFingerprint = authorityFingerprint(latest.fingerprint ?? latest.binding ?? null);
            if (startingFingerprint !== null && latestFingerprint !== startingFingerprint) {
              return { allow: false, decision: CONTROL_REQUIRED, reason: "AUTHORITY_CHANGED" };
            }
            const latestComments = normalizeCurrentComments(await config.readComments({ waitTuple: details.waitTuple, logicalKey: details.logicalKey, phase: "before_send" }));
            const duplicate = findExistingDelivery(latestComments, details.logicalKey, config.protocol);
            if (duplicate) return { allow: false, decision: "NO_OP_DUPLICATE", reason: "NO_OP_DUPLICATE" };
            return { allow: true };
          } catch (error) {
            const reason = error?.code === "GITHUB_COMMENTS_READBACK_AMBIGUOUS"
              ? "CONTROL_REQUIRED_COMMENTS_READBACK_AMBIGUOUS"
              : "CONTROL_REQUIRED_AUTHORITY_REVALIDATION_FAILED";
            return { allow: false, decision: CONTROL_REQUIRED, reason };
          }
        },
        beforePhysicalSend: async (details) => {
          try {
            const latestRaw = await config.readAuthority({ phase: "before_physical_send", logicalKey: details.logicalKey, target: details.target });
            if (latestRaw?.ok === false) return { allow: false, decision: CONTROL_REQUIRED, reason: latestRaw.reason ?? "CONTROL_REQUIRED_AUTHORITY_REVALIDATION_FAILED" };
            const latest = latestRaw?.value ?? latestRaw ?? {};
            const bindingCheck = validatePreSendAuthorityBinding(authority.binding, latest.binding);
            if (!bindingCheck.ok) return { allow: false, decision: CONTROL_REQUIRED, reason: bindingCheck.reason };
            const latestFingerprint = authorityFingerprint(latest.fingerprint ?? latest.binding ?? null);
            if (startingFingerprint !== null && latestFingerprint !== startingFingerprint) {
              return { allow: false, decision: CONTROL_REQUIRED, reason: "AUTHORITY_CHANGED" };
            }
            const latestComments = normalizeCurrentComments(await config.readComments({ waitTuple: details.waitTuple, logicalKey: details.logicalKey, phase: "before_physical_send" }));
            const duplicate = findExistingDelivery(latestComments, details.logicalKey, config.protocol);
            if (duplicate) return { allow: false, decision: "NO_OP_DUPLICATE", reason: "NO_OP_DUPLICATE" };
            const rawNow = typeof config.now === "function" ? config.now() : Date.now();
            const nowMs = typeof rawNow === "number" ? rawNow : Date.parse(rawNow);
            if (!Number.isFinite(nowMs)) return { allow: false, decision: CONTROL_REQUIRED, reason: "CONTROL_REQUIRED_PHYSICAL_SEND_TIME_UNREADABLE" };
            if (config.herdr?.physicalPromptBoundary === true && typeof config.claimPhysicalSend !== "function") {
              return { allow: false, decision: CONTROL_REQUIRED, reason: "CONTROL_REQUIRED_PHYSICAL_SEND_LEASE_BINDING_MISSING" };
            }
            if (typeof config.revalidateOwnership === "function") {
              const ownership = await config.revalidateOwnership({ ...details, nowMs });
              if (!ownership?.owned) return { allow: false, decision: CONTROL_REQUIRED, reason: ownership?.reason ?? "CONTROL_REQUIRED_LOCK_NOT_OWNED" };
            }
            if (typeof config.claimPhysicalSend === "function") {
              const claimRawNow = typeof config.now === "function" ? config.now() : Date.now();
              const claimNowMs = typeof claimRawNow === "number" ? claimRawNow : Date.parse(claimRawNow);
              if (!Number.isFinite(claimNowMs)) return { allow: false, decision: CONTROL_REQUIRED, reason: "CONTROL_REQUIRED_PHYSICAL_SEND_TIME_UNREADABLE" };
              const claim = await config.claimPhysicalSend({ ...details, nowMs: claimNowMs });
              if (claim?.allow === false) return claim;
              return { allow: true, release: claim?.release };
            }
            return { allow: true };
          } catch (error) {
            return { allow: false, decision: CONTROL_REQUIRED, reason: "CONTROL_REQUIRED_PHYSICAL_PROMPT_GATE_FAILED", error: String(error?.message ?? error) };
          }
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
  if (!raw) throw new ResumeDeliveryError("GITHUB_COMMENTS_READBACK_AMBIGUOUS");
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new ResumeDeliveryError("GITHUB_COMMENTS_READBACK_AMBIGUOUS");
    const comments = parsed.every((page) => Array.isArray(page))
      ? parsed.flat()
      : parsed.every((comment) => comment && typeof comment === "object")
        ? parsed
        : (() => { throw new ResumeDeliveryError("GITHUB_COMMENTS_READBACK_AMBIGUOUS"); })();
    if (comments.length === 0 || comments.some((comment) => !comment || typeof comment !== "object" || comment.message)) {
      throw new ResumeDeliveryError("GITHUB_COMMENTS_READBACK_AMBIGUOUS");
    }
    return comments;
  } catch (error) {
    if (error instanceof ResumeDeliveryError) throw error;
    const comments = [];
    for (const line of String(stdout).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsedLine = JSON.parse(line);
        if (!parsedLine || typeof parsedLine !== "object" || parsedLine.message) throw new Error("ambiguous");
        comments.push(parsedLine);
      } catch { throw new ResumeDeliveryError("GITHUB_COMMENTS_INVALID_JSON"); }
    }
    if (comments.length === 0) throw new ResumeDeliveryError("GITHUB_COMMENTS_READBACK_AMBIGUOUS");
    return comments;
  }
}

export function createGhReader({ gh = DEFAULT_GH, exec = defaultExec } = {}) {
  return {
    readDecisionBody: async ({ repo, receiptId }) => {
      const { stdout } = await exec(gh, ["api", `repos/${repo}/issues/comments/${receiptId}`, "--jq", ".body"]);
      const body = stdout.trim();
      if (!body) throw new ResumeDeliveryError("GITHUB_DECISION_READBACK_AMBIGUOUS");
      return body;
    },
    readComments: async ({ repo, issue }) => {
      const endpoint = `repos/${repo}/issues/${issue}/comments`;
      const { stdout } = await exec(gh, ["api", endpoint, "--paginate", "--slurp"]);
      return {
        comments: parseGhComments(stdout).map(({ id, created_at, body }) => ({ id, created_at, body })),
        pagination_complete: true,
        readback_provenance: {
          protocol: CURRENT_COMMENT_READBACK_PROTOCOL,
          source: "github",
          method: "GET",
          endpoint,
          pagination: "complete",
          readback: "exact_get",
        },
      };
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
