// GPT_BROWSER_BRIDGE - Zod contracts (GBB-001)
// Single source of truth for the durable JSON shapes:
//   job.json, result.json, project_state.json, agent reports.
// See plans/GBB_PARENT_WORK_ORDER.md §10, §14 and docs/ARCHITECTURE.md.

import { z } from "zod";

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// job.json  (written once by the Sender; immutable afterwards)
// ---------------------------------------------------------------------------
// Spec: parent work order §14 "Sender 必做" / §7.4.
// Conversation path shapes accepted (GBB-URL-001): the legacy direct form
// "/c/<uuid-ish>" and the GPT-project form "/g/<project-id>/c/<uuid-ish>"
// (e.g. https://chatgpt.com/g/g-p-.../c/<uuid>). The project-id segment is
// opaque (real project slugs vary in shape) but is restricted to a
// conservative charset and cannot contain "/", so it cannot smuggle extra
// path segments past this check. Capture group 1 always yields the
// conversation id itself, shared with tab conversation-ID matching in
// gpt_send.mjs so both stay in lockstep.
const CONVERSATION_PATH_RE = /^\/(?:g\/[0-9a-zA-Z._-]+\/)?c\/([0-9a-f-]+)$/i;

// Extracts the conversation id from a ChatGPT conversation URL (either the
// legacy "/c/<id>" or GPT-project "/g/<project-id>/c/<id>" form), lower-cased.
// Returns null for anything that fails to parse as a URL or does not match
// one of those two path shapes.
export function extractConversationId(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const m = CONVERSATION_PATH_RE.exec(parsed.pathname);
  return m ? m[1].toLowerCase() : null;
}

// Fail-closed conversation URL check (P1-2 rework): the hostname must be
// exactly "chatgpt.com"; subdomains, look-alike hostnames, userinfo, explicit
// ports (including default ports such as :443/:80), non-https schemes and
// paths that are not one of the two conversation-path shapes above are all
// rejected. Query/hash are tolerated (URL parsing separates them from
// hostname/path).
// Note: WHATWG URL normalization drops explicit default ports, so the check
// for explicit ports must inspect the RAW value's authority, not parsed.port.
export function isChatgptConversationUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "chatgpt.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    extractConversationId(value) === null
  ) {
    return false;
  }
  // Raw-string authority check: `https://chatgpt.com:443/c/...` parses with
  // parsed.port === "" because 443 is https's default port, so reject any
  // ":" immediately after the hostname in the raw value (covers :443, :80,
  // :8443 and every explicit port). Case-insensitive hostname tolerated.
  return /^https:\/\/chatgpt\.com(?!:)/i.test(value);
}

export const jobSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  job_id: z.uuid(),
  prompt: z.string().min(1),
  prompt_hash: z.string().regex(/^[0-9a-f]{64}$/),
  attempt: z.number().int().positive(),
  conversation_url: z.string().url().refine(isChatgptConversationUrl, {
    message: "conversation_url must be a ChatGPT conversation URL",
  }),
  sent_at: z.string().datetime({ offset: true }),
  baseline: z.object({
    assistant_count: z.number().int().nonnegative(),
    last_assistant_hash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

// ---------------------------------------------------------------------------
// result.json  (terminal state; presence = job finished)
// ---------------------------------------------------------------------------
// Spec: parent work order §14 "Result states" / "Durable output".
export const resultStateEnum = z.enum(["DONE", "NEEDS_DECISION", "FAILED"]);

// Watcher detection codes (GBB-003 §14 "偵測" list) plus two technical-failure
// codes emitted by the CLI wrapper's Gate D/H invalidation-retry handling.
export const detectionCodeEnum = z.enum([
  "continue_button",
  "network_error",
  "login_wall",
  "odd_code_fence",
  "missing_end_marker",
  "abrupt_tail",
  "baseline_invalid",
  "max_retries_exceeded",
  "cdp_unreachable",
]);

export const resultSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  job_id: z.uuid(),
  state: resultStateEnum,
  reply_path: z.string().min(1),
  reply_hash: z.string().regex(/^[0-9a-f]{64}$/),
  baseline: z.object({
    assistant_count: z.number().int().nonnegative(),
    last_assistant_hash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  started_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }),
  error: z.string().optional(),
  detections: z.array(detectionCodeEnum).optional(),
});

