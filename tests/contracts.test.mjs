// GPT_BROWSER_BRIDGE - contract tests (GBB-001)
// node:test only. No third-party test framework.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SCHEMA_VERSION,
  jobSchema,
  resultSchema,
  projectStateSchema,
  workerReportSchema,
  reviewerReportSchema,
  agentReportSchema,
  isChatgptConversationUrl,
  extractConversationId,
} from "../src/contracts.mjs";

const uuid = "550e8400-e29b-41d4-a716-446655440000";
const sha64 = "a".repeat(64);
const sha7 = "a".repeat(7);
const ts = "2026-07-31T23:10:00+08:00";

function validJob(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    job_id: uuid,
    prompt: "review pack T2",
    prompt_hash: sha64,
    attempt: 1,
    conversation_url: `https://chatgpt.com/c/${uuid}`,
    sent_at: ts,
    baseline: { assistant_count: 3, last_assistant_hash: sha64 },
    ...overrides,
  };
}

function validResult(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    job_id: uuid,
    state: "DONE",
    reply_path: "D:\\AIWORK_RUNTIME\\GPT_BROWSER_BRIDGE\\jobs\\j1\\reply.md",
    reply_hash: sha64,
    baseline: { assistant_count: 3, last_assistant_hash: sha64 },
    started_at: ts,
    completed_at: "2026-07-31T23:20:00+08:00",
    ...overrides,
  };
}

function validProjectState(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: "GBB-PKG-01",
    state: "RUNNING",
    current_task: "GBB-001",
    current_phase: "BOOTSTRAP",
    attempt: 1,
    base_commit: sha7,
    active_run_id: "GBB-001-A1",
    active_terminal: { role: "worker", handle: "term_1", title: "GBB-001-A1-worker" },
    last_checkpoint: ts,
    last_successful_step: "CONTRACTS_CREATED",
    next_action: "CREATE_SKILLS",
    retry_count: 0,
    blocked_reason: null,
    updated_at: ts,
    ...overrides,
  };
}

function extractPowerShellBlock(source, condition) {
  const conditionStart = source.indexOf(`if (${condition})`);
  assert.notEqual(conditionStart, -1, `missing PowerShell decision branch for ${condition}`);
  const openBrace = source.indexOf("{", conditionStart);
  assert.notEqual(openBrace, -1, `missing PowerShell block for ${condition}`);

  let depth = 0;
  let quote = null;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) {
        if (source[index + 1] === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace + 1, index);
      }
    }
  }
  assert.fail(`unterminated PowerShell block for ${condition}`);
}

