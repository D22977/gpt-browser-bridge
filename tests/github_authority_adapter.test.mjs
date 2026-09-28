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

function sourceEvent(id, eventType = "PROGRESS", extraFields = []) {
  return comment(id, 162, [
    "GITHUB_SOURCE_EVENT_V1",
    "source_repo: " + repository,
    "source_issue: 162",
    "source_comment_id: " + id,
    "source_event_type: " + eventType,
    "control_generation: 031",
    "active_control_conversation_id: control-031",
    ...extraFields,
  ].join("\n"));
}

function fullCommentPage(seed) {
  return Array.from({ length: 100 }, (_, i) => comment(seed + i, 43, "old comment " + i));
}

async function assertIncompletePagination(rows, link) {
  const bad = harness({ pages: new Map([["43:1", rows]]), links: new Map([["43:1", link]]) });
  await assert.rejects((await adapter(bad.fetchImpl)).readAuthority(), /INCOMPLETE_GITHUB_PAGINATION/);
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
  const originalProcess = globalThis.process;
  const calls = [];
  let tokenReads = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return response({}, null, 401);
  };
  globalThis.process = new Proxy(originalProcess, {
    get(target, key) {
      if (key === "env") {
        return new Proxy(target.env, {
          get(env, name, receiver) {
            if (name === "GITHUB_TOKEN") {
              tokenReads++;
              return undefined;
            }
            return Reflect.get(env, name, receiver);
          },
        });
      }
      return Reflect.get(target, key, target);
    },
  });
  try {
    const { main } = await import("../scripts/github_authority_once.mjs?caller-check=2");
    assert.equal(tokenReads, 0);
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
    globalThis.process = originalProcess;
    globalThis.fetch = originalFetch;
  }
});

test("pagination rejects a short page whose last relation points past it without next", async () => {
  await assertIncompletePagination(
    [comment(5001, 43, "short page")],
    "<" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"last\"",
  );
});

test("pagination rejects a full page with no valid completion or next signal", async () => {
  await assertIncompletePagination(fullCommentPage(5100), null);
});

test("pagination rejects a next relation that skips the current page successor", async () => {
  await assertIncompletePagination(
    fullCommentPage(5200),
    "<" + apiRoot + "/issues/43/comments?per_page=100&page=3>; rel=\"next\"",
  );
});

test("pagination rejects next on a non-100-row page", async () => {
  await assertIncompletePagination(
    [comment(5301, 43, "short page")],
    "<" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"next\", <" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"last\"",
  );
});

test("pagination rejects duplicate Link relation keys", async () => {
  await assertIncompletePagination(
    fullCommentPage(5400),
    "<" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"next\", <" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"next\"",
  );
});

test("pagination rejects malformed or disallowed Link relations", async () => {
  await assertIncompletePagination(
    fullCommentPage(5500),
    "<" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"unknown\"",
  );
});

test("pagination rejects a Link relation for the wrong issue path", async () => {
  await assertIncompletePagination(
    fullCommentPage(5600),
    "<" + apiRoot + "/issues/44/comments?per_page=100&page=2>; rel=\"next\"",
  );
});

test("pagination rejects the wrong per_page query shape", async () => {
  await assertIncompletePagination(
    fullCommentPage(5700),
    "<" + apiRoot + "/issues/43/comments?per_page=50&page=2>; rel=\"next\"",
  );
});

test("pagination rejects an invalid page target", async () => {
  await assertIncompletePagination(
    fullCommentPage(5800),
    "<" + apiRoot + "/issues/43/comments?per_page=100&page=0>; rel=\"next\"",
  );
});

test("pagination rejects duplicate comment IDs across pages", async () => {
  const firstPage = fullCommentPage(5900);
  const secondPage = [firstPage[0]];
  const pages = new Map([["43:1", firstPage], ["43:2", secondPage]]);
  const links = new Map([
    ["43:1", "<" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"next\", <" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"last\""],
    ["43:2", "<" + apiRoot + "/issues/43/comments?per_page=100&page=1>; rel=\"prev\", <" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"last\""],
  ]);
  const duplicate = harness({ pages, links });
  await assert.rejects((await adapter(duplicate.fetchImpl)).readAuthority(), /DUPLICATE_GITHUB_COMMENT/);
});

test("adapter rejects unsupported recognized receipt fields", async () => {
  const malformed = harness({ extraComments: [sourceEvent("6001", "PROGRESS", ["unsupported_field: value"])] });
  await assert.rejects((await adapter(malformed.fetchImpl)).getReceipt("6001"), /MALFORMED_RECOGNIZED_RECEIPT/);
});

test("adapter rejects TERMINAL source events without a named executor", async () => {
  const malformed = harness({ extraComments: [sourceEvent("6002", "TERMINAL")] });
  await assert.rejects((await adapter(malformed.fetchImpl)).getReceipt("6002"), /MALFORMED_SOURCE_EVENT/);
});

