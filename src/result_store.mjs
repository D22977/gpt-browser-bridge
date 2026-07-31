// GPT_BROWSER_BRIDGE - Durable output store (GBB-003)
// Single place that turns a Watcher decision into the on-disk terminal record.
// Spec: plans/GBB_PARENT_WORK_ORDER.md §14 "Durable output" / "Result states".
//
// Strict order (never reorder):
//   write reply.md atomically -> calculate reply hash -> write result.json
//   atomically -> emit stdout event.
// Only the presence of result.json on disk means the job reached a terminal
// state. Uses the existing write-file-atomic dependency (no new package).

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { resultSchema, resultStateEnum } from "./contracts.mjs";

export function sha256Hex(input) {
  return createHash("sha256").update(input ?? "", "utf8").digest("hex");
}

// Confines job output to <runtimeRoot>/jobs/<job_id>/, rejecting traversal or
// escape. Spec: docs/SECURITY.md §4 "output_dir 必須驗證並限制於 runtime root".
export function resolveJobDir(runtimeRoot, jobId) {
  if (typeof jobId !== "string" || jobId.length === 0 || /[\\/]/.test(jobId) || jobId.includes("..")) {
    throw new Error(`resolveJobDir: unsafe job_id ${JSON.stringify(jobId)}`);
  }
  const root = path.resolve(runtimeRoot);
  const dir = path.resolve(root, "jobs", jobId);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error(`resolveJobDir: resolved path escapes runtime root: ${dir}`);
  }
  return dir;
}

// Writes reply.md + result.json for a terminal (or partial-on-timeout) Watcher
// outcome, in the strict order required by §14. `state` must be one of
// DONE / NEEDS_DECISION / FAILED (resultStateEnum). Returns the parsed,
// schema-validated result object plus the paths written.
export async function persistResult({
  jobDir,
  job,
  state,
  replyText,
  startedAt,
  completedAt,
  error,
  detections,
}) {
  if (!resultStateEnum.options.includes(state)) {
    throw new Error(`persistResult: invalid result state ${JSON.stringify(state)}`);
  }
  if (!job || typeof job.job_id !== "string") {
    throw new Error("persistResult: job (with job_id) is required");
  }

  await mkdir(jobDir, { recursive: true });

  // 1) write reply.md atomically.
  const replyPath = path.join(jobDir, "reply.md");
  const text = replyText ?? "";
  await writeFileAtomic(replyPath, text);

  // 2) calculate reply hash (recomputable from the file that now exists on disk).
  const replyHash = sha256Hex(text);

  // 3) write result.json atomically.
  const result = resultSchema.parse({
    schema_version: job.schema_version,
    job_id: job.job_id,
    state,
    reply_path: replyPath,
    reply_hash: replyHash,
    baseline: job.baseline,
    started_at: startedAt,
    completed_at: completedAt,
    ...(error ? { error } : {}),
    ...(detections && detections.length > 0 ? { detections } : {}),
  });
  const resultPath = path.join(jobDir, "result.json");
  await writeFileAtomic(resultPath, JSON.stringify(result, null, 2) + "\n");

  // 4) emit stdout event (ORCA / supervisor tail this stream; never before
  //    result.json exists, so a consumer that sees the event can trust the
  //    file is already durable).
  const event = {
    type: "gbb_watch_result",
    job_id: result.job_id,
    state: result.state,
    reply_hash: result.reply_hash,
    reply_path: replyPath,
    result_path: resultPath,
    at: completedAt,
  };
  process.stdout.write(JSON.stringify(event) + "\n");

  return { result, replyPath, resultPath };
}