function topLevelPowerShellKeywords(block) {
  let depth = 0;
  let quote = null;
  const keywords = [];
  for (let index = 0; index < block.length; index += 1) {
    const character = block[index];
    if (quote) {
      if (character === "`" && quote === '"') {
        index += 1;
        continue;
      }
      if (character === quote) {
        if (block[index + 1] === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#") {
      while (index < block.length && block[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(character)) {
      const token = block.slice(index).match(/^[A-Za-z_][A-Za-z0-9_-]*/)[0];
      keywords.push(token.toLowerCase());
      index += token.length - 1;
    }
  }
  return keywords;
}

function hasTopLevelPowerShellThrow(block) {
  const keywords = topLevelPowerShellKeywords(block);
  const throwIndex = keywords.indexOf("throw");
  const exitIndex = keywords.findIndex((keyword) =>
    ["return", "exit", "break", "continue"].includes(keyword)
  );
  return throwIndex !== -1 && (exitIndex === -1 || exitIndex > throwIndex);
}

function assertDirectPowerShellThrow(source, condition) {
  const block = extractPowerShellBlock(source, condition);
  assert.ok(
    hasTopLevelPowerShellThrow(block),
    `${condition} must contain a direct terminating throw`
  );
}

function assertWorkerServicePattern(patternSource, positiveIdentities, negativeIdentity) {
  const caseInsensitive = patternSource.startsWith("(?i)");
  const expression = caseInsensitive ? patternSource.slice(4) : patternSource;
  const pattern = new RegExp(expression, caseInsensitive ? "i" : undefined);
  for (const identity of positiveIdentities) {
    assert.ok(pattern.test(identity), `pattern must match canonical Worker identity ${identity}`);
  }
  assert.equal(
    pattern.test(negativeIdentity),
    false,
    "pattern must reject a non-Worker control service identity"
  );
}

test("job.json schema accepts a valid job", () => {
  const parsed = jobSchema.parse(validJob());
  assert.equal(parsed.job_id, uuid);
});

test("job.json rejects a non-ChatGPT conversation URL", () => {
  assert.throws(() => jobSchema.parse(validJob({ conversation_url: "https://example.com/x" })), /conversation_url/);
});

test("job.json accepts a conversation URL with query/hash tolerance", () => {
  const parsed = jobSchema.parse(
    validJob({ conversation_url: `https://chatgpt.com/c/${uuid}?utm_source=x#top` })
  );
  assert.equal(parsed.conversation_url, `https://chatgpt.com/c/${uuid}?utm_source=x#top`);
});

test("job.json rejects look-alike hostnames", () => {
  for (const bad of [
    `https://evilchatgpt.com/c/${uuid}`,
    `https://chatgpt.com.evil.com/c/${uuid}`,
    `https://evil.chatgpt.com/c/${uuid}`,
  ]) {
    assert.throws(() => jobSchema.parse(validJob({ conversation_url: bad })), /conversation_url/);
  }
});

test("job.json rejects a conversation URL without scheme", () => {
  assert.throws(() => jobSchema.parse(validJob({ conversation_url: `chatgpt.com/c/${uuid}` })), /conversation_url/);
});

test("job.json rejects a conversation URL with userinfo", () => {
  assert.throws(() => jobSchema.parse(validJob({ conversation_url: `https://user@chatgpt.com/c/${uuid}` })), /conversation_url/);
});

test("job.json rejects http scheme, explicit port and non-/c/ paths", () => {
  for (const bad of [
    `http://chatgpt.com/c/${uuid}`,
    `https://chatgpt.com:8443/c/${uuid}`,
    `https://chatgpt.com/foo/${uuid}`,
    `https://chatgpt.com/c/${uuid}/extra`,
    `https://chatgpt.com/c/not-a-valid-id!`,
  ]) {
    assert.throws(() => jobSchema.parse(validJob({ conversation_url: bad })), /conversation_url/);
  }
});

test("job.json rejects explicit default ports (443/80) and other ports", () => {
  for (const bad of [
    `https://chatgpt.com:443/c/${uuid}`,
    `https://chatgpt.com:80/c/${uuid}`,
    `https://chatgpt.com:8443/c/${uuid}`,
  ]) {
    assert.throws(() => jobSchema.parse(validJob({ conversation_url: bad })), /conversation_url/);
  }
});

// ---------------------------------------------------------------------------
// GBB-URL-001: GPT-project conversation URLs (/g/<project-id>/c/<uuid-ish>)
// must be accepted alongside the legacy /c/<uuid-ish> form, with every other
// gate (host, scheme, port, credentials, UUID-shape) unchanged.
// ---------------------------------------------------------------------------

test("job.json accepts a GPT-project conversation URL (/g/<project-id>/c/<id>)", () => {
  const parsed = jobSchema.parse(
    validJob({ conversation_url: `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}` })
  );
  assert.equal(parsed.conversation_url, `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`);
});

test("job.json accepts a GPT-project conversation URL with query/hash tolerance", () => {
  const parsed = jobSchema.parse(
    validJob({ conversation_url: `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}?utm_source=x#top` })
  );
  assert.equal(parsed.conversation_url, `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}?utm_source=x#top`);
});

test("job.json rejects a GPT-project URL missing the /c/<id> suffix", () => {
  for (const bad of [
    `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot`,
    `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/`,
    `https://chatgpt.com/g//c/${uuid}`,
    `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/x/${uuid}`,
  ]) {
    assert.throws(() => jobSchema.parse(validJob({ conversation_url: bad })), /conversation_url/);
  }
});

test("job.json rejects a GPT-project URL with a malformed conversation id", () => {
  assert.throws(
    () => jobSchema.parse(validJob({ conversation_url: `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/not-a-valid-id!` })),
    /conversation_url/
  );
});

test("job.json still rejects look-alike hostnames, explicit ports and non-https on the GPT-project form", () => {
  for (const bad of [
    `https://evilchatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`,
    `https://chatgpt.com:8443/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`,
    `http://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`,
    `https://user@chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`,
  ]) {
    assert.throws(() => jobSchema.parse(validJob({ conversation_url: bad })), /conversation_url/);
  }
});

test("extractConversationId returns the same id for both the legacy and GPT-project URL forms", () => {
  const legacy = `https://chatgpt.com/c/${uuid}`;
  const project = `https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid.toUpperCase()}`;
  assert.equal(extractConversationId(legacy), uuid);
  assert.equal(extractConversationId(project), uuid);
});

test("extractConversationId returns null for non-conversation paths and unparseable URLs", () => {
  assert.equal(extractConversationId(`https://chatgpt.com/`), null);
  assert.equal(extractConversationId(`https://chatgpt.com/g/g-p-x`), null);
  assert.equal(extractConversationId("not a url"), null);
});

test("isChatgptConversationUrl accepts both forms directly", () => {
  assert.equal(isChatgptConversationUrl(`https://chatgpt.com/c/${uuid}`), true);
  assert.equal(isChatgptConversationUrl(`https://chatgpt.com/g/g-p-680e34d1c2b4-review-bot/c/${uuid}`), true);
});

test("job.json rejects a bad prompt hash", () => {
  assert.throws(() => jobSchema.parse(validJob({ prompt_hash: "not-a-hash" })), /prompt_hash/);
});

test("job.json rejects a missing baseline", () => {
  assert.throws(() => jobSchema.parse(validJob({ baseline: undefined })), /baseline/);
});

test("result.json accepts DONE / NEEDS_DECISION / FAILED", () => {
  for (const state of ["DONE", "NEEDS_DECISION", "FAILED"]) {
    assert.equal(resultSchema.parse(validResult({ state })).state, state);
  }
});

test("result.json rejects an invalid state", () => {
  assert.throws(() => resultSchema.parse(validResult({ state: "PARTIAL" })), /state/);
});

test("result.json requires reply_hash", () => {
  assert.throws(() => resultSchema.parse(validResult({ reply_hash: "zzz" })), /reply_hash/);
});

test("project_state.json accepts a RUNNING state", () => {
  const parsed = projectStateSchema.parse(validProjectState());
  assert.equal(parsed.current_task, "GBB-001");
});

test("project_state.json accepts all legal states", () => {
  for (const state of [
    "INITIALIZING",
    "RUNNING",
    "WAITING_WORKER",
    "WAITING_REVIEWER",
    "WAITING_BROWSER",
    "REWORK",
    "NEEDS_HUMAN",
    "COMPLETED",
    "CANCELLED",
  ]) {
    const overrides =
      state === "NEEDS_HUMAN" ? { state, blocked_reason: "AUTH_REQUIRED" } : { state };
    assert.equal(projectStateSchema.parse(validProjectState(overrides)).state, state);
  }
});

test("project_state.json rejects an illegal state", () => {
  assert.throws(() => projectStateSchema.parse(validProjectState({ state: "RUNNING_FAST" })), /state/);
});

test("project_state.json rejects NEEDS_HUMAN with an empty blocked_reason", () => {
  const st = validProjectState({ state: "NEEDS_HUMAN", blocked_reason: "" });
  assert.throws(() => projectStateSchema.parse(st), /blocked_reason/);
});

test("worker report schema accepts a valid report", () => {
  const report = {
    run_id: "GBB-001-A1",
    worker: "deepseek-v4-flash-free",
    base_commit: sha7,
    completed_at: ts,
    task_id: "GBB-001",
    commits: [{ sha: sha7, message: "GBB-001 bootstrap" }],
    changed_files: ["README.md", "src/contracts.mjs"],
    acceptance_gates: ["contracts test passes"],
    blockers: [],
    role: "worker",
  };
  const parsed = workerReportSchema.parse(report);
  assert.equal(parsed.run_id, "GBB-001-A1");
});

test("worker report rejects a worker report claiming reviewer role", () => {
  const report = {
    run_id: "GBB-001-A1",
    worker: "deepseek-v4-flash-free",
    base_commit: sha7,
    completed_at: ts,
    task_id: "GBB-001",
    commits: [],
    changed_files: [],
    acceptance_gates: [],
    blockers: [],
    role: "reviewer",
  };
  assert.throws(() => workerReportSchema.parse(report), /role/);
});

test("reviewer report schema accepts only 通過 / 退修 / 受阻", () => {
  const base = {
    run_id: "GBB-001-A1",
    reviewer: "fresh-context",
    base_commit: sha7,
    completed_at: ts,
    task_id: "GBB-001",
    findings: [],
    role: "reviewer",
  };
  for (const conclusion of ["通過", "退修", "受阻"]) {
    assert.equal(reviewerReportSchema.parse({ ...base, conclusion }).conclusion, conclusion);
  }
  assert.throws(() => reviewerReportSchema.parse({ ...base, conclusion: "PASS" }), /conclusion/);
});

test("agentReportSchema discriminates on role", () => {
  const worker = {
    run_id: "GBB-001-A1",
    worker: "w",
    base_commit: sha7,
    completed_at: ts,
    task_id: "GBB-001",
    commits: [],
    changed_files: [],
    acceptance_gates: [],
    blockers: [],
    role: "worker",
  };
  const reviewer = {
    run_id: "GBB-001-A1",
    reviewer: "r",
    base_commit: sha7,
    completed_at: ts,
    task_id: "GBB-001",
    conclusion: "通過",
    findings: [],
    role: "reviewer",
  };
  assert.equal(agentReportSchema.parse(worker).role, "worker");
  assert.equal(agentReportSchema.parse(reviewer).role, "reviewer");
});

test("Reviewer canary workflow is a static, read-only, fail-closed runner contract", async () => {
  const source = await readFile(
    new URL("../.github/workflows/reviewer-runner-canary.yml", import.meta.url),
    "utf8"
  );

  assert.match(source, /^name:\s+GBB Reviewer Runner Canary$/m);
  assert.match(source, /^\s+workflow_dispatch:\s*$/m);
  assert.doesNotMatch(source, /^\s+(push|pull_request|workflow_call):/m);
  assert.match(source, /runs-on:\s*\[self-hosted,\s*Windows,\s*GBB-REVIEWER\]/);
  assert.match(source, /timeout-minutes:\s*10\b/);
  assert.match(source, /permissions:\s*\n\s+contents:\s+read/);
  assert.match(source, /shell:\s+pwsh\s+-NoProfile\s+-File\s+\{0\}/);
  assert.doesNotMatch(source, /^\s+shell:\s+pwsh\s*$/m);
  assert.match(source, /RUNNER_NAME/);
  assert.match(source, /gbb-reviewer-win-01/);
  assert.match(source, /whoami/);
  assert.match(source, /UserInteractive/);
  assert.match(source, /SessionId/);
  assert.match(source, /GBBWorker/);
  assert.doesNotMatch(source, /actions\/checkout|uses:\s+/);
  assert.doesNotMatch(source, /(^|[\s`])(?:git|gh)\s+(?:add|commit|push|fetch|checkout|api)\b/i);
  assert.doesNotMatch(source, /(?:Start-Process|&\s*)(?:opencode|chrome|msedge|node)\b/i);
  assert.doesNotMatch(source, /secrets\.|GITHUB_TOKEN/);
});

test("Reviewer canary proves ancestry by walking parents upward with a distinct ancestor set", async () => {
  const source = await readFile(
    new URL("../.github/workflows/reviewer-runner-canary.yml", import.meta.url),
    "utf8"
  );

  const ancestorStart = source.indexOf("$ancestorIds");
  const forbiddenStart = source.indexOf("$forbiddenAncestorProcesses");
  assert.notEqual(ancestorStart, -1, "workflow must define an explicit ancestor set");
  assert.notEqual(forbiddenStart, -1, "workflow must name forbidden ancestor evidence");
  assert.ok(ancestorStart < forbiddenStart, "ancestor evidence must be built before it is evaluated");

  const ancestorBlock = source.slice(ancestorStart, forbiddenStart);
  assert.match(ancestorBlock, /HashSet\[int\]/, "cycle guard must be independent state");
  assert.match(ancestorBlock, /\$parentId\s*=\s*\[int\]\$currentProcess\.ParentProcessId/);
  assert.match(ancestorBlock, /while\s*\(\$parentId\s*-ne\s*0\)/);
  assert.match(ancestorBlock, /\$parentProcess\s*=\s*\$processById\[\$parentId\]/);
  assert.match(
    ancestorBlock,
    /if\s*\(-not\s*\$parentProcess\)\s*\{\s*throw\b/s,
    "an unresolved parent must fail closed"
  );
  assert.match(
    ancestorBlock,
    /if\s*\(-not\s*\$cycleGuard\.Add\(\$parentId\)\)\s*\{\s*throw\b/s,
    "an ancestry cycle must fail closed"
  );
  assert.match(
    ancestorBlock,
    /if\s*\(-not\s*\$ancestorIds\.Add\(\$parentId\)\)\s*\{\s*throw\b/s,
    "duplicate ancestry state must fail closed"
  );
  assert.doesNotMatch(
    ancestorBlock,
    /if\s*\([^\n]+\)\s*\{\s*break\s*\}/s,
    "only reaching PID 0 may terminate ancestry traversal successfully"
  );
  assert.match(ancestorBlock, /\$parentId\s*=\s*\[int\]\$parentProcess\.ParentProcessId/);
  assert.match(
    ancestorBlock,
    /\$ancestorProcesses\s*=\s*@\(\$processes\s*\|\s*Where-Object\s*\{\s*\$ancestorIds\.Contains\(\[int\]\$_.ProcessId\)/
  );
  assert.doesNotMatch(ancestorBlock, /Where-Object\s+ParentProcessId\s+-eq/);
  assert.doesNotMatch(source, /Where-Object\s+ParentProcessId\s+-eq\s+\$parentId/);
  assert.doesNotMatch(source, /\$relatedIds|\$relatedProcesses|\$pending/);
});

test("Reviewer canary applies Worker services and forbidden process checks to ancestors and emits separate evidence", async () => {
  const source = await readFile(
    new URL("../.github/workflows/reviewer-runner-canary.yml", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /\$ancestorServices\s*=\s*@\(Get-CimInstance\s+Win32_Service\s*\|\s*Where-Object\s*\{\s*\$_.ProcessId\s+-in\s+@\(\$ancestorProcesses\.ProcessId\)/
  );
  const workerServiceStart = source.indexOf("$workerAncestorServices");
  const evidenceStart = source.indexOf("Write-Output \"reviewer_canary_ancestry:");
  assert.notEqual(workerServiceStart, -1, "workflow must classify ancestor services");
  assert.ok(workerServiceStart < evidenceStart, "service classification must precede evidence");
  const workerServiceBlock = source.slice(workerServiceStart, evidenceStart);
  const workerIdentityPattern = /gbb-worker|gbbworker/i;
  for (const field of ["Name", "DisplayName", "StartName", "PathName"]) {
    const fieldPredicate = workerServiceBlock.match(
      new RegExp(`\\$_\\.${field}\\s+-match\\s+'([^']+)'`, "i")
    );
    assert.ok(fieldPredicate, `Worker service classification must inspect ${field}`);
    assert.match(
      fieldPredicate[1],
      workerIdentityPattern,
      `${field} must match the Worker identity pattern`
    );
  }
  const forbiddenStart = source.indexOf("$forbiddenAncestorProcesses");
  const servicesStart = source.indexOf("$ancestorServices");
  const forbiddenBlock = source.slice(forbiddenStart, servicesStart);
  assert.match(
    forbiddenBlock,
    /@\(\$ancestorProcesses\s*\|\s*Where-Object/,
    "forbidden process checks must remain ancestor-only"
  );
  const namePredicate = forbiddenBlock.match(/\$_.Name\s+-match\s+'([^']+)'/i);
  assert.ok(namePredicate, "forbidden process identity must inspect Name");
  assert.match(namePredicate[1], /orca/i, "ORCA must be rejected by Name independently");
  assert.match(forbiddenBlock, /\$_.CommandLine\s+-match/i, "CommandLine remains an additional signal");
  const forbiddenDecisionStart = source.indexOf("if ($forbiddenAncestorProcesses.Count -gt 0)");
  assert.notEqual(forbiddenDecisionStart, -1, "forbidden ancestor detection must have a decision branch");
  const forbiddenDecisionBlock = source.slice(forbiddenDecisionStart, servicesStart);
  assert.match(
    forbiddenDecisionBlock,
    /\bthrow\b/,
    "forbidden ancestor detection must terminate with throw"
  );
  const workerDecisionStart = source.indexOf("if ($workerAncestorServices.Count -gt 0)");
  assert.notEqual(workerDecisionStart, -1, "Worker ancestor service detection must have a decision branch");
  const workerDecisionBlock = source.slice(workerDecisionStart, evidenceStart);
  assert.match(
    workerDecisionBlock,
    /\bthrow\b/,
    "Worker ancestor service detection must terminate with throw"
  );
  assert.match(source, /ancestor_count=\$\(\$ancestorProcesses\.Count\)/);
  assert.match(source, /worker_ancestor_service_count=\$\(\$workerAncestorServices\.Count\)/);
  assert.match(source, /forbidden_ancestor_count=\$\(\$forbiddenAncestorProcesses\.Count\)/);
  assert.doesNotMatch(source, /reviewer_canary_process_tree:.*ancestor/);
});

test("Reviewer canary contract binds each positive ancestor count to a direct terminating throw", async () => {
  const source = await readFile(
    new URL("../.github/workflows/reviewer-runner-canary.yml", import.meta.url),
    "utf8"
  );

  for (const condition of [
    "$forbiddenAncestorProcesses.Count -gt 0",
    "$workerAncestorServices.Count -gt 0",
  ]) {
    assertDirectPowerShellThrow(source, condition);
  }

  const unreachableThrow = `if ($forbiddenAncestorProcesses.Count -gt 0) {
  $details = @()
  if ($false) {
    throw "unreachable"
  }
}`;
  assert.throws(
    () => assertDirectPowerShellThrow(unreachableThrow, "$forbiddenAncestorProcesses.Count -gt 0"),
    /direct terminating throw/
  );

  const unrelatedThrow = `if ($workerAncestorServices.Count -gt 0) {
  $details = @()
}
throw "unrelated"`;
  assert.throws(
    () => assertDirectPowerShellThrow(unrelatedThrow, "$workerAncestorServices.Count -gt 0"),
    /direct terminating throw/
  );

  for (const condition of [
    "$forbiddenAncestorProcesses.Count -gt 0",
    "$workerAncestorServices.Count -gt 0",
  ]) {
    const returnBeforeThrow = `if (${condition}) {
  return
  throw "unreachable"
}`;
    assert.throws(
      () => assertDirectPowerShellThrow(returnBeforeThrow, condition),
      /direct terminating throw/
    );

    const commentOnlyThrow = `if (${condition}) {
  # throw "comment-only"
}`;
    assert.throws(
      () => assertDirectPowerShellThrow(commentOnlyThrow, condition),
      /direct terminating throw/
    );
  }
});

test("Reviewer canary contract validates Worker service predicates by behavior", async () => {
  const source = await readFile(
    new URL("../.github/workflows/reviewer-runner-canary.yml", import.meta.url),
    "utf8"
  );
  const serviceStart = source.indexOf("$workerAncestorServices");
  const evidenceStart = source.indexOf("Write-Output \"reviewer_canary_ancestry:");
  const serviceBlock = source.slice(serviceStart, evidenceStart);
  const expectedIdentities = {
    Name: ["GBBWorker", "gbb-worker"],
    DisplayName: ["GBBWorker", "gbb-worker"],
    StartName: ["GBBWorker"],
    PathName: ["GBBWorker", "gbb-worker"],
  };

  for (const [field, identities] of Object.entries(expectedIdentities)) {
    const predicate = serviceBlock.match(
      new RegExp(`\\$_\\.${field}\\s+-match\\s+'([^']+)'`, "i")
    );
    assert.ok(predicate, `Worker service classification must inspect ${field}`);
    assertWorkerServicePattern(predicate[1], identities, "ControlService");
    assert.throws(
      () => assertWorkerServicePattern("(?i)GBBWorkerX", identities, "ControlService"),
      /canonical Worker identity/
    );
  }
});
