// GPT_BROWSER_BRIDGE - Morning summary (GBB-004)
// Spec: plans/GBB_PARENT_WORK_ORDER.md §19, skills/recovery-supervisor/SKILL.md.
//
// Two-layer design so both halves are independently testable:
//   renderMorningSummary(data)   - pure markdown builder, no I/O.
//   gatherMorningSummaryData()   - best-effort reads of runtime files.
//   writeMorningSummary()        - atomic write of the rendered markdown.
//
// Never fabricates a status it cannot read: missing/unreadable inputs render
// as "unknown", not a guess.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";

const RESUME_COMMAND = "pwsh D:\\AIWORK\\GPT_BROWSER_BRIDGE\\scripts\\resume.ps1";

async function tryReadJson(readFileFn, filePath) {
  try {
    return JSON.parse(await readFileFn(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function tryReadText(readFileFn, filePath) {
  try {
    return await readFileFn(filePath, "utf8");
  } catch {
    return null;
  }
}

// Best-effort front-matter conclusion line (`conclusion: 通過|退修|受阻`) out
// of a reviewer_report.md without needing a full markdown parser.
function extractReviewerConclusion(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/conclusion:\s*(通過|退修|受阻)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Pure renderer
// ---------------------------------------------------------------------------

export function renderMorningSummary(data) {
  const d = {
    generatedAt: "unknown",
    projectState: "UNKNOWN",
    currentTask: "UNKNOWN",
    currentAttempt: "UNKNOWN",
    lastCheckpoint: "none",
    activeProcesses: "unknown",
    latestCommit: "none",
    tests: "unknown",
    reviewerStatus: "unknown",
    browserStatus: "unknown",
    orcaStatus: "unknown",
    completedOvernight: [],
    inProgress: [],
    automaticRecoveries: [],
    blockers: [],
    humanActionsRequired: [],
    filesToInspect: [],
    ...data,
  };

  const section = (title, items) => {
    const body = items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "- none";
    return `## ${title}\n\n${body}\n`;
  };

  const humanActions =
    d.humanActionsRequired.length > 0
      ? d.humanActionsRequired
      : d.projectState === "NEEDS_HUMAN"
        ? ["yes - see Blockers"]
        : [];

  return [
    "# GPT Browser Bridge Morning Summary",
    "",
    `- generated_at: ${d.generatedAt}`,
    `- project_state: ${d.projectState}`,
    `- current_task: ${d.currentTask}`,
    `- current_attempt: ${d.currentAttempt}`,
    `- last_successful_checkpoint: ${d.lastCheckpoint}`,
    `- active_processes: ${d.activeProcesses}`,
    `- latest_commit: ${d.latestCommit}`,
    `- tests: ${d.tests}`,
    `- reviewer_status: ${d.reviewerStatus}`,
    `- browser_status: ${d.browserStatus}`,
    `- ORCA_status: ${d.orcaStatus}`,
    "",
    section("Completed overnight", d.completedOvernight),
    "",
    section("In progress", d.inProgress),
    "",
    section("Automatic recoveries performed", d.automaticRecoveries),
    "",
    section("Blockers", d.blockers),
    "",
    section("Human actions required", humanActions),
    "",
    "## Exact resume command",
    "",
    `\`${RESUME_COMMAND}\``,
    "",
    section("Files to inspect", d.filesToInspect),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Best-effort data gathering
// ---------------------------------------------------------------------------

export async function gatherMorningSummaryData(paths, opts = {}) {
  const {
    readFileFn = readFile,
    readdirFn = readdir,
    nowIso,
    projectState,
    orca,
    pid,
    automaticRecoveries = [],
    blockers = [],
    humanActionsRequired = [],
  } = opts;

  const state = projectState ?? null;

  let latestRunId = null;
  let tests = "unknown";
  let reviewerStatus = "unknown";
  try {
    const runDirs = await readdirFn(paths.runsDir);
    // Runtime dir names sort lexicographically newest-last for our
    // <TASK>-A<N> convention closely enough for a best-effort pick; exact
    // ordering doesn't matter because a missing/ambiguous latest run only
    // degrades this to "unknown", never a wrong terminal-state claim.
    latestRunId = runDirs.sort().at(-1) ?? null;
    if (latestRunId) {
      const runDir = path.join(paths.runsDir, latestRunId);
      const testReport = await tryReadJson(readFileFn, path.join(runDir, "test_report.json"));
      if (testReport) {
        tests = testReport.pass === false || testReport.failed > 0 ? "FAILING" : "passing";
      }
      const reviewerReport = await tryReadText(readFileFn, path.join(runDir, "reviewer_report.md"));
      const conclusion = extractReviewerConclusion(reviewerReport ?? "");
      if (conclusion) reviewerStatus = conclusion;
    }
  } catch {
    // runsDir missing entirely (e.g. brand-new runtime) - leave as unknown.
  }

  let browserStatus = "unknown";
  try {
    const jobDirs = await readdirFn(paths.jobsDir);
    const latestJobId = jobDirs.sort().at(-1) ?? null;
    if (latestJobId) {
      const result = await tryReadJson(readFileFn, path.join(paths.jobsDir, latestJobId, "result.json"));
      if (result) browserStatus = result.state;
    }
  } catch {
    // jobsDir missing entirely - leave as unknown.
  }

  const orcaStatus = orca ? `${orca.state ?? "unknown"} (${orca.ok ? "ok" : "unreachable"})` : "unknown";

  return {
    generatedAt: nowIso,
    projectState: state?.state ?? "UNKNOWN",
    currentTask: state?.current_task ?? "UNKNOWN",
    currentAttempt: state?.attempt ?? "UNKNOWN",
    lastCheckpoint: state?.last_successful_step ?? "none",
    activeProcesses: `supervisor(pid=${pid ?? "unknown"})`,
    latestCommit: state?.base_commit ?? "none",
    tests,
    reviewerStatus,
    browserStatus,
    orcaStatus,
    automaticRecoveries,
    blockers: state?.blocked_reason ? [state.blocked_reason, ...blockers] : blockers,
    humanActionsRequired,
    filesToInspect: [
      "state\\project_state.json",
      "events\\events.ndjson",
      latestRunId ? `runs\\${latestRunId}\\` : null,
    ].filter(Boolean),
  };
}

export async function writeMorningSummary(paths, data, opts = {}) {
  const { writeFileFn = writeFileAtomic } = opts;
  const markdown = renderMorningSummary(data);
  await writeFileFn(paths.summary, markdown);
  return markdown;
}
