// GPT_BROWSER_BRIDGE - Herdr Control-resume delivery adapter (R1)
//
// Repair card: CONTROL-RESUME-DELIVERY-R1-01 (Issue #89)
//
// Repairs the earliest proven unattended-liveness failure edge:
//   WAIT_CONTROL_DECISION durable source terminal
//   -> exact newer GitHub CONTROL_DECISION_V1 binding that source
//   -> exactly one physical Herdr resume of the exact waiting executor
//   -> durable machine-readable delivery receipt (duplicate-safe)
//
// Boundaries (card #89):
// - GitHub is sole durable authority; any local state is reconstructed from
//   GitHub receipts and never silently overrides them.
// - This module NEVER infers BEST_NEXT, successor, repair scope, Reviewer
//   decision, merge/release, or product action. It only matches an exact
//   decision to an exact registered wait tuple and performs the physical
//   wake once.
// - No second authority DB, message bus, reasoning daemon, distributed lock,
//   or hidden scheduler is introduced here.
//
// Everything on the outside (GitHub `gh`, the Herdr CLI, the system clock) is
// injectable so the whole edge is testable without a live browser/session.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HERDR_RESUME_DELIVERY_PROTOCOL = "HERDR_RESUME_DELIVERY_V1";
export const CONTROL_DECISION_PROTOCOL = "CONTROL_DECISION_V1";

export const DEFAULT_GH = "gh";
export const DEFAULT_HERDR_EXE =
  "C:\\Users\\Lupun\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ResumeDeliveryError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "ResumeDeliveryError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Receipt-reference parsing ("D22977/gpt-browser-bridge Issue #43 receipt 5307312987")
// ---------------------------------------------------------------------------

export function parseReceiptRef(value) {
  if (typeof value !== "string") return null;
  const m = /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+Issue\s+#(\d+)\s+receipt\s+(\d+)/i.exec(value.trim());
  if (!m) return null;
  return { repo: m[1], issue: Number(m[2]), receipt_id: Number(m[3]) };
}

// ---------------------------------------------------------------------------
// Decision text parser (CONTROL_DECISION_V1 YAML-ish body -> structured object)
// ---------------------------------------------------------------------------

export function splitDecisionLines(body) {
  return String(body ?? "").split(/\r?\n/);
}

const SECTION_HEADER_RE = /^[A-Z][A-Z0-9 _-]{1,60}$/;

// Splits a CONTROL_DECISION_V1 body into protocol + key/value sections. A line
// without a ":" that is all-caps starts a new section (e.g. EXACT_TARGET).
// Everything before the first section header lives under "top". Paragraph
// prose (no colon, not all-caps) is ignored, never interpreted as a field.
export function parseDecisionSections(body) {
  const lines = splitDecisionLines(body);
  const firstContent = lines.find((l) => l.trim().length > 0 && !l.includes(":"))?.trim() ?? "";
  const sections = { top: {} };
  let current = "top";
  let seenProtocol = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.includes(":") && SECTION_HEADER_RE.test(line)) {
      if (!seenProtocol) {
        // The first content line is the protocol name, not a section header.
        seenProtocol = true;
        continue;
      }
      current = line;
      if (!sections[current]) sections[current] = {};
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!sections[current]) sections[current] = {};
    sections[current][key] = value;
  }
  return { protocol: firstContent, sections };
}

