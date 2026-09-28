import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const blocked = (code) => ({ state: "BLOCKED", code });
const receiptMarker = "GBB_CONTROL_TOWER_RECEIPT_V1\n";
const maxOutput = 4 * 1024 * 1024;
const timeoutMs = 20_000;

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  throw new TypeError("payload must be JSON data");
}

function parseCsv(raw, validate) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const values = raw.split(",").map((item) => item.trim());
  if (values.some((item) => !validate(item))) return null;
  return new Set(values);
}

function readCliEnv() {
  const env = {};
  for (const name of ["PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function runGh(args, input) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child?.kill();
      finish({ ok: false, code: "GH_TIMEOUT" });
    }, timeoutMs);
    try {
      child = spawn("gh", args, {
        shell: false,
        windowsHide: true,
        env: readCliEnv(),
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      });
      child.on("error", () => finish({ ok: false, code: "GH_START_FAILED" }));
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxOutput) {
          child.kill();
          finish({ ok: false, code: "GH_OUTPUT_TOO_LARGE" });
        } else chunks.push(chunk);
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) return finish({ ok: false, code: "GH_REQUEST_FAILED" });
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish({ ok: true, value });
        } catch {
          finish({ ok: false, code: "GH_INVALID_JSON" });
        }
      });
      if (input !== undefined) child.stdin.end(input);
    } catch {
      finish({ ok: false, code: "GH_START_FAILED" });
    }
  });
}

function configFrom(env) {
  const repos = parseCsv(env.CONTROL_TOWER_MCP_GITHUB_REPOS, (item) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item));
  const pointers = parseCsv(env.CONTROL_TOWER_MCP_GITHUB_POINTER_ISSUES, (item) => /^[1-9]\d*$/.test(item));
  const writes = new Map();
  const rawWrites = env.CONTROL_TOWER_MCP_GITHUB_WRITE_ALLOWLIST;
  let writesValid = rawWrites === undefined || (typeof rawWrites === "string" && rawWrites.trim() === "");
  if (typeof rawWrites === "string" && rawWrites.trim() !== "") {
    writesValid = true;
    for (const entry of rawWrites.split(",").map((item) => item.trim())) {
      const [repo, issue, protocol, ...extra] = entry.split("#");
      if (extra.length || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "") || !/^[1-9]\d*$/.test(issue ?? "") || !/^[A-Z0-9_]+$/.test(protocol ?? "")) {
        writesValid = false;
        break;
      }
      writes.set(`${repo}#${issue}#${protocol}`, true);
    }
  }
  return { repos, pointers, writes, writesValid };
}

