// GPT_BROWSER_BRIDGE - Sender / baseline tests (GBB-003)
// node:test only. No third-party test framework, no live browser: the
// Playwright CLI's `exec` transport is always injected with a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, mkdir as mkdirAsync, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  computePromptHash,
  readBaselineFromSnapshot,
  generateJobId,
  buildJob,
  resolveJobDir,
  writeJobFile,
  waitConversationUrl,
  locateChatgptTab,
  sendJob,
  SendInvalidationError,
  parseTabList,
  runCliCommand,
  sendPrompt,
  readBaseline,
  assertPageVisible,
  validateAttachments,
  ALLOWED_CLI_SUBCOMMANDS,
  SEND_BUTTON_SELECTOR,
  resolveSpawnTarget,
} from "../src/gpt_send.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures", "chatgpt");

// Execute the production PowerShell functions, extracted without executing the
// workflow entrypoint. All I/O in these fixtures is disposable or injected.
const BOOTSTRAP = "g11-issue124-repair02-fresh-worker-bootstrap-once.yml";
const RETURN_BRIDGE = "herdr-control-comment-bridge.yml";
async function workflowText(name) {
  return readFile(path.join(__dirname, "../.github/workflows", name), "utf8");
}
async function runRepairFunctions(name, script) {
  const text = await workflowText(name);
  const fragment = text.match(/# BEGIN REPAIR03 FUNCTIONS\r?\n([\s\S]*?)\s*# END REPAIR03 FUNCTIONS/);
  assert.ok(fragment, `${name}: executable repair functions present`);
  const source = fragment[1].split(/\r?\n/).map(line => line.replace(/^          /, "")).join("\n");
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-r03-test-"));
  const file = path.join(dir, "fixture.ps1");
  await writeFile(file, `$ErrorActionPreference = 'Stop'\n${source}\n${script}`, "utf8");
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", file], { encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("Repair03 T01/T03: consumed prompt plus approval block is typed even without start receipt", async () => {
  const result = await runRepairFunctions(BOOTSTRAP, `
    Get-GuardDecision -AgentStatus blocked -PromptCount 1 -Consumed $false -Terminal '' -Expired $false -Readback 'Would you like to run: Get-Content skills/worker/SKILL.md' | ConvertTo-Json -Compress
  `);
  assert.equal(result.state, "CONTROL_REQUIRED_BLOCKED_APPROVAL");
  assert.equal(result.prompt_consumption, "PROMPT_CONSUMED");
  assert.match(result.capability, /Get-Content skills\/worker\/SKILL.md/);
});

test("Repair03 T03/T08/T09: exit, timeout, unknown and late READY preserve exact lifecycle", async () => {
  const result = await runRepairFunctions(BOOTSTRAP, `
    @(
      (Get-GuardDecision exited 1 $false '' $false ''),
      (Get-GuardDecision working 1 $true '' $true ''),
      (Get-GuardDecision unknown 1 $false '' $false ''),
      (Get-GuardDecision blocked 1 $true 'READY_FOR_FRESH_REVIEW' $true 'approval'),
      (Get-GuardDecision idle 1 $false '' $false '')
    ) | ConvertTo-Json -Compress
  `);
  assert.equal(result[0].state, "CONTROL_REQUIRED_AGENT_EXITED");
  assert.equal(result[1].state, "CONTROL_REQUIRED_WORKER_TIMEOUT");
  assert.equal(result[2].state, "CONTROL_REQUIRED_AGENT_UNKNOWN");
  assert.equal(result[3].state, "WORKER_TERMINAL_OBSERVED");
  assert.equal(result[3].cleanup, "PARKED_FOR_BOUNDED_REPAIR");
  assert.equal(result[4].state, "WAIT");
});

test("Repair03 T06: exclusive claim blocks duplicate dispatch and restart SENDING/SENT", async () => {
  const result = await runRepairFunctions(RETURN_BRIDGE, `
    $file = Join-Path $PSScriptRoot 'claim.json'
    $first = Claim-Delivery $file '124|card|wake|head|011' 'SENDING'
    $second = Claim-Delivery $file '124|card|wake|head|011' 'SENDING'
    @{status='SENT'; binding='124|card|wake|head|011'} | ConvertTo-Json | Set-Content $file
    $third = Claim-Delivery $file '124|card|wake|head|011' 'SENDING'
    [pscustomobject]@{first=$first; second=$second; third=$third} | ConvertTo-Json -Compress
  `);
  assert.equal(result.first, "CLAIMED");
  assert.equal(result.second, "CONTROL_REQUIRED_RECONCILE_NO_BLIND_RETRY");
  assert.equal(result.third, "NO_OP_DUPLICATE");
});

test("Repair03 T05/T09: internal admission binds exact bot terminal, head and current target", async () => {
  const result = await runRepairFunctions(RETURN_BRIDGE, `
    $request = @{source_issue='124'; source_card_id='GBB-HERDR-SUBMIT-FRESH-COORDINATOR-REPAIR-02-G11'; source_terminal_receipt='901'; source_head=('a'*40); source_bootstrap_wake='900'; target_control_generation='011'; target_control_conversation_id='6a9d4f5b-ba9c-83ee-9694-44f99ea7515e'; target_control_conversation_url='https://chatgpt.com/c/6a9d4f5b-ba9c-83ee-9694-44f99ea7515e'; idempotency_key='GBB124-900-RETURN'}
    $terminal = @{id=901; issue_url='https://api.github.com/repos/D22977/gpt-browser-bridge/issues/124'; user=@{login='github-actions[bot]'}; body=("REPAIR02_FRESH_WORKER_BOOTSTRAP_RESULT_V1\nstate: WORKER_TERMINAL_OBSERVED\nsource_head: "+('a'*40)+"\nsource_card_id: GBB-HERDR-SUBMIT-FRESH-COORDINATOR-REPAIR-02-G11\nsource_bootstrap_wake: 900\nworkflow_run_id: 123\nreadback_verified: true")}
    $active = @{generation='011'; id=$request.target_control_conversation_id; url=$request.target_control_conversation_url}
    $good = Test-ReturnBinding $request $terminal $active $true
    $request.source_head = 'b'*40
    $head = Test-ReturnBinding $request $terminal $active $true
    $request.source_head = 'a'*40
    $active.generation = '012'
    $drift = Test-ReturnBinding $request $terminal $active $true
    $active.generation = '011'
    $terminal.user.login = 'intruder'
    $actor = Test-ReturnBinding $request $terminal $active $true
    @($good,$head,$drift,$actor) | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, ["VALID", "STALE_SOURCE_HEAD", "STALE_ACTIVE_CONTROL", "INVALID_TERMINAL_ACTOR"]);
});

test("Repair03 T07: ACK alone cannot satisfy reread and bounded next-action binding", async () => {
  const result = await runRepairFunctions(RETURN_BRIDGE, `
    $head = 'a'*40
    $ack = "CONTROL_RETURN_ACK_V1\nsource_return_request_receipt: 901\nsource_head: $head\ntarget_control_generation: 011"
    $decision = "CONTROL_RETURN_CONTINUATION_V1\nsource_return_request_receipt: 901\nsource_ack_receipt: 902\nsource_head: $head\ntarget_control_generation: 011\nreread_receipts: 43:903,81:904,88:905,124:901\nbounded_decision: WAIT_FRESH_REVIEW\nnext_action_receipt: 906"
    @((Test-ControlContinuation $ack '' '901' '902' $head '011'), (Test-ControlContinuation $ack $decision '901' '902' $head '011')) | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, [false, true]);
});

