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
// Fail-closed conversation URL check (P1-2 rework): the hostname must be
// exactly "chatgpt.com"; subdomains, look-alike hostnames, userinfo, explicit
// ports, non-https schemes and non-"/c/<uuid-ish>" paths are all rejected.
// Query/hash are tolerated (URL parsing separates them from hostname/path).
export function isChatgptConversationUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "chatgpt.com" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    /^\/c\/[0-9a-f-]+$/i.test(parsed.pathname)
  );
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
  detections: z.array(z.string()).optional(),
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