export function parseControlDecision(body) {
  const { protocol, sections } = parseDecisionSections(body);
  if (protocol !== CONTROL_DECISION_PROTOCOL) {
    return { ok: false, reason: "NOT_CONTROL_DECISION_V1", protocol };
  }
  const top = sections.top ?? {};
  const source = sections.SOURCE_BINDING ?? {};
  const target = sections.EXACT_TARGET ?? {};
  const generation = Number(top.control_generation);
  if (!Number.isInteger(generation) || generation <= 0) {
    return { ok: false, reason: "MISSING_CONTROL_GENERATION" };
  }
  const sourceRef = parseReceiptRef(source.source_terminal_receipt);
  const sourceGeneration = Number(source.source_control_generation ?? top.control_generation);
  if (!Number.isInteger(sourceGeneration) || sourceGeneration <= 0) {
    return { ok: false, reason: "MISSING_SOURCE_CONTROL_GENERATION" };
  }
  const resumeCardId = source.resume_card_id ?? source.resume_card ?? "";
  return {
    ok: true,
    decision: {
      state: top.state ?? "",
      control_generation: generation,
      decision_topic: top.decision_topic ?? "",
      source_terminal_receipt_id: sourceRef?.receipt_id ?? null,
      source_terminal_receipt_ref: source.source_terminal_receipt ?? "",
      source_control_generation: sourceGeneration,
      resume_card_id: String(resumeCardId),
      resume_card_ref: source.resume_card ?? "",
      target: {
        role: target.executor_role ?? "",
        agent_name: target.agent_name ?? "",
        executor_instance_id: target.executor_instance_id ?? "",
        surface: target.surface ?? "",
      },
      wake_action: target.wake_action ?? "",
      minimal_wake: target.minimal_wake ?? "",
    },
  };
}

// ---------------------------------------------------------------------------
// Registered wait tuple (the durable "who is waiting on what")
// ---------------------------------------------------------------------------

export const waitTupleSchema = z.object({
  source_terminal_receipt: z.number().int().positive(),
  control_generation: z.number().int().positive(),
  card_id: z.string().min(1),
  allowed_action_class: z.string().min(1),
  target: z.object({
    // logical executor identity (what the decision must name)
    agent_name: z.string().min(1),
    executor_instance_id: z.string().min(1),
    surface: z.string().min(1),
    // physical Herdr agent/pane name actually prompted (e.g. "w1")
    herdr_agent: z.string().min(1),
  }),
});

export function validateWaitTuple(value) {
  const parsed = waitTupleSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  return { ok: true, waitTuple: parsed.data };
}

// ---------------------------------------------------------------------------
// Exact-match logic (fail closed on every mismatch)
// ---------------------------------------------------------------------------

export function matchWaitToDecision(waitTuple, decision) {
  if (!decision?.ok) {
    return { ok: false, reason: decision?.reason ?? "INVALID_DECISION" };
  }
  const d = decision.decision;
  if (d.state !== "EXECUTE_NOW") {
    return { ok: false, reason: "DECISION_NOT_EXECUTE_NOW", state: d.state };
  }
  if (d.control_generation !== waitTuple.control_generation) {
    return {
      ok: false,
      reason: "WRONG_GENERATION",
      got: d.control_generation,
      expected: waitTuple.control_generation,
    };
  }
  if (d.source_terminal_receipt_id !== waitTuple.source_terminal_receipt) {
    return {
      ok: false,
      reason: "WRONG_SOURCE_TERMINAL",
      got: d.source_terminal_receipt_id,
      expected: waitTuple.source_terminal_receipt,
    };
  }
  if (d.source_control_generation !== waitTuple.control_generation) {
    return {
      ok: false,
      reason: "WRONG_SOURCE_GENERATION",
      got: d.source_control_generation,
      expected: waitTuple.control_generation,
    };
  }
  const decisionCard = d.resume_card_id.toLowerCase();
  if (!decisionCard || !decisionCard.includes(waitTuple.card_id.toLowerCase())) {
    return { ok: false, reason: "WRONG_CARD", got: d.resume_card_id, expected: waitTuple.card_id };
  }
  if (d.target.agent_name !== waitTuple.target.agent_name) {
    return {
      ok: false,
      reason: "WRONG_TARGET_AGENT",
      got: d.target.agent_name,
      expected: waitTuple.target.agent_name,
    };
  }
  if (d.target.executor_instance_id !== waitTuple.target.executor_instance_id) {
    return {
      ok: false,
      reason: "WRONG_TARGET_INSTANCE",
      got: d.target.executor_instance_id,
      expected: waitTuple.target.executor_instance_id,
    };
  }
  if (d.target.surface !== waitTuple.target.surface) {
    return {
      ok: false,
      reason: "WRONG_TARGET_SURFACE",
      got: d.target.surface,
      expected: waitTuple.target.surface,
    };
  }
  const pointer = (d.minimal_wake || d.wake_action || "").trim();
  if (pointer.length === 0) {
    return { ok: false, reason: "MISSING_WAKE_POINTER" };
  }
  return { ok: true, pointer, decision: d };
}