test("Repair03 T02/T04/T05/T08/T09: real workflow wiring preserves scoped preflight and owner compatibility", async () => {
  const boot = await workflowText(BOOTSTRAP);
  const bridge = await workflowText(RETURN_BRIDGE);
  for (const required of ["Get-GuardDecision", "agent get", "agent read", "worker_repo_root", "--approve-for-me", "skills/worker/SKILL.md", "git -C $workerRoot", "workflow_job", "source_head:", "PARKED_FOR_BOUNDED_REPAIR", "5570904521", "workflow_dispatch", "actions: write"]) assert.ok(boot.includes(required), required);
  assert.ok(bridge.includes("workflow_dispatch:"));
  assert.ok(bridge.includes("CONTROL_RETURN_REQUEST_V1"));
  assert.ok(bridge.includes("author_association == 'OWNER'"));
  assert.ok(bridge.includes("Claim-Delivery"));
  assert.ok(bridge.includes("CONTROL_RETURN_CONTINUATION_V1"));
  assert.doesNotMatch(boot, /dangerously-bypass-approvals-and-sandbox|workspace close|session stop/);
});

test("Repair03 T04/T05: actual bot terminal publisher reads back before exact workflow dispatch", async () => {
  const result = await runRepairFunctions(BOOTSTRAP, `
    $repo='D22977/gpt-browser-bridge'; $wakeId='900'; $expectedCard='5565343447'
    $sourceCardId='GBB-HERDR-SUBMIT-FRESH-COORDINATOR-REPAIR-02-G11'; $workerBase='a'*40; $sourceDefaultHead='b'*40
    $currentSwitchReceipt='5559192452'; $headers=@{}; $idem='fixture'; $workerRoot=$PSScriptRoot
    $namedSession='fresh-900'; $workspaceId='w1'; $pane='w1:p1'; $agentName='worker900'; $agentSession='native900'
    $promptCount=1; $consumedReceipt='899'; $terminalReceipt='898'; $requiredBranch='worker/fixture'
    $observation=@{status='blocked'; readback='Get-Content skills/worker/SKILL.md'; hash='abc'}
    $decision=@{prompt_consumption='PROMPT_CONSUMED'}; $env:GITHUB_RUN_ID='123'; $env:GITHUB_JOB='test'
    $script:calls=[Collections.Generic.List[string]]::new()
    function Invoke-RestMethod($Uri,$Headers,$Method,$Body,$ContentType,$TimeoutSec) {
      if ($Uri -match '/dispatches$') { $script:calls.Add('dispatch'); $script:payload=$Body | ConvertFrom-Json; return }
      if ($Method -eq 'Post') { $script:calls.Add('publish'); $script:published=($Body | ConvertFrom-Json).body; return @{id=901} }
      if ($Uri -match '/901$') { $script:calls.Add('readback'); return @{body=$script:published} }
      return @{body="new_conversation_id: 6a9d4f5b-ba9c-83ee-9694-44f99ea7515e\nnew_conversation_url: https://chatgpt.com/c/6a9d4f5b-ba9c-83ee-9694-44f99ea7515e"}
    }
    Publish-Terminal 'CONTROL_REQUIRED_BLOCKED_APPROVAL' 'fixture'
    [pscustomobject]@{calls=$script:calls.ToArray(); body=$script:published; payload=$script:payload; attempted=$terminalPublicationAttempted} | ConvertTo-Json -Depth 8 -Compress
  `);
  assert.deepEqual(result.calls, ["publish", "readback", "dispatch"]);
  const request = JSON.parse(result.payload.inputs.request);
  assert.equal(result.payload.ref, "review-base/gbb-gh-01");
  assert.equal(request.source_terminal_receipt, "901");
  assert.equal(request.source_bootstrap_wake, "900");
  assert.equal(request.source_head, "a".repeat(40));
  assert.equal(request.target_control_generation, "011");
  for (const line of ["workflow_run_id: 123", "workflow_job: test", "fresh_agent_session: native900", "physical_prompt_count: 1", "owner_enter_count: 0", "send_keys_used: false", "orca_used: false", "readback_verified: true"]) assert.ok(result.body.includes(line), line);
  assert.equal(result.attempted, true);
});