// ---------------------------------------------------------------------------
// project_state.json  (single source of truth for project progress)
// ---------------------------------------------------------------------------
// Spec: parent work order §10.
export const projectStateEnum = z.enum([
  "INITIALIZING",
  "RUNNING",
  "WAITING_WORKER",
  "WAITING_REVIEWER",
  "WAITING_BROWSER",
  "REWORK",
  "NEEDS_HUMAN",
  "COMPLETED",
  "CANCELLED",
]);

export const terminalRefSchema = z.object({
  role: z.enum(["worker", "reviewer", "control", "watcher", "sender"]),
  handle: z.string().min(1),
  title: z.string().min(1),
});

export const projectStateSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  project_id: z.string().min(1),
  state: projectStateEnum,
  current_task: z.string().min(1),
  current_phase: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  base_commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  active_run_id: z.string().min(1),
  active_terminal: terminalRefSchema.nullable(),
  last_checkpoint: z.string().datetime({ offset: true }),
  last_successful_step: z.string().min(1),
  next_action: z.string().min(1),
  retry_count: z.number().int().nonnegative(),
  blocked_reason: z.string().nullable(),
  updated_at: z.string().datetime({ offset: true }),
}).superRefine((s, ctx) => {
  // Fail closed: NEEDS_HUMAN must carry a concrete, non-empty reason.
  if (s.state === "NEEDS_HUMAN" && !s.blocked_reason?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blocked_reason"],
      message: "blocked_reason must be non-empty when state is NEEDS_HUMAN",
    });
  }
});

// ---------------------------------------------------------------------------
// Agent reports (worker_report.md / reviewer_report.md front matter)
// ---------------------------------------------------------------------------
// Spec: parent work order §7.2 outputs and worker report format in DISPATCH.md.
export const agentRoleEnum = z.enum(["worker", "reviewer", "control", "sender", "watcher", "supervisor"]);

export const workerReportSchema = z.object({
  run_id: z.string().min(1),
  worker: z.string().min(1),
  base_commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  completed_at: z.string().datetime({ offset: true }),
  task_id: z.string().min(1),
  commits: z.array(z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/), message: z.string().min(1) })),
  changed_files: z.array(z.string().min(1)),
  acceptance_gates: z.array(z.string().min(1)),
  blockers: z.array(z.string()),
  role: z.literal("worker"),
});

export const reviewerReportSchema = z.object({
  run_id: z.string().min(1),
  reviewer: z.string().min(1),
  base_commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  completed_at: z.string().datetime({ offset: true }),
  task_id: z.string().min(1),
  conclusion: z.enum(["通過", "退修", "受阻"]),
  findings: z.array(z.string()),
  role: z.literal("reviewer"),
});

// Generic agent report union (used by adapters when persisting run artifacts).
export const agentReportSchema = z.discriminatedUnion("role", [workerReportSchema, reviewerReportSchema]);

// ---------------------------------------------------------------------------
// Execution Registry / Admission model (non-authoritative over Supervisor)
// ---------------------------------------------------------------------------
// Fixed admission limits. Do not auto-scale from visible process counts.
export const MAX_WORKERS = 2;
export const MAX_REVIEWERS = 1;
export const MAX_WRITERS_PER_REF = 1;

// Exact full 40-hex SHA-1 (commit head / tree).
const EXACT_40_HEX = /^[0-9a-f]{40}$/;

// Canonical git ref: must start with refs/ or be a bare SHA; reject ambiguous forms.
const CANONICAL_REF = /^(refs\/[^\s]+|[0-9a-f]{40})$/;

// Process identity: stable binding to a specific OS process.
export const processIdentitySchema = z.object({
  pid: z.number().int().positive(),
  started_at: z.string().datetime({ offset: true }),
});

// Registry entry lifecycle states.
export const registryEntryStateEnum = z.enum([
  "ADMITTED",      // entry validated and admitted, not yet confirmed active
  "ACTIVE",        // entry confirmed alive (heartbeat within threshold)
  "HEARTBEAT_STALE",  // heartbeat exceeded staleness threshold, candidate for revalidation
  "MARK_STALE_CANDIDATE", // supervisor has marked as stale candidate
  "REVALIDATING",  // liveness revalidation in progress (no side effects)
  "RELEASED",      // slot released, entry no longer counted against limits
]);