// ---------------------------------------------------------------------------
// Duplicate detection: one deterministic key per logical event
// ---------------------------------------------------------------------------

export function buildLogicalEventKey(waitTuple, decision) {
  const d = decision?.decision ?? {};
  return [
    String(waitTuple.source_terminal_receipt),
    String(waitTuple.control_generation),
    waitTuple.card_id,
    waitTuple.target.agent_name,
    waitTuple.target.executor_instance_id,
  ].join("|");
}

export function findExistingDelivery(comments, logicalKey, protocol = HERDR_RESUME_DELIVERY_PROTOCOL) {
  for (const comment of Array.isArray(comments) ? comments : []) {
    const body = String(comment?.body ?? "");
    if (!body.startsWith(protocol)) continue;
    const m = /logical_event_key:\s*(\S+)/.exec(body);
    if (m && m[1] === logicalKey) {
      return { receipt_id: comment?.id ?? null, created_at: comment?.created_at ?? null };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Injectable external boundaries (defaults use real gh / herdr CLIs)
// ---------------------------------------------------------------------------

function defaultExec(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(err.message), { cause: err, stderr }));
      else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export function createGhReader({ gh = DEFAULT_GH, exec = defaultExec } = {}) {
  return {
    // Fetches one issue comment by id and returns its body.
    readDecisionBody: async ({ repo, receiptId }) => {
      const { stdout } = await exec(gh, ["api", `repos/${repo}/issues/comments/${receiptId}`, "--jq", ".body"]);
      return stdout.trim();
    },
    // Fetches the full comment list (id/created_at/body) for an issue.
    readComments: async ({ repo, issue }) => {
      const { stdout } = await exec(gh, [
        "api",
        `repos/${repo}/issues/${issue}/comments`,
        "--paginate",
        "--jq",
        "[.[] | {id, created_at, body}]",
      ]);
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new ResumeDeliveryError("GITHUB_COMMENTS_INVALID_JSON");
      }
      return Array.isArray(parsed) ? parsed : [];
    },
    // Publishes a comment and returns its id.
    publishComment: async ({ repo, issue, body }) => {
      const file = `C:\\Users\\Lupun\\AppData\\Local\\Temp\\opencode\\herdr_resume_receipt_${Date.now()}.md`;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(file, body, "utf8");
      const { stdout } = await exec(gh, [
        "api",
        `repos/${repo}/issues/${issue}/comments`,
        "-f",
        `body=@${file}`,
        "--jq",
        ".id",
      ]);
      const id = Number(stdout.trim());
      if (!Number.isInteger(id) || id <= 0) throw new ResumeDeliveryError("GITHUB_PUBLISH_INVALID_ID");
      return { id };
    },
  };
}

export function createHerdrPrompter({ herdrExe = DEFAULT_HERDR_EXE, exec = defaultExec } = {}) {
  return {
    prompt: async (agent, text) => {
      await exec(herdrExe, ["agent", "prompt", agent, text]);
      return { accepted: true, agent, sent_at: new Date().toISOString() };
    },
  };
}

// ---------------------------------------------------------------------------
// One-shot delivery orchestration
// ---------------------------------------------------------------------------

// `deliverResumeOnce` performs the full bounded edge and returns one of:
//   { decision: "DELIVERED", logical_key, receipt_id, receipt }
//   { decision: "NO_OP_DUPLICATE", logical_key, existing_receipt_id }
//   { decision: "REJECTED", reason, ...detail }
// It never calls the Herdr prompt on REJECTED or NO_OP_DUPLICATE.
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
  if (!tupleCheck.ok) {
    return { decision: "REJECTED", reason: "INVALID_WAIT_TUPLE", errors: tupleCheck.errors };
  }
  const wt = tupleCheck.waitTuple;

  const parsed = parseControlDecision(decisionBody);
  const matched = matchWaitToDecision(wt, parsed);
  if (!matched.ok) {
    return { decision: "REJECTED", reason: matched.reason, detail: matched };
  }

  const logicalKey = buildLogicalEventKey(wt, parsed);
  const existing = findExistingDelivery(comments, logicalKey, protocol);
  if (existing) {
    return { decision: "NO_OP_DUPLICATE", logical_key: logicalKey, existing_receipt_id: existing.receipt_id };
  }

  const delivery = await herdr.prompt(wt.target.herdr_agent, matched.pointer);

  const receipt = {
    schema: HERDR_RESUME_DELIVERY_PROTOCOL,
    protocol,
    state: "TERMINAL",
    decision: "DELIVERED",
    source_terminal_receipt: wt.source_terminal_receipt,
    control_generation: wt.control_generation,
    card_id: wt.card_id,
    allowed_action_class: wt.allowed_action_class,
    target_agent_name: wt.target.agent_name,
    target_executor_instance_id: wt.target.executor_instance_id,
    target_surface: wt.target.surface,
    target_herdr_agent: wt.target.herdr_agent,
    delivery_count: 1,
    delivery_status: "DELIVERED",
    logical_event_key: logicalKey,
    delivered_at: now(),
    herdr_evidence: delivery ?? null,
    user_relay_count: 0,
  };
  const published = await publishReceipt(receipt);
  return {
    decision: "DELIVERED",
    logical_key: logicalKey,
    receipt_id: published?.id ?? null,
    receipt,
  };
}