test("Repair03 T05: failed terminal readback never dispatches a return", async () => {
  const result = await runRepairFunctions(BOOTSTRAP, `
    $repo='D22977/gpt-browser-bridge'; $wakeId='900'; $headers=@{}
    $observation=@{}; $decision=@{}; $script:dispatchCount=0
    function Invoke-RestMethod($Uri,$Headers,$Method,$Body,$ContentType,$TimeoutSec) {
      if ($Uri -match '/dispatches$') { $script:dispatchCount++; return }
      if ($Method -eq 'Post') { return @{id=901} }
      return @{body='wrong readback'}
    }
    $failed=$false
    try { Publish-Terminal 'BLOCKED' 'fixture' } catch { $failed=$true }
    [pscustomobject]@{failed=$failed; dispatches=$script:dispatchCount; attempted=$terminalPublicationAttempted} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, { failed: true, dispatches: 0, attempted: true });
});

test("Repair03 T03/T08/T09: actual guard reconciles a late READY without another prompt or cleanup", async () => {
  const workflow = await workflowText(BOOTSTRAP);
  const loop = workflow.match(/# BEGIN REPAIR03 GUARD\r?\n([\s\S]*?)\s*# END REPAIR03 GUARD/)[1]
    .split(/\r?\n/).map(line => line.replace(/^          /, "")).join("\n");
  const result = await runRepairFunctions(BOOTSTRAP, `
    $wakeId='900'; $sinceEncoded='fixture'; $promptCount=1; $promptExit=0
    $consumedReceipt=''; $terminalReceipt=''; $statePath=Join-Path $PSScriptRoot 'guard.json'
    $script:reads=0; $script:sleeps=0; $script:published=@()
    function FindReceipt($protocol,$wake,$since) {
      if ($protocol -eq 'GBB_HERDR_SUBMIT_FRESH_REPAIR_CONSUMED_STARTED_V1') { return $null }
      $script:reads++
      if ($script:reads -eq 2) { return @{id='901'; body='state: READY_FOR_FRESH_REVIEW'} }
      return $null
    }
    function Observe-Agent { return @{status='blocked'; readback='approval'; hash='fixture'} }
    function Start-Sleep { $script:sleeps++; throw 'Unexpected wait' }
    function Publish-Terminal($state,$detail,$cleanup) { $script:published+=@{state=$state; cleanup=$cleanup; terminal=$terminalReceipt} }
    ${loop}
    [pscustomobject]@{published=$script:published; reads=$script:reads; sleeps=$script:sleeps; promptCount=$promptCount} | ConvertTo-Json -Depth 5 -Compress
  `);
  assert.deepEqual(result.published, [{ state: "WORKER_TERMINAL_OBSERVED", cleanup: "PARKED_FOR_BOUNDED_REPAIR", terminal: "901" }]);
  assert.equal(result.reads, 2);
  assert.equal(result.sleeps, 0);
  assert.equal(result.promptCount, 1);
});

test("Repair03 T06/T09: receipt search completes pages and ignores quoted or foreign receipts", async () => {
  const result = await runRepairFunctions(BOOTSTRAP, `
    $repo='D22977/gpt-browser-bridge'; $headers=@{}; $script:pages=0
    function Invoke-RestMethod($Uri,$Headers,$Method,$TimeoutSec) {
      $script:pages++
      if ($script:pages -eq 1) {
        1..100 | ForEach-Object { @{id=$_; user=@{login='D22977'}; body="quoted\nGBB_HERDR_SUBMIT_FRESH_REPAIR_RESULT_V1\nsource_bootstrap_wake: 900"} }
      } else {
        @{id=101; user=@{login='intruder'}; body="GBB_HERDR_SUBMIT_FRESH_REPAIR_RESULT_V1\nsource_bootstrap_wake: 900"}
        @{id=102; user=@{login='D22977'}; body="GBB_HERDR_SUBMIT_FRESH_REPAIR_RESULT_V1\nsource_bootstrap_wake: 900"}
      }
    }
    $receipt=FindReceipt 'GBB_HERDR_SUBMIT_FRESH_REPAIR_RESULT_V1' '900' 'fixture'
    [pscustomobject]@{id=$receipt.id; pages=$script:pages} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, { id: 102, pages: 2 });
});