test("adapter rejects CONTROL_NEEDED source events without a named executor", async () => {
  const malformed = harness({ extraComments: [sourceEvent("6003", "CONTROL_NEEDED")] });
  await assert.rejects((await adapter(malformed.fetchImpl)).getReceipt("6003"), /MALFORMED_SOURCE_EVENT/);
});

test("adapter preserves comment IDs beyond Number.MAX_SAFE_INTEGER as decimal strings", async () => {
  const id = "900719925474099312345678901";
  const exact = harness({ extraComments: [sourceEvent(id)] });
  const parsed = await (await adapter(exact.fetchImpl)).getReceipt(id);
  assert.equal(parsed.github_comment_id, id);
  assert.equal(parsed.source_comment_id, id);
});

test("authority rejects a stale WebGPT route switch ID", async () => {
  const authority = authorityRows();
  const start = authority.comments.get(43)[0];
  start.body = start.body.replace("Issue #88 comment 300", "Issue #88 comment 301");
  await assert.rejects((await adapter(harness({ authority }).fetchImpl)).readAuthority(), /AUTHORITY_POINTER_MISMATCH/);
});

test("authority rejects a stale WebGPT route generation", async () => {
  const authority = authorityRows();
  const start = authority.comments.get(43)[0];
  start.body = start.body.replace("generation031", "generation030");
  await assert.rejects((await adapter(harness({ authority }).fetchImpl)).readAuthority(), /AUTHORITY_POINTER_MISMATCH/);
});

test("authority rejects an exact readback body mismatch", async () => {
  const authority = authorityRows();
  const start = authority.comments.get(43)[0];
  const overrides = new Map([["100", { ...start, body: start.body + "\nreadback-mismatch" }]]);
  await assert.rejects((await adapter(harness({ authority, exactOverrides: overrides }).fetchImpl)).readAuthority(), /AUTHORITY_READBACK_MISMATCH/);
});

test("authority rejects an exact readback issue provenance mismatch", async () => {
  const authority = authorityRows();
  const start = authority.comments.get(43)[0];
  const overrides = new Map([["100", { ...start, issue_url: apiRoot + "/issues/81" }]]);
  await assert.rejects((await adapter(harness({ authority, exactOverrides: overrides }).fetchImpl)).readAuthority(), /AUTHORITY_READBACK_MISMATCH/);
});

test("adapter sends only an explicitly supplied synthetic fixture token", async () => {
  const explicit = harness();
  await (await adapter(explicit.fetchImpl, { token: "fixture-token" })).readAuthority();
  assert.ok(explicit.calls.length > 0);
  assert.ok(explicit.calls.every(({ init }) => init.headers.Authorization === "Bearer fixture-token"));

  const omitted = harness();
  await (await adapter(omitted.fetchImpl)).readAuthority();
  assert.ok(omitted.calls.length > 0);
  assert.ok(omitted.calls.every(({ init }) => !Object.hasOwn(init.headers, "Authorization")));
});

test("one-shot caller reaches NO_CURRENT_LEASE through mocked authority and exact readbacks", async () => {
  const originalFetch = globalThis.fetch;
  const mocked = harness();
  globalThis.fetch = mocked.fetchImpl;
  try {
    const { main } = await import("../scripts/github_authority_once.mjs?caller-success=1");
    await assert.rejects(main(["--resident-instance-id", "worker-test", "--trigger-contract-hash", "contract-test"], Object.create(null)), /NO_CURRENT_LEASE/);
    const paths = mocked.calls.map(({ url }) => new URL(url).pathname);
    for (const issue of [43, 81, 88, 162]) {
      assert.ok(paths.includes("/repos/" + repository + "/issues/" + issue + "/comments"));
    }
    for (const id of ["100", "200", "300"]) assert.ok(paths.includes("/repos/" + repository + "/issues/comments/" + id));
    assert.ok(mocked.calls.every(({ init }) => !Object.hasOwn(init.headers, "Authorization")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pagination rejects a Link target for the wrong repository path", async () => {
  await assertIncompletePagination(
    fullCommentPage(6100),
    "<https://api.github.com/repos/D22977/other-repo/issues/43/comments?per_page=100&page=2>; rel=\"next\", <" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"last\"",
  );
});

test("pagination rejects a Link target with an extra query parameter", async () => {
  await assertIncompletePagination(
    fullCommentPage(6200),
    "<" + apiRoot + "/issues/43/comments?per_page=100&page=2&state=all>; rel=\"next\", <" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"last\"",
  );
});

test("pagination rejects a Link target with a duplicate page query key", async () => {
  await assertIncompletePagination(
    fullCommentPage(6300),
    "<" + apiRoot + "/issues/43/comments?per_page=100&page=2&page=2>; rel=\"next\", <" + apiRoot + "/issues/43/comments?per_page=100&page=2>; rel=\"last\"",
  );
});

test("pagination rejects a syntactically malformed Link header", async () => {
  await assertIncompletePagination(fullCommentPage(6400), "not a valid Link header");
});