// ---------------------------------------------------------------------------
// CLI entry for live verification / re-runs
// ---------------------------------------------------------------------------
//
// Usage:
//   node src/adapters/herdr_resume.mjs <waitTuple.json>
// waitTuple.json shape:
// {
//   "repo": "D22977/gpt-browser-bridge",
//   "issue": 43,
//   "decision_receipt_id": 5307397535,
//   "wait_tuple": {
//     "source_terminal_receipt": 5307312987,
//     "control_generation": 2,
//     "card_id": "HERDR-NATIVE-REGISTERED-WATCH-AI70-ADMISSION-01",
//     "allowed_action_class": "RUNTIME_ADMISSION_OPERATOR",
//     "target": {
//       "agent_name": "LUNA_CLI_HERDR_W1",
//       "executor_instance_id": "LUNA_CLI_HERDR_W1_01",
//       "surface": "CLI",
//       "herdr_agent": "w1"
//     }
//   }
// }
// Re-running with the same tuple returns NO_OP_DUPLICATE (duplicate-safe).

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new ResumeDeliveryError("USAGE: node src/adapters/herdr_resume.mjs <waitTuple.json>");
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const ghReader = createGhReader();
  const herdr = createHerdrPrompter();
  const decisionBody = await ghReader.readDecisionBody({
    repo: config.repo,
    receiptId: config.decision_receipt_id,
  });
  const comments = await ghReader.readComments({ repo: config.repo, issue: config.issue });
  const result = await deliverResumeOnce({
    waitTuple: config.wait_tuple,
    decisionBody,
    comments,
    herdr,
    publishReceipt: async (receipt) => {
      const body = Object.entries(receipt)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      return ghReader.publishComment({ repo: config.repo, issue: config.issue, body });
    },
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.decision === "REJECTED") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  });
}