test("Repair03 T06: partial claim and conflicting binding fail closed without rewriting evidence", async () => {
  const result = await runRepairFunctions(RETURN_BRIDGE, `
    $file=Join-Path $PSScriptRoot 'broken.json'
    Set-Content $file '{'
    $partial=Claim-Delivery $file 'new' 'SENDING'
    $unchanged=(Get-Content $file -Raw).Trim()
    @{status='SENT'; binding='other'} | ConvertTo-Json | Set-Content $file
    $conflict=Claim-Delivery $file 'new' 'SENDING'
    @($partial,$unchanged,$conflict) | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, ["CONTROL_REQUIRED_RECONCILE_NO_BLIND_RETRY", "{", "CONTROL_REQUIRED_RECONCILE_NO_BLIND_RETRY"]);
});

test("Repair03 T09: historical wake exits before new fields, runtime creation or prompt", async () => {
  const workflow = await workflowText(BOOTSTRAP);
  const entry = workflow.slice(workflow.indexOf("          $event = Get-Content"), workflow.indexOf("          $stateRoot ="))
    .split(/\r?\n/).map(line => line.replace(/^          /, "")).join("\n");
  const result = await runRepairFunctions(BOOTSTRAP, `
    $env:GITHUB_EVENT_PATH=Join-Path $PSScriptRoot 'old-wake.json'
    @{comment=@{id='5570904521'; body='historical wake without new admission fields'; created_at='2026-09-07T00:00:00Z'}} | ConvertTo-Json | Set-Content $env:GITHUB_EVENT_PATH
    function Publish-Terminal($state,$detail) { [pscustomobject]@{state=$state; detail=$detail; prompts=$promptCount; runtime=$namedSession} | ConvertTo-Json -Compress }
    ${entry}
    throw 'Historical wake reached executable entrypoint'
  `);
  assert.deepEqual(result, { state: "NO_OP_DUPLICATE", detail: "HISTORICAL_WAKE_NO_RETRY", prompts: 0, runtime: "" });
});

test("Repair03 T05/T06/T09: actual owner and internal admission share one logical delivery key", async () => {
  const workflow = await workflowText(RETURN_BRIDGE);
  const admission = workflow.slice(workflow.indexOf("          $event = Get-Content"), workflow.indexOf("          $whoami ="))
    .split(/\r?\n/).map(line => line.replace(/^          /, "")).join("\n");
  const results = [];
  for (const mode of ["issue_comment", "workflow_dispatch"]) {
    results.push(await runRepairFunctions(RETURN_BRIDGE, `
      $env:RUNNER_TEMP=$PSScriptRoot; $env:GITHUB_RUN_ID='123'; $env:GITHUB_ENV=Join-Path $PSScriptRoot 'env.txt'
      $env:GITHUB_EVENT_NAME='${mode}'; $env:GITHUB_ACTOR='D22977'; $env:GITHUB_EVENT_PATH=Join-Path $PSScriptRoot 'event.json'
      $head='a'*40; $default='b'*40; $card='GBB-HERDR-SUBMIT-FRESH-COORDINATOR-REPAIR-02-G11'
      $id='6a9d4f5b-ba9c-83ee-9694-44f99ea7515e'; $url="https://chatgpt.com/c/$id"
      $input=@{source_issue='124'; source_card_id=$card; source_terminal_receipt='901'; source_head=$head; source_bootstrap_wake='900'; target_control_generation='011'; target_control_conversation_id=$id; target_control_conversation_url=$url; idempotency_key='GBB124-900-RETURN'}
      $lines=@('CONTROL_RETURN_REQUEST_V1','target_control_status: ACTIVE')
      foreach ($k in $input.Keys) { if ($k -ne 'source_bootstrap_wake') { $lines+="$($k): $($input[$k])" } }
      $eventFixture=@{repository=@{full_name='D22977/gpt-browser-bridge'}; issue=@{number=124}; comment=@{id=902; user=@{login='D22977'}; author_association='OWNER'; body=($lines -join "\n")}; inputs=@{request=($input|ConvertTo-Json -Compress)}}
      $eventFixture | ConvertTo-Json -Depth 8 | Set-Content $env:GITHUB_EVENT_PATH
      function Invoke-RestMethod($Uri,$Headers,$TimeoutSec) {
        if ($Uri -match '/comments/901$') { return @{id=901; user=@{login='github-actions[bot]'}; issue_url='https://api.github.com/repos/D22977/gpt-browser-bridge/issues/124'; body="REPAIR02_FRESH_WORKER_BOOTSTRAP_RESULT_V1\nstate: WORKER_TERMINAL_OBSERVED\nsource_head: $head\nsource_default_head: $default\nsource_card_id: $card\nsource_bootstrap_wake: 900\nworkflow_run_id: 123\nreadback_verified: true"} }
        if ($Uri -match '/issues/88/comments') { return @{id=905; body="CONTROL_GENERATION_SWITCH_V1\nstate: SWITCH_COMMITTED\nnew_generation_status: ACTIVE\nnew_generation: 011\nnew_conversation_id: $id\nnew_conversation_url: $url"} }
        if ($Uri -match '/actions/runs/123$') { return @{path='.github/workflows/g11-issue124-repair02-fresh-worker-bootstrap-once.yml'; event='issue_comment'; head_sha=$default; repository=@{full_name='D22977/gpt-browser-bridge'}} }
        if ($Uri -match '/comments/900$') { return @{user=@{login='D22977'}; author_association='OWNER'; issue_url='https://api.github.com/repos/D22977/gpt-browser-bridge/issues/124'; body="REPAIR02_FRESH_WORKER_BOOTSTRAP_WAKE_V1\nworker_base_sha: $head"} }
        if ($Uri -match '/branches/') { return @{commit=@{sha=$default}} }
        throw "Unexpected API route $Uri"
      }
      ${admission}
      [pscustomobject]@{validation=$validation; key=$key; binding=$binding; requestId=$requestId} | ConvertTo-Json -Compress
    `));
  }
  assert.equal(results[0].validation, "VALID");
  assert.equal(results[1].validation, "VALID");
  assert.equal(results[0].key, results[1].key);
  assert.equal(results[0].binding, `124|900|${"a".repeat(40)}`);
  assert.equal(results[0].requestId, "902");
  assert.equal(results[1].requestId, "901");
});

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8"));
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fakeExecFactory(handlers) {
  const calls = [];
  const counts = {};
  async function exec(cliPath, args, opts) {
    const subcommand = args[2];
    calls.push({ cliPath, args, opts });
    counts[subcommand] = (counts[subcommand] || 0) + 1;
    const handler = handlers[subcommand];
    if (!handler) throw new Error(`fakeExec: no handler registered for subcommand "${subcommand}"`);
    return handler(args, counts[subcommand]);
  }
  exec.calls = calls;
  exec.counts = counts;
  return exec;
}

function jsonStdout(value) {
  return { stdout: JSON.stringify({ result: value }), stderr: "" };
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

test("computePromptHash is a deterministic sha256 of the prompt", () => {
  const prompt = "review pack T2";
  assert.equal(computePromptHash(prompt), sha256(prompt));
  assert.equal(computePromptHash(prompt), computePromptHash(prompt));
});

test("computePromptHash rejects an empty prompt", () => {
  assert.throws(() => computePromptHash(""), /non-empty/);
});

test("readBaselineFromSnapshot reads assistant_count and last_assistant_hash for an existing conversation", async () => {
  const fixture = await loadFixture("six_answers_snapshot.json");
  // Baseline snapshot as it existed *before* the 6th prompt was sent: only
  // the first 5 assistant answers exist yet.
  const preSendSnapshot = { assistantMessages: fixture.assistantMessages.slice(0, 5) };
  const baseline = readBaselineFromSnapshot(preSendSnapshot);
  assert.equal(baseline.assistant_count, 5);
  assert.equal(baseline.last_assistant_hash, sha256(fixture.assistantMessages[4]));
  // The 5th answer's hash must differ from the 6th's - this is the guard
  // rail that keeps the Sender's baseline and the Watcher's candidate index
  // from ever being confused with each other.
  assert.notEqual(baseline.last_assistant_hash, sha256(fixture.assistantMessages[5]));
});

test("readBaselineFromSnapshot handles a brand-new conversation (zero assistant messages)", () => {
  const baseline = readBaselineFromSnapshot({ assistantMessages: [] });
  assert.equal(baseline.assistant_count, 0);
  assert.equal(baseline.last_assistant_hash, sha256(""));
});

test("generateJobId returns unique v4-style ids", () => {
  const a = generateJobId();
  const b = generateJobId();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f-]{36}$/i);
});

test("buildJob produces a schema-valid immutable job payload", () => {
  const job = buildJob({
    prompt: "review pack T2",
    attempt: 1,
    conversationUrl: "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949",
    sentAt: "2026-08-01T09:00:00+08:00",
    baseline: { assistant_count: 5, last_assistant_hash: sha256("Answer 5") },
  });
  assert.equal(job.prompt_hash, sha256("review pack T2"));
  assert.equal(job.baseline.assistant_count, 5);
  assert.match(job.job_id, /^[0-9a-f-]{36}$/i);
});

test("buildJob rejects a non-ChatGPT conversation URL (reuses contracts.mjs validation)", () => {
  assert.throws(() =>
    buildJob({
      prompt: "x",
      attempt: 1,
      conversationUrl: "https://example.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949",
      sentAt: "2026-08-01T09:00:00+08:00",
      baseline: { assistant_count: 0, last_assistant_hash: sha256("") },
    })
  );
});

// ---------------------------------------------------------------------------
// job.json immutability + path confinement
// ---------------------------------------------------------------------------

test("resolveJobDir confines output under <runtimeRoot>/jobs/<job_id>", () => {
  const dir = resolveJobDir("D:\\AIWORK_RUNTIME\\GPT_BROWSER_BRIDGE", "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(dir, path.resolve("D:\\AIWORK_RUNTIME\\GPT_BROWSER_BRIDGE", "jobs", "550e8400-e29b-41d4-a716-446655440000"));
});

test("resolveJobDir rejects path traversal and unsafe job ids", () => {
  assert.throws(() => resolveJobDir("D:\\RUNTIME", "../escape"));
  assert.throws(() => resolveJobDir("D:\\RUNTIME", "a/b"));
  assert.throws(() => resolveJobDir("D:\\RUNTIME", "a\\b"));
  assert.throws(() => resolveJobDir("D:\\RUNTIME", ""));
});

test("writeJobFile writes job.json and refuses to overwrite an existing immutable job", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb003-baseline-"));
  const job = buildJob({
    prompt: "review pack T2",
    attempt: 1,
    conversationUrl: "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949",
    sentAt: "2026-08-01T09:00:00+08:00",
    baseline: { assistant_count: 5, last_assistant_hash: sha256("Answer 5") },
  });
  const jobDir = resolveJobDir(runtimeRoot, job.job_id);

  const jobPath = await writeJobFile(jobDir, job, { existsCheck: async () => false });
  const written = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(written.job_id, job.job_id);

  await assert.rejects(
    () => writeJobFile(jobDir, job, { existsCheck: async () => true }),
    /refusing to overwrite/
  );
});

// ---------------------------------------------------------------------------
// Gate A/B-style CLI wrapper (fake exec, no live browser)
// ---------------------------------------------------------------------------

test("locateChatgptTab selects the single matching conversation tab", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
  });
  const match = await locateChatgptTab("https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949", {
    session: "gbb-send-test",
    exec,
  });
  assert.equal(match.index, 0);
  assert.equal(exec.counts["tab-select"], 1);
});

test("locateChatgptTab fails closed on zero matches", async () => {
  const tabs = await loadFixture("tab_list_no_match.json");
  const exec = fakeExecFactory({ "tab-list": () => jsonStdout(tabs) });
  await assert.rejects(
    () => locateChatgptTab("https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949", { session: "s", exec }),
    (err) => err instanceof SendInvalidationError && err.code === "TAB_NOT_FOUND"
  );
});

test("locateChatgptTab fails closed on multiple matches (never guesses)", async () => {
  const tabs = await loadFixture("tab_list_multi_match.json");
  const exec = fakeExecFactory({ "tab-list": () => jsonStdout(tabs) });
  await assert.rejects(
    () => locateChatgptTab("https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949", { session: "s", exec }),
    (err) => err instanceof SendInvalidationError && err.code === "TAB_AMBIGUOUS"
  );
});

// ---------------------------------------------------------------------------
// GBB-URL-001: GPT-project conversation URLs (/g/<project-id>/c/<uuid-ish>)
// must match the same tab as the legacy /c/<uuid-ish> form, in either
// direction (job URL legacy + tab URL project, and vice versa).
// ---------------------------------------------------------------------------

test("locateChatgptTab matches a GPT-project tab URL against a legacy job conversationUrl (same id)", async () => {
  const conversationId = "6a6cc7f7-6ec8-83ee-8c86-8fe600980949";
  const tabs = [
    { index: 0, current: true, title: "GBB project chat", url: `https://chatgpt.com/g/g-p-680e34d1-review-bot/c/${conversationId}` },
  ];
  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
  });
  const match = await locateChatgptTab(`https://chatgpt.com/c/${conversationId}`, { session: "s", exec });
  assert.equal(match.index, 0);
  assert.equal(exec.counts["tab-select"], 1);
});

