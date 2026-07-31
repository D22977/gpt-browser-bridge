// GPT_BROWSER_BRIDGE - Durable output store tests (GBB-003)
// node:test only. Uses a temp directory outside the repo/runtime tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex, resolveJobDir, persistResult } from "../src/result_store.mjs";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sampleJob(overrides = {}) {
  return {
    schema_version: 1,
    job_id: "550e8400-e29b-41d4-a716-446655440000",
    baseline: { assistant_count: 5, last_assistant_hash: sha256("Answer 5") },
    ...overrides,
  };
}

test("sha256Hex is deterministic and matches node:crypto directly", () => {
  assert.equal(sha256Hex("final reply text"), sha256("final reply text"));
  assert.equal(sha256Hex(""), sha256(""));
});

test("resolveJobDir confines output under <runtimeRoot>/jobs/<job_id> and rejects traversal", () => {
  const dir = resolveJobDir("D:\\AIWORK_RUNTIME\\GPT_BROWSER_BRIDGE", "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(dir, path.resolve("D:\\AIWORK_RUNTIME\\GPT_BROWSER_BRIDGE", "jobs", "550e8400-e29b-41d4-a716-446655440000"));
  assert.throws(() => resolveJobDir("D:\\RUNTIME", "../escape"));
  assert.throws(() => resolveJobDir("D:\\RUNTIME", "a/b"));
  assert.throws(() => resolveJobDir("D:\\RUNTIME", ""));
});

test("persistResult writes reply.md then a schema-valid result.json, and the reply hash is recomputable from the file on disk", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb003-result-"));
  const job = sampleJob();
  const jobDir = resolveJobDir(runtimeRoot, job.job_id);
  const replyText = "The review is complete.\n<!-- GBB:END -->\n";

  const { result, replyPath, resultPath } = await persistResult({
    jobDir,
    job,
    state: "DONE",
    replyText,
    startedAt: "2026-08-01T09:00:00+08:00",
    completedAt: "2026-08-01T09:05:00+08:00",
  });

  const replyOnDisk = await readFile(replyPath, "utf8");
  assert.equal(replyOnDisk, replyText);
  assert.equal(result.reply_hash, sha256(replyOnDisk), "reply_hash must be recomputable from reply.md");

  const resultOnDisk = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(resultOnDisk.job_id, job.job_id);
  assert.equal(resultOnDisk.state, "DONE");
  assert.equal(resultOnDisk.reply_hash, result.reply_hash);
  assert.equal(resultOnDisk.reply_path, replyPath);

  // Presence of result.json on disk is the sole terminal-state signal.
  await assert.doesNotReject(() => stat(resultPath));
});

test("persistResult accepts all three result states", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb003-result-"));
  for (const state of ["DONE", "NEEDS_DECISION", "FAILED"]) {
    const job = sampleJob({ job_id: `550e8400-e29b-41d4-a716-4466554400${state === "DONE" ? "01" : state === "NEEDS_DECISION" ? "02" : "03"}` });
    const jobDir = resolveJobDir(runtimeRoot, job.job_id);
    const { result } = await persistResult({
      jobDir,
      job,
      state,
      replyText: "partial or final text",
      startedAt: "2026-08-01T09:00:00+08:00",
      completedAt: "2026-08-01T09:05:00+08:00",
      detections: state === "DONE" ? [] : ["network_error"],
    });
    assert.equal(result.state, state);
  }
});

test("persistResult rejects an invalid result state", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb003-result-"));
  const job = sampleJob();
  const jobDir = resolveJobDir(runtimeRoot, job.job_id);
  await assert.rejects(
    () =>
      persistResult({
        jobDir,
        job,
        state: "PARTIAL",
        replyText: "x",
        startedAt: "2026-08-01T09:00:00+08:00",
        completedAt: "2026-08-01T09:05:00+08:00",
      }),
    /invalid result state/
  );
});

test("persistResult omits detections/error when not provided, includes them when present", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb003-result-"));
  const job = sampleJob();
  const jobDir = resolveJobDir(runtimeRoot, job.job_id);

  const clean = await persistResult({
    jobDir,
    job,
    state: "DONE",
    replyText: "ok",
    startedAt: "2026-08-01T09:00:00+08:00",
    completedAt: "2026-08-01T09:05:00+08:00",
  });
  assert.equal("detections" in clean.result, false);
  assert.equal("error" in clean.result, false);

  const job2 = sampleJob({ job_id: "550e8400-e29b-41d4-a716-446655440099" });
  const jobDir2 = resolveJobDir(runtimeRoot, job2.job_id);
  const withIssues = await persistResult({
    jobDir: jobDir2,
    job: job2,
    state: "FAILED",
    replyText: "",
    startedAt: "2026-08-01T09:00:00+08:00",
    completedAt: "2026-08-01T09:05:00+08:00",
    error: "cdp_unreachable",
    detections: ["cdp_unreachable"],
  });
  assert.equal(withIssues.result.error, "cdp_unreachable");
  assert.deepEqual(withIssues.result.detections, ["cdp_unreachable"]);
});

test("persistResult emits a single stdout event only after both files are written", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb003-result-"));
  const job = sampleJob();
  const jobDir = resolveJobDir(runtimeRoot, job.job_id);

  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    await persistResult({
      jobDir,
      job,
      state: "DONE",
      replyText: "ok",
      startedAt: "2026-08-01T09:00:00+08:00",
      completedAt: "2026-08-01T09:05:00+08:00",
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(chunks.length, 1);
  const event = JSON.parse(chunks[0]);
  assert.equal(event.type, "gbb_watch_result");
  assert.equal(event.job_id, job.job_id);
  assert.equal(event.state, "DONE");
});