// Allowed state transitions for the stale handling state machine.
// OBSERVE -> MARK_STALE_CANDIDATE -> REVALIDATE is the only stale path;
// direct RELEASE from a non-terminal state is forbidden.
export const ALLOWED_TRANSITIONS = {
  ADMITTED:             ["ACTIVE", "HEARTBEAT_STALE", "RELEASED"],
  ACTIVE:               ["HEARTBEAT_STALE", "RELEASED"],
  HEARTBEAT_STALE:      ["MARK_STALE_CANDIDATE", "REVALIDATING"],
  MARK_STALE_CANDIDATE: ["REVALIDATING", "HEARTBEAT_STALE"],
  REVALIDATING:         ["ACTIVE", "MARK_STALE_CANDIDATE", "HEARTBEAT_STALE", "RELEASED"],
  RELEASED:             [],
};

// A single execution registry entry binding task/card id, generation, role,
// exact ref/head/tree, allowlist identity, worktree, process identity,
// session/pane identity, lease/fence, heartbeat, and state.
// F3: session is required for workers (at least one identity member);
// lease_expiry is required; process.started_at is mandatory.
export const registryEntrySchema = z.object({
  card_id: z.string().min(1),
  generation: z.number().int().positive(),
  role: z.enum(["worker", "reviewer"]),
  ref: z.string().regex(CANONICAL_REF),
  head: z.string().regex(EXACT_40_HEX),
  tree: z.string().regex(EXACT_40_HEX),
  allowlist_paths: z.array(z.string().min(1)).min(1),
  worktree: z.string().min(1),
  process: processIdentitySchema,
  session: z.object({
    workspace_id: z.string().min(1),
    pane_id: z.string().min(1),
    agent_session: z.string().min(1),
  }),
  lease_id: z.string().min(1),
  lease_expiry: z.string().datetime({ offset: true }),
  fence: z.number().int().positive(),
  fence_id: z.string().min(1),
  heartbeat_at: z.string().datetime({ offset: true }),
  state: registryEntryStateEnum,
  admitted_at: z.string().datetime({ offset: true }),
});

// ---------------------------------------------------------------------------
// F005: Terminal / revocation evidence: typed, identity-bound release authority.
// A bare boolean { terminal_authority: true } or { revocation_authority: true }
// must fail. The evidence must embed the complete ownership tuple and exactly
// match the entry being released.
// ---------------------------------------------------------------------------

const baseOwnershipFields = {
  pid: z.number().int().positive(),
  fence: z.number().int().positive(),
  fence_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_expiry: z.string().datetime({ offset: true }),
  generation: z.number().int().positive(),
  ref: z.string().regex(CANONICAL_REF),
  head: z.string().regex(EXACT_40_HEX),
  tree: z.string().regex(EXACT_40_HEX),
  worktree: z.string().min(1),
  process: processIdentitySchema,
  session: z.object({
    workspace_id: z.string().min(1),
    pane_id: z.string().min(1),
    agent_session: z.string().min(1),
  }),
};

export const terminalEvidenceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("terminal_authority"), ...baseOwnershipFields }),
  z.object({ type: z.literal("revocation_authority"), ...baseOwnershipFields }),
]);

// ---------------------------------------------------------------------------
// Current authority tuple: exact identity binding for admission/heartbeat/state
// mutation. Covers generation, ref, head, tree, worktree, process, session,
// lease, and fence. Admission/heartbeat/state mutation must validate that the
// exact tuple matches, not only card_id.
// ---------------------------------------------------------------------------
export const currentAuthoritySchema = z.object({
  generation: z.number().int().positive(),
  ref: z.string().regex(CANONICAL_REF),
  head: z.string().regex(EXACT_40_HEX),
  tree: z.string().regex(EXACT_40_HEX),
  worktree: z.string().min(1),
  process: processIdentitySchema,
  session: z.object({
    workspace_id: z.string().min(1),
    pane_id: z.string().min(1),
    agent_session: z.string().min(1),
  }),
  lease_id: z.string().min(1),
  lease_expiry: z.string().datetime({ offset: true }),
  fence: z.number().int().positive(),
  fence_id: z.string().min(1),
});

// Supervisor-owned post-lock identity snapshot. The source binding is kept
// separate from the durable candidate so a caller cannot satisfy both sides
// with a caller-provided reader.
export const supervisorIdentitySourceSchema = z.object({
  source: z.literal("SUPERVISOR_OWNED"),
  authority: currentAuthoritySchema,
  binding: z.object({
    pid: z.number().int().positive(),
    host_id: z.string().min(1),
    fence: z.number().int().positive(),
    fence_id: z.string().min(1),
  }),
});