test("locateChatgptTab matches a legacy tab URL against a GPT-project job conversationUrl (same id)", async () => {
  const conversationId = "6a6cc7f7-6ec8-83ee-8c86-8fe600980949";
  const tabs = [{ index: 0, current: true, title: "GBB legacy chat", url: `https://chatgpt.com/c/${conversationId}` }];
  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
  });
  const match = await locateChatgptTab(
    `https://chatgpt.com/g/g-p-680e34d1-review-bot/c/${conversationId}`,
    { session: "s", exec }
  );
  assert.equal(match.index, 0);
  assert.equal(exec.counts["tab-select"], 1);
});

test("locateChatgptTab still fails closed when a GPT-project tab URL carries a different conversation id", async () => {
  const conversationId = "6a6cc7f7-6ec8-83ee-8c86-8fe600980949";
  const otherId = "00000000-0000-0000-0000-000000000000";
  const tabs = [{ index: 0, current: true, title: "unrelated chat", url: `https://chatgpt.com/g/g-p-680e34d1-review-bot/c/${otherId}` }];
  const exec = fakeExecFactory({ "tab-list": () => jsonStdout(tabs) });
  await assert.rejects(
    () => locateChatgptTab(`https://chatgpt.com/c/${conversationId}`, { session: "s", exec }),
    (err) => err instanceof SendInvalidationError && err.code === "TAB_NOT_FOUND"
  );
});

test("waitConversationUrl polls until the conversation URL appears", async () => {
  const urls = ["https://chatgpt.com/", "https://chatgpt.com/", "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949"];
  let i = 0;
  const exec = fakeExecFactory({
    eval: () => jsonStdout({ url: urls[Math.min(i++, urls.length - 1)] }),
  });
  const sleeps = [];
  const url = await waitConversationUrl({
    session: "s",
    exec,
    sleep: async (ms) => sleeps.push(ms),
    now: () => 0,
  });
  assert.equal(url, "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949");
  assert.equal(sleeps.length, 2);
});

test("waitConversationUrl times out rather than waiting forever", async () => {
  const exec = fakeExecFactory({ eval: () => jsonStdout({ url: "https://chatgpt.com/" }) });
  let t = 0;
  await assert.rejects(
    () =>
      waitConversationUrl({
        session: "s",
        exec,
        timeoutMs: 5_000,
        pollIntervalMs: 1_000,
        sleep: async () => {
          t += 1_000;
        },
        now: () => t,
      }),
    (err) => err instanceof SendInvalidationError && err.code === "WAIT_CONVERSATION_URL_TIMEOUT"
  );
});

// ---------------------------------------------------------------------------
// Full Sender flow: send once, write job.json, stop (never watches).
// ---------------------------------------------------------------------------

test("sendJob reads baseline, sends, waits for URL, writes job.json, and never reads assistant replies afterwards", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const conversationUrl = "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949";
  const fixture = await loadFixture("six_answers_snapshot.json");
  const preSend = { url: conversationUrl, assistantMessages: fixture.assistantMessages.slice(0, 5) };

  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
    eval: (args, callIndex) => (callIndex === 1 ? jsonStdout(preSend) : jsonStdout({ url: conversationUrl })),
    fill: () => jsonStdout(null),
    click: () => jsonStdout(null),
  });

  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb003-sendjob-"));
  const { job, jobPath } = await sendJob({
    prompt: "review pack T2",
    attempt: 1,
    conversationUrl,
    runtimeRoot,
    session: "gbb-send-test",
    exec,
    sleep: async () => {},
    now: () => Date.parse("2026-08-01T09:00:00+08:00"),
    existsCheck: async () => false,
  });

  assert.equal(job.baseline.assistant_count, 5);
  assert.equal(job.conversation_url, conversationUrl);
  const written = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(written.job_id, job.job_id);

  // Only Sender-legal subcommands were used, and no polling loop for
  // assistant replies happened (that is exclusively the Watcher's job).
  assert.deepEqual(Object.keys(exec.counts).sort(), ["click", "eval", "fill", "tab-list", "tab-select"]);
  assert.equal(exec.counts.fill, 1);
  assert.equal(exec.counts.click, 1);
});

// ---------------------------------------------------------------------------
// sendPrompt: click, not the invalid `press <selector>` call (CONT_DISPATCH3
// finding - `press` takes key names like "Enter", not a CSS selector).
// ---------------------------------------------------------------------------