function parseIssuePointer(pointer) {
  if (typeof pointer !== "string") return null;
  const match = /^(?:issue:|#)?([1-9]\d*)$/.exec(pointer.trim());
  return match ? match[1] : null;
}

function commentEndpoint(repo, issue) {
  return `repos/${repo}/issues/${issue}/comments`;
}

function parseReceipt(comment) {
  if (typeof comment?.body !== "string" || !comment.body.startsWith(receiptMarker)) return null;
  try {
    const value = JSON.parse(comment.body.slice(receiptMarker.length));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function supersededIds(comments, issue) {
  const ids = new Set();
  const pattern = new RegExp(`supersedes:\\s*Issue #${issue} comment (\\d+)`, "ig");
  for (const comment of comments) {
    for (const match of comment.body?.matchAll?.(pattern) ?? []) ids.add(Number(match[1]));
  }
  return ids;
}

export function createGitHubRuntimeServices({ env = process.env, executeGh = runGh } = {}) {
  const config = configFrom(env);
  const readAllowed = (repo) => Boolean(config.repos?.has(repo));
  const pointerAllowed = (issue) => Boolean(config.pointers?.has(String(issue)));
  const writeAllowed = (repo, issue, protocol) => config.writesValid && config.writes.has(`${repo}#${issue}#${protocol}`);
  const request = async (args, input) => {
    try {
      const result = await executeGh(args, input);
      return result?.ok === true ? result : { ok: false, code: "GH_REQUEST_FAILED" };
    } catch {
      return { ok: false, code: "GH_REQUEST_FAILED" };
    }
  };
  const getIssue = async (repo, issue) => request(["api", `repos/${repo}/issues/${issue}`]);
  const getComments = async (repo, issue) => {
    const result = await request(["api", commentEndpoint(repo, issue), "--paginate", "--slurp"]);
    if (!result.ok || !Array.isArray(result.value)) return { ok: false };
    return { ok: true, value: result.value.flat(Infinity) };
  };
  const findExistingReceipt = (comments, envelope) => {
    const keyed = comments.flatMap((comment) => {
      const value = parseReceipt(comment);
      return value?.repo === envelope.repo && value?.issue === envelope.issue && value?.idempotency_key === envelope.idempotency_key
        ? [{ comment, value }]
        : [];
    });
    if (!keyed.length) return { found: false };
    if (keyed.length !== 1 || !isDeepStrictEqual(canonical(keyed[0].value), envelope)) return { conflict: true };
    return { found: true, comment: keyed[0].comment };
  };
  const passReceipt = (comment, existing = false, reconciled = false) => ({
    state: "PASS",
    receipt_id: String(comment.id),
    read_back: true,
    existing,
    ...(reconciled ? { reconciled_after_uncertain_post: true } : {}),
  });
  let writeQueue = Promise.resolve();
  const serializeWrite = (operation) => {
    const next = writeQueue.then(operation, operation);
    writeQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  async function writeReceipt(input) {
    return serializeWrite(async () => {
      if (!input || typeof input.repo !== "string" || !Number.isInteger(input.issue) || typeof input.protocol !== "string") return blocked("BLOCKED_RECEIPT_INPUT_INVALID");
      if (!readAllowed(input.repo) || !writeAllowed(input.repo, input.issue, input.protocol)) return blocked("BLOCKED_GITHUB_WRITE_NOT_ALLOWLISTED");
      let payload;
      try { payload = canonical(input.payload); } catch { return blocked("BLOCKED_RECEIPT_PAYLOAD_INVALID"); }
      if (!payload || Array.isArray(payload) || typeof payload !== "object" || typeof payload.idempotency_key !== "string" || payload.idempotency_key.length < 1) {
        return blocked("BLOCKED_RECEIPT_IDEMPOTENCY_KEY_REQUIRED");
      }
      const envelope = canonical({
        protocol: input.protocol,
        repo: input.repo,
        issue: input.issue,
        idempotency_key: payload.idempotency_key,
        payload,
      });
      const body = receiptMarker + JSON.stringify(envelope);
      if (body.length > 24_000) return blocked("BLOCKED_RECEIPT_TOO_LARGE");

      const priorComments = await getComments(input.repo, input.issue);
      if (!priorComments.ok) return blocked("BLOCKED_GITHUB_READ");
      const prior = findExistingReceipt(priorComments.value, envelope);
      if (prior.conflict) return blocked("BLOCKED_RECEIPT_IDEMPOTENCY_CONFLICT");
      if (prior.found) return passReceipt(prior.comment, true);

      const post = await request(["api", commentEndpoint(input.repo, input.issue), "-X", "POST", "--input", "-"], JSON.stringify({ body }));
      if (!post.ok || !Number.isSafeInteger(post.value?.id) || post.value.id < 1) {
        const reconciledComments = await getComments(input.repo, input.issue);
        if (!reconciledComments.ok) return blocked("BLOCKED_RECEIPT_POST_UNCERTAIN");
        const reconciled = findExistingReceipt(reconciledComments.value, envelope);
        if (reconciled.conflict) return blocked("BLOCKED_RECEIPT_IDEMPOTENCY_CONFLICT");
        return reconciled.found ? passReceipt(reconciled.comment, true, true) : blocked("BLOCKED_RECEIPT_POST_UNCERTAIN");
      }

      const readBack = await request(["api", `repos/${input.repo}/issues/comments/${post.value.id}`]);
      if (!readBack.ok || !isDeepStrictEqual(canonical(parseReceipt(readBack.value) ?? {}), envelope)) {
        return blocked("BLOCKED_RECEIPT_READBACK_MISMATCH");
      }
      return passReceipt(readBack.value);
    });
  }

  return {
    bootstrapProject: async ({ repo, current_pointer_issue: pointerIssue } = {}) => {
      if (!readAllowed(repo)) return blocked("BLOCKED_GITHUB_REPO_NOT_ALLOWLISTED");
      if (pointerIssue !== undefined && (!Number.isInteger(pointerIssue) || !pointerAllowed(pointerIssue))) return blocked("BLOCKED_POINTER_ISSUE_NOT_ALLOWLISTED");
      const metadata = await request(["api", `repos/${repo}`]);
      if (!metadata.ok || metadata.value?.full_name?.toLowerCase() !== repo.toLowerCase() || typeof metadata.value?.default_branch !== "string") return blocked("BLOCKED_GITHUB_READ");
      let pointer = null;
      if (pointerIssue !== undefined) {
        const result = await getIssue(repo, pointerIssue);
        if (!result.ok || result.value?.number !== pointerIssue) return blocked("BLOCKED_GITHUB_READ");
        pointer = { number: result.value.number, title: result.value.title, state: result.value.state, html_url: result.value.html_url };
      }
      return { state: "PASS", repository: { full_name: metadata.value.full_name, default_branch: metadata.value.default_branch, html_url: metadata.value.html_url }, pointer_issue: pointer };
    },

    readControlState: async ({ repo, pointer } = {}) => {
      const issue = parseIssuePointer(pointer);
      if (!readAllowed(repo)) return blocked("BLOCKED_GITHUB_REPO_NOT_ALLOWLISTED");
      if (!issue || !pointerAllowed(issue)) return blocked("BLOCKED_POINTER_ISSUE_NOT_ALLOWLISTED");
      const [issueResult, commentsResult] = await Promise.all([getIssue(repo, issue), getComments(repo, issue)]);
      if (!issueResult.ok || issueResult.value?.number !== Number(issue) || !commentsResult.ok) return blocked("BLOCKED_GITHUB_READ");
      const comments = commentsResult.value.filter((comment) => Number.isSafeInteger(comment?.id) && typeof comment?.body === "string");
      const superseded = supersededIds(comments, issue);
      const candidates = comments.filter((comment) => /^state:\s*\S+/im.test(comment.body)).map((comment) => ({
        comment_id: comment.id,
        state: comment.body.match(/^state:\s*(\S+)/im)?.[1] ?? null,
        body: comment.body,
        supersedes: [...comment.body.matchAll(new RegExp(`supersedes:\\s*Issue #${issue} comment (\\d+)`, "ig"))].map((match) => Number(match[1])),
        current: !superseded.has(comment.id),
      }));
      return { state: "PASS", issue: { number: issueResult.value.number, title: issueResult.value.title, state: issueResult.value.state }, candidates };
    },

    writeReceipt,
  };
}
