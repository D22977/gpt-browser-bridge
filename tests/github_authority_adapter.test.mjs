import test from "node:test";
import assert from "node:assert/strict";

const repository = "D22977/gpt-browser-bridge";
const apiRoot = `https://api.github.com/repos/${repository}`;
const instant = "2026-09-28T00:00:00.000Z";

function comment(id, issue, body, repo = repository) {
  return { id: String(id), issue_url: `https://api.github.com/repos/${repo}/issues/${issue}`, body };
}

function authorityRows({ registryStart = "100", startGeneration = "031 ACTIVE_REHYDRATED", registryGeneration = "031 ACTIVE_REHYDRATED", activeGeneration = "031" } = {}) {
  const active = comment(300, 88, `CONTROL_GENERATION_ATOMIC_SWITCH_V1\nrepository: ${repository}\ncurrent_active_generation: ${activeGeneration}\nactive_control_conversation_id: control-${activeGeneration}\nsingle_active_control: true`);
  const start = comment(100, 43, `CURRENT_REHYDRATION_INDEX_V199\nrepository: ${repository}\ncontrol_generation: ${startGeneration}\nwebgpt_route: Issue #88 comment 300 / generation031`);
  const registry = comment(200, 81, `CURRENT_REGISTRY_INDEX_V96\nrepository: ${repository}\nsource_current_start: Issue #43 comment ${registryStart}\ncontrol_generation: ${registryGeneration}`);
  return { comments: new Map([[43, [start]], [81, [registry]], [88, [active]], [162, []]]), exact: new Map([["100", start], ["200", registry], ["300", active]]) };
}

function response(data, link = null, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => name.toLowerCase() === "link" ? link : null }, json: async () => data };
}

function harness({ authority = authorityRows(), pages = new Map(), links = new Map(), extraComments = [], exactOverrides = new Map() } = {}) {
  const calls = [];
  const exact = new Map([...authority.exact, ...extraComments.map((row) => [String(row.id), row])]);
  for (const rows of [...authority.comments.values(), ...pages.values()]) for (const row of rows) exact.set(String(row.id), row);
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    const exactMatch = /\/issues\/comments\/([1-9]\d*)$/.exec(parsed.pathname);
    if (exactMatch) return response(exactOverrides.get(exactMatch[1]) ?? exact.get(exactMatch[1]) ?? {}, null, exact.has(exactMatch[1]) || exactOverrides.has(exactMatch[1]) ? 200 : 404);
    const listMatch = /\/issues\/(\d+)\/comments$/.exec(parsed.pathname);
    if (listMatch) {
      const issue = Number(listMatch[1]);
      const page = parsed.searchParams.get("page") || "1";
      const key = `${issue}:${page}`;
      return response(pages.get(key) ?? (page === "1" ? authority.comments.get(issue) ?? [] : []), links.get(key) ?? null);
    }
    return response({}, null, 404);
  };
  return { calls, fetchImpl };
}

async function adapter(fetchImpl, config = {}) {
  const { createGitHubAuthorityAdapter } = await import("../src/github_authority_adapter.mjs");
  return createGitHubAuthorityAdapter({ fetchImpl, repository, triggerContractHash: "contract-test", now: instant, ...config });
}