test("sendPrompt fills the editor then clicks the send button (never presses a selector as a key)", async () => {
  const exec = fakeExecFactory({
    fill: () => jsonStdout(null),
    click: () => jsonStdout(null),
  });
  await sendPrompt("hello", { session: "s", exec });
  assert.deepEqual(exec.calls.map((c) => c.args[2]), ["fill", "click"]);
  assert.ok(exec.calls[1].args.includes(SEND_BUTTON_SELECTOR), "click must target the send button selector");
});

// ---------------------------------------------------------------------------
// Page-hidden fail-closed (CONT_DISPATCH3): a background tab cannot reliably
// receive a click (rAF actionability hangs) and Enter does not submit either,
// so readBaseline must refuse to proceed rather than attempt the send.
// ---------------------------------------------------------------------------

test("assertPageVisible fails closed with PAGE_HIDDEN when the tab is not visible", () => {
  assert.throws(
    () => assertPageVisible({ visibilityState: "hidden" }),
    (err) => err instanceof SendInvalidationError && err.code === "PAGE_HIDDEN"
  );
});

test("assertPageVisible allows a visible page through untouched", () => {
  assert.doesNotThrow(() => assertPageVisible({ visibilityState: "visible" }));
  // Older/partial snapshots without the field must not be treated as hidden.
  assert.doesNotThrow(() => assertPageVisible({}));
});

// ---------------------------------------------------------------------------
// allowBackgroundTab: explicit, default-false authorization for approved
// web-chat channels (e.g. ChatGPT) to send from a background tab. Does not
// apply to CLI/local models - it only widens this one gate in the reusable
// web-chat sender path, every other gate stays in force.
// ---------------------------------------------------------------------------

test("assertPageVisible still fails closed with PAGE_HIDDEN when allowBackgroundTab is omitted (default false)", () => {
  assert.throws(
    () => assertPageVisible({ visibilityState: "hidden" }, {}),
    (err) => err instanceof SendInvalidationError && err.code === "PAGE_HIDDEN"
  );
});

test("assertPageVisible allows a hidden page through when allowBackgroundTab is explicitly true", () => {
  assert.doesNotThrow(() => assertPageVisible({ visibilityState: "hidden" }, { allowBackgroundTab: true }));
});

test("readBaseline fails closed with PAGE_HIDDEN and never attempts fill/click when the tab is hidden", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
    eval: () =>
      jsonStdout({
        url: "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949",
        assistantMessages: [],
        visibilityState: "hidden",
      }),
  });
  await assert.rejects(
    () => readBaseline("https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949", { session: "s", exec }),
    (err) => err instanceof SendInvalidationError && err.code === "PAGE_HIDDEN"
  );
  assert.equal(exec.counts.fill, undefined);
  assert.equal(exec.counts.click, undefined);
});

test("readBaseline proceeds past a hidden page when allowBackgroundTab is true", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
    eval: () =>
      jsonStdout({
        url: "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949",
        assistantMessages: [],
        visibilityState: "hidden",
      }),
  });
  const baseline = await readBaseline("https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949", {
    session: "s",
    exec,
    allowBackgroundTab: true,
  });
  assert.equal(baseline.assistant_count, 0);
});

test("sendJob completes an authorized background-tab send (allowBackgroundTab: true) while keeping every other gate", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const conversationUrl = "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949";
  const fixture = await loadFixture("six_answers_snapshot.json");
  const preSend = {
    url: conversationUrl,
    assistantMessages: fixture.assistantMessages.slice(0, 5),
    visibilityState: "hidden",
  };

  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
    eval: (args, callIndex) => (callIndex === 1 ? jsonStdout(preSend) : jsonStdout({ url: conversationUrl })),
    fill: () => jsonStdout(null),
    click: () => jsonStdout(null),
  });

  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb005-bgtab-"));
  const { job, jobPath } = await sendJob({
    prompt: "review pack T2",
    attempt: 1,
    conversationUrl,
    runtimeRoot,
    session: "gbb-send-test",
    exec,
    sleep: async () => {},
    now: () => Date.parse("2026-08-01T09:00:00+08:00"),
    existsCheck: async () => false,
    allowBackgroundTab: true,
  });

  assert.equal(job.baseline.assistant_count, 5);
  assert.equal(job.conversation_url, conversationUrl);
  const written = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(written.job_id, job.job_id);

  // Unique-tab, fill, and click gates still all ran - only the hidden-page
  // gate was authorized to relax.
  assert.equal(exec.counts["tab-select"], 1);
  assert.equal(exec.counts.fill, 1);
  assert.equal(exec.counts.click, 1);
});

test("sendJob refuses to send when the pre-send baseline reports a hidden page", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
    eval: () =>
      jsonStdout({
        url: "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949",
        assistantMessages: [],
        visibilityState: "hidden",
      }),
  });
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb003-pagehidden-"));
  await assert.rejects(
    () =>
      sendJob({
        prompt: "hello",
        attempt: 1,
        conversationUrl: "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949",
        runtimeRoot,
        session: "s",
        exec,
        sleep: async () => {},
        now: () => Date.parse("2026-08-01T09:00:00+08:00"),
        existsCheck: async () => false,
      }),
    (err) => err instanceof SendInvalidationError && err.code === "PAGE_HIDDEN"
  );
  assert.equal(exec.counts.fill, undefined, "must never attempt fill on a hidden page");
  assert.equal(exec.counts.click, undefined, "must never attempt click on a hidden page");
});

// ---------------------------------------------------------------------------
// Real CLI object-envelope parsing (P1-1 rework): fixtures/chatgpt/live_*.json
// were captured from the actual `@playwright/cli` 0.1.17 binary attached to
// a real CDP endpoint (127.0.0.1:9225), not hand-written. See each fixture's
// `_finding` field for what it proves.
// ---------------------------------------------------------------------------

test("parseTabList parses the real tab-list markdown shape (single tab, current)", async () => {
  const fixture = await loadFixture("live_tab_list_single.json");
  const parsed = JSON.parse(fixture.stdout);
  const tabs = parseTabList(parsed.result);
  assert.deepEqual(tabs, [
    { index: 0, current: true, title: "GBB-003 功能驗收結果", url: "https://chatgpt.com/c/6a6cefb4-b2f8-83ee-8237-c22cb949dba1" },
  ]);
});

test("parseTabList parses the real tab-list markdown shape (multiple tabs)", async () => {
  const fixture = await loadFixture("live_tab_list_multi.json");
  const parsed = JSON.parse(fixture.stdout);
  const tabs = parseTabList(parsed.result);
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].current, false);
  assert.equal(tabs[1].current, true);
  assert.equal(tabs[1].url, "https://chatgpt.com/");
});

test("parseTabList still accepts an already-structured array (back-compat with hand-written fixtures)", () => {
  assert.deepEqual(parseTabList([{ index: 0, url: "https://chatgpt.com/c/x" }]), [{ index: 0, url: "https://chatgpt.com/c/x" }]);
  assert.deepEqual(parseTabList("not a tab list at all"), []);
  assert.deepEqual(parseTabList(null), []);
});

test("locateChatgptTab works against the real markdown tab-list envelope end to end", async () => {
  const fixture = await loadFixture("live_tab_list_single.json");
  const exec = fakeExecFactory({
    "tab-list": () => ({ stdout: fixture.stdout, stderr: "" }),
    "tab-select": () => jsonStdout(null),
  });
  const match = await locateChatgptTab("https://chatgpt.com/c/6a6cefb4-b2f8-83ee-8237-c22cb949dba1", {
    session: "gbb-send-test",
    exec,
  });
  assert.equal(match.index, 0);
});

test("runCliCommand parses the real primitive-string eval envelope", async () => {
  const fixture = await loadFixture("live_eval_string.json");
  const exec = fakeExecFactory({ eval: () => ({ stdout: fixture.stdout, stderr: "" }) });
  const result = await runCliCommand("eval", ["() => document.title"], { session: "s", exec });
  assert.equal(result, "GBB-003 功能驗收結果");
});

test("runCliCommand parses the real object-returning eval envelope (BASELINE_SNAPSHOT_SCRIPT shape)", async () => {
  const fixture = await loadFixture("live_eval_object.json");
  const exec = fakeExecFactory({ eval: () => ({ stdout: fixture.stdout, stderr: "" }) });
  const result = await runCliCommand("eval", ["() => ({url: location.href, assistantMessages: []})"], { session: "s", exec });
  assert.equal(result.url, "https://chatgpt.com/c/6a6cefb4-b2f8-83ee-8237-c22cb949dba1");
  assert.ok(Array.isArray(result.assistantMessages));
});

test("runCliCommand parses the real array-returning eval envelope", async () => {
  const fixture = await loadFixture("live_eval_array.json");
  const exec = fakeExecFactory({ eval: () => ({ stdout: fixture.stdout, stderr: "" }) });
  const result = await runCliCommand("eval", ["() => ['a','b','c']"], { session: "s", exec });
  assert.deepEqual(result, ["a", "b", "c"]);
});

test("runCliCommand throws on the real isError:true / exit-0 error envelope instead of treating it as valid data", async () => {
  const fixture = await loadFixture("live_cli_error.json");
  const exec = fakeExecFactory({ eval: () => ({ stdout: fixture.stdout_eval_syntax_error, stderr: "" }) });
  await assert.rejects(
    () => runCliCommand("eval", ["() => )bad("], { session: "s", exec }),
    (err) => err instanceof SendInvalidationError && err.code === "CLI_ERROR_RESPONSE:eval"
  );
});

test("runCliCommand throws on a real tab-select-not-found isError response", async () => {
  const fixture = await loadFixture("live_cli_error.json");
  const exec = fakeExecFactory({ "tab-select": () => ({ stdout: fixture.stdout_tab_select_not_found, stderr: "" }) });
  await assert.rejects(
    () => runCliCommand("tab-select", ["99"], { session: "s", exec }),
    (err) => err instanceof SendInvalidationError && err.code === "CLI_ERROR_RESPONSE:tab-select"
  );
});

// ---------------------------------------------------------------------------
// P2: exit 0 with empty / truncated / mixed-non-JSON stdout must never be
// mistaken for valid data.
// ---------------------------------------------------------------------------

test("runCliCommand throws CLI_INVALID_JSON on exit-0-with-empty stdout", async () => {
  const exec = fakeExecFactory({ eval: () => ({ stdout: "", stderr: "" }) });
  await assert.rejects(
    () => runCliCommand("eval", ["() => document.title"], { session: "s", exec }),
    (err) => err instanceof SendInvalidationError && err.code === "CLI_INVALID_JSON:eval"
  );
});

test("runCliCommand throws CLI_INVALID_JSON on truncated JSON stdout", async () => {
  const exec = fakeExecFactory({ eval: () => ({ stdout: '{"result": {"url": "https://cha', stderr: "" }) });
  await assert.rejects(
    () => runCliCommand("eval", ["() => document.title"], { session: "s", exec }),
    (err) => err instanceof SendInvalidationError && err.code === "CLI_INVALID_JSON:eval"
  );
});

// ---------------------------------------------------------------------------
// Live-capture finding (fixtures/chatgpt/live_canary_send_watch.json,
// CMD_SHIM_SPAWN_EINVAL): recent Node refuses to spawn a `.cmd` shim directly
// without `shell: true` ("spawn EINVAL"). This was invisible in every prior
// test because they all inject a fake `exec` and never touch defaultExec's
// real spawn path. resolveSpawnTarget() is the fix: resolve the `.cmd` shim
// to the node entry point it wraps and spawn `node <entry>` directly instead
// (no shell, no argument-escaping/injection risk).
// ---------------------------------------------------------------------------

test("resolveSpawnTarget resolves a .cmd shim to `node <sibling cli.js>` (no shell)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gbb003-spawn-target-"));
  const shimDir = path.join(root, "pkgA", "node_modules", ".bin");
  const entryDir = path.join(root, "pkgA", "node_modules", "playwright");
  await mkdirAsync(shimDir, { recursive: true });
  await mkdirAsync(entryDir, { recursive: true });
  const entry = path.join(entryDir, "cli.js");
  await writeFile(entry, "// stub");
  const cliPath = path.join(shimDir, "playwright.cmd");
  await writeFile(cliPath, "@ECHO off");

  const target = resolveSpawnTarget(cliPath);
  assert.equal(target.command, process.execPath);
  assert.deepEqual(target.prefixArgs, [entry]);
});

test("resolveSpawnTarget throws a clear error when the .cmd shim's sibling entry does not exist", () => {
  assert.throws(() => resolveSpawnTarget("C:\\nowhere\\playwright.cmd"), /cannot resolve/);
});

test("resolveSpawnTarget passes a non-.cmd path through unchanged (already a real exe/.js)", () => {
  const target = resolveSpawnTarget("C:\\some\\path\\playwright-core.js");
  assert.equal(target.command, "C:\\some\\path\\playwright-core.js");
  assert.deepEqual(target.prefixArgs, []);
});

// ---------------------------------------------------------------------------
// File-upload attachments (GBB file-upload card): support approved web-chat
// review via file upload instead of passing large review pack text as a CLI
// fill argument. `upload` joins the Gate A allowlist, is invoked with the
// attachment paths before `fill`, and every attachment path is validated
// (explicit regular file, no missing/non-file paths) before any browser
// mutation happens.
// ---------------------------------------------------------------------------