test("adapter import and construction are pure; malformed configuration fails", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected fetch"); };
  try {
    const { createGitHubAuthorityAdapter } = await import("../src/github_authority_adapter.mjs?purity-check=1");
    const injectedFetch = async () => { calls++; throw new Error("unexpected injected fetch"); };
    createGitHubAuthorityAdapter({ fetchImpl: injectedFetch, repository, triggerContractHash: "contract-test", now: instant });
    assert.equal(calls, 0);
    assert.throws(() => createGitHubAuthorityAdapter({ fetchImpl: injectedFetch, repository: "bad", triggerContractHash: "x", now: instant }), /MALFORMED_ADAPTER_CONFIG/);
    assert.throws(() => createGitHubAuthorityAdapter({ fetchImpl: injectedFetch, repository, triggerContractHash: "", now: instant }), /MALFORMED_ADAPTER_CONFIG/);
    assert.throws(() => createGitHubAuthorityAdapter({ fetchImpl: injectedFetch, repository, triggerContractHash: "x", now: "bad" }), /MALFORMED_ADAPTER_CONFIG/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pagination completes every page and fails closed on incomplete or invalid chains", async () => {
  const fillers = Array.from({ length: 100 }, (_, i) => comment(1000 + i, 43, `old comment ${i}`));
  const current = authorityRows();
  const pages = new Map([["43:1", fillers], ["43:2", current.comments.get(43)]]);
  const links = new Map([
    ["43:1", `<${apiRoot}/issues/43/comments?per_page=100&page=2>; rel="next", <${apiRoot}/issues/43/comments?per_page=100&page=1>; rel="first", <${apiRoot}/issues/43/comments?per_page=100&page=2>; rel="last"`],
    ["43:2", `<${apiRoot}/issues/43/comments?per_page=100&page=1>; rel="prev", <${apiRoot}/issues/43/comments?per_page=100&page=1>; rel="first", <${apiRoot}/issues/43/comments?per_page=100&page=2>; rel="last"`],
  ]);
  const complete = harness({ authority: current, pages, links });
  assert.equal((await (await adapter(complete.fetchImpl)).readAuthority()).control_generation, "031");
  assert.ok(complete.calls.some(({ url }) => url === `${apiRoot}/issues/43/comments?per_page=100&page=2`));

  const failCases = [
    { data: fillers, link: `<${apiRoot}/issues/43/comments?per_page=100&page=2>; rel="last"` },
    { data: [current.comments.get(43)[0]], link: `<${apiRoot}/issues/43/comments?per_page=100&page=2>; rel="next", <${apiRoot}/issues/43/comments?per_page=100&page=2>; rel="last"` },
    { data: fillers, link: `<https://example.invalid/issues/43/comments?per_page=100&page=2>; rel="next", <${apiRoot}/issues/43/comments?per_page=100&page=2>; rel="last"` },
  ];
  for (const item of failCases) {
    const bad = harness({ authority: current, pages: new Map([["43:1", item.data]]), links: new Map([["43:1", item.link]]) });
    await assert.rejects((await adapter(bad.fetchImpl)).readAuthority(), /INCOMPLETE_GITHUB_PAGINATION/);
  }
});

test("receipt parsing validates comment provenance and recognized source fields", async () => {
  const body = `GITHUB_SOURCE_EVENT_V1\nsource_repo: ${repository}\nsource_issue: 162\nsource_comment_id: 400\nsource_event_type: PROGRESS\ncontrol_generation: 031\nactive_control_conversation_id: control-031`;
  const source = comment(400, 162, body);
  const good = harness({ extraComments: [source] });
  const parsed = await (await adapter(good.fetchImpl)).getReceipt("400");
  assert.equal(parsed.type, "GITHUB_SOURCE_EVENT_V1");
  assert.equal(parsed.github_comment_id, "400");
  assert.equal(parsed.source_issue, 162);

  const wrongRepo = harness({ extraComments: [comment(401, 162, body.replace("source_comment_id: 400", "source_comment_id: 401"), "someone/else")] });
  await assert.rejects((await adapter(wrongRepo.fetchImpl)).getReceipt("401"), /RECEIPT_READBACK_MISMATCH/);
  const mismatchedIssue = harness({ extraComments: [comment(402, 162, body.replace("source_comment_id: 400", "source_comment_id: 402").replace("source_issue: 162", "source_issue: 161"))] });
  await assert.rejects((await adapter(mismatchedIssue.fetchImpl)).getReceipt("402"), /MALFORMED_SOURCE_EVENT/);
  const duplicateField = harness({ extraComments: [comment(403, 162, `${body.replace("source_comment_id: 400", "source_comment_id: 403")}\ncontrol_generation: 031`)] });
  await assert.rejects((await adapter(duplicateField.fetchImpl)).getReceipt("403"), /MALFORMED_RECOGNIZED_RECEIPT/);
});

test("current authority requires the exact start, registry pointer, generation, and switch", async () => {
  const good = harness();
  assert.deepEqual(await (await adapter(good.fetchImpl)).readAuthority(), {
    control_generation: "031",
    active_control_conversation_id: "control-031",
    current_start_receipt: "43:100",
    current_registry_receipt: "81:200",
    active_switch_receipt: "88:300",
    switch_conflict: false,
  });

  const badPointer = harness({ authority: authorityRows({ registryStart: "101" }) });
  await assert.rejects((await adapter(badPointer.fetchImpl)).readAuthority(), /AUTHORITY_POINTER_MISMATCH/);
  const badGeneration = harness({ authority: authorityRows({ registryGeneration: "030 ACTIVE_REHYDRATED" }) });
  await assert.rejects((await adapter(badGeneration.fetchImpl)).readAuthority(), /AUTHORITY_CONFLICT_OR_MALFORMED/);
});

test("one-shot caller is inert on import and routes only through mocked fetch", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return response({}, null, 401);
  };
  try {
    const { main } = await import("../scripts/github_authority_once.mjs?caller-check=1");
    assert.equal(calls.length, 0);
    await assert.rejects(main([], {}), /USAGE/);
    assert.equal(calls.length, 0);
    await assert.rejects(main(["--resident-instance-id", "worker-test", "--trigger-contract-hash", "contract-test"], {}), /GITHUB_AUTH_OR_RATE_LIMIT/);
    assert.deepEqual(calls.map(({ url }) => new URL(url).pathname).sort(), [
      `/repos/${repository}/issues/43/comments`,
      `/repos/${repository}/issues/81/comments`,
      `/repos/${repository}/issues/88/comments`,
    ].sort());
    assert.ok(calls.every(({ init }) => !Object.hasOwn(init.headers, "Authorization")));
    assert.ok(calls.every(({ init }) => init.redirect === "error"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