test("ALLOWED_CLI_SUBCOMMANDS includes upload alongside the existing Sender-legal subcommands", () => {
  assert.ok(ALLOWED_CLI_SUBCOMMANDS.includes("upload"));
  // Gate A stays closed: still no tab-close/tab-new/run-code/show.
  assert.deepEqual(
    [...ALLOWED_CLI_SUBCOMMANDS].sort(),
    ["click", "eval", "fill", "press", "tab-list", "tab-select", "upload"]
  );
});

test("validateAttachments is a no-op returning [] when attachments is omitted or null", async () => {
  assert.deepEqual(await validateAttachments(undefined), []);
  assert.deepEqual(await validateAttachments(null), []);
});

test("validateAttachments accepts an existing regular file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-upload-valid-"));
  const filePath = path.join(dir, "review_pack.pdf");
  await writeFile(filePath, "stub bytes");
  const result = await validateAttachments([filePath]);
  assert.deepEqual(result, [filePath]);
});

test("validateAttachments rejects a missing attachment path with a structured SendInvalidationError", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-upload-missing-"));
  const missingPath = path.join(dir, "does_not_exist.pdf");
  await assert.rejects(
    () => validateAttachments([missingPath]),
    (err) => err instanceof SendInvalidationError && err.code === "ATTACHMENT_NOT_FOUND"
  );
});

test("validateAttachments rejects a non-file attachment path (a directory) without reading it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-upload-dir-"));
  await assert.rejects(
    () => validateAttachments([dir]),
    (err) => err instanceof SendInvalidationError && err.code === "ATTACHMENT_NOT_A_FILE"
  );
});

test("sendPrompt uploads attachments before filling the editor, then clicks send (allowlist/upload order)", async () => {
  const exec = fakeExecFactory({
    upload: () => jsonStdout(null),
    fill: () => jsonStdout(null),
    click: () => jsonStdout(null),
  });
  await sendPrompt("hello", { session: "s", exec, attachments: ["C:\\pack\\review.pdf", "C:\\pack\\notes.txt"] });
  assert.deepEqual(exec.calls.map((c) => c.args[2]), ["upload", "fill", "click"]);
  assert.deepEqual(exec.calls[0].args.slice(3, 5), ["C:\\pack\\review.pdf", "C:\\pack\\notes.txt"]);
});

test("sendPrompt never calls upload when attachments is omitted or empty (default behavior preserved)", async () => {
  const exec = fakeExecFactory({
    fill: () => jsonStdout(null),
    click: () => jsonStdout(null),
  });
  await sendPrompt("hello", { session: "s", exec });
  await sendPrompt("hello", { session: "s", exec, attachments: [] });
  assert.equal(exec.counts.upload, undefined);
  assert.deepEqual(exec.calls.map((c) => c.args[2]), ["fill", "click", "fill", "click"]);
});

test("sendJob rejects a missing attachment before touching the browser at all", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-upload-sendjob-missing-"));
  const missingPath = path.join(dir, "does_not_exist.pdf");
  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout([]),
  });
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb-upload-sendjob-runtime-"));
  await assert.rejects(
    () =>
      sendJob({
        prompt: "review pack T2",
        attempt: 1,
        conversationUrl: "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949",
        runtimeRoot,
        attachments: [missingPath],
        session: "s",
        exec,
        sleep: async () => {},
        now: () => Date.parse("2026-08-01T09:00:00+08:00"),
        existsCheck: async () => false,
      }),
    (err) => err instanceof SendInvalidationError && err.code === "ATTACHMENT_NOT_FOUND"
  );
  assert.equal(exec.counts["tab-list"], undefined, "must never contact the browser when an attachment is invalid");
});

test("sendJob uploads attachments then sends, while the default PAGE_HIDDEN gate and allowBackgroundTab:false still apply", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const conversationUrl = "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949";
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-upload-sendjob-ok-"));
  const attachmentPath = path.join(dir, "review_pack.pdf");
  await writeFile(attachmentPath, "stub bytes");

  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
    eval: (args, callIndex) =>
      callIndex === 1
        ? jsonStdout({ url: conversationUrl, assistantMessages: [], visibilityState: "visible" })
        : jsonStdout({ url: conversationUrl }),
    upload: () => jsonStdout(null),
    fill: () => jsonStdout(null),
    click: () => jsonStdout(null),
  });

  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb-upload-sendjob-runtime-ok-"));
  const { job } = await sendJob({
    prompt: "review pack T2",
    attempt: 1,
    conversationUrl,
    runtimeRoot,
    attachments: [attachmentPath],
    session: "gbb-send-test",
    exec,
    sleep: async () => {},
    now: () => Date.parse("2026-08-01T09:00:00+08:00"),
    existsCheck: async () => false,
  });

  assert.equal(job.conversation_url, conversationUrl);
  assert.equal(exec.counts.upload, 1);
  assert.equal(exec.counts.fill, 1);
  assert.equal(exec.counts.click, 1);
  // upload happens before fill/click within the send step.
  const order = exec.calls.map((c) => c.args[2]).filter((c) => c === "upload" || c === "fill" || c === "click");
  assert.deepEqual(order, ["upload", "fill", "click"]);
});

test("sendJob still rejects a hidden page by default even when attachments are supplied (allowBackgroundTab defaults false)", async () => {
  const tabs = await loadFixture("tab_list_single_match.json");
  const conversationUrl = "https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949";
  const dir = await mkdtemp(path.join(tmpdir(), "gbb-upload-sendjob-hidden-"));
  const attachmentPath = path.join(dir, "review_pack.pdf");
  await writeFile(attachmentPath, "stub bytes");

  const exec = fakeExecFactory({
    "tab-list": () => jsonStdout(tabs),
    "tab-select": () => jsonStdout(null),
    eval: () => jsonStdout({ url: conversationUrl, assistantMessages: [], visibilityState: "hidden" }),
  });

  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "gbb-upload-sendjob-runtime-hidden-"));
  await assert.rejects(
    () =>
      sendJob({
        prompt: "review pack T2",
        attempt: 1,
        conversationUrl,
        runtimeRoot,
        attachments: [attachmentPath],
        session: "s",
        exec,
        sleep: async () => {},
        now: () => Date.parse("2026-08-01T09:00:00+08:00"),
        existsCheck: async () => false,
      }),
    (err) => err instanceof SendInvalidationError && err.code === "PAGE_HIDDEN"
  );
  assert.equal(exec.counts.upload, undefined, "must never attempt upload on a hidden page");
  assert.equal(exec.counts.fill, undefined);
  assert.equal(exec.counts.click, undefined);
});
