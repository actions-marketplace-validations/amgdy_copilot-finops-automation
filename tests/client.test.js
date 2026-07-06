import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubClient, GitHubClient, DEFAULT_API_VERSION, DEFAULT_MAX_RETRIES, isRateLimited, rateLimitWaitMs } from "../src/github/client.js";

test("createGitHubClient: requires a token", () => {
  assert.throws(() => createGitHubClient(""), /token with admin:enterprise is required/);
  assert.throws(() => createGitHubClient(undefined), /token with admin:enterprise is required/);
});

test("createGitHubClient: returns a GitHubClient with request + paginate helpers", () => {
  const client = createGitHubClient("ghs_faketoken");
  assert.ok(client instanceof GitHubClient);
  assert.equal(typeof client.request, "function");
  assert.equal(typeof client.paginateEnvelope, "function");
  assert.equal(client.apiVersion, DEFAULT_API_VERSION);
  assert.equal(typeof client.octokit.request, "function");
  assert.equal(typeof client.octokit.paginate, "function");
});

test("createGitHubClient: honors an apiVersion override", () => {
  const client = createGitHubClient("ghs_faketoken", { apiVersion: "2099-01-01" });
  assert.equal(client.apiVersion, "2099-01-01");
});

test("paginateEnvelope: follows the billing has_next_page signal across pages", async () => {
  const pages = [
    { budgets: [{ id: 1 }, { id: 2 }], has_next_page: true, total_count: 3 },
    { budgets: [{ id: 3 }], has_next_page: false, total_count: 3 },
  ];
  const octokit = { request: async (_route, params) => ({ data: pages[params.page - 1], headers: {} }) };
  const client = new GitHubClient(octokit, "v");
  const items = await client.paginateEnvelope("GET /x", { enterprise: "e", per_page: 2 }, "budgets");
  assert.deepEqual(items.map((b) => b.id), [1, 2, 3]);
});

test("paginateEnvelope: empty envelope stops after one page", async () => {
  let calls = 0;
  const octokit = {
    request: async () => {
      calls++;
      return { data: { budgets: [], has_next_page: false, total_count: 0 }, headers: {} };
    },
  };
  const client = new GitHubClient(octokit, "v");
  const items = await client.paginateEnvelope("GET /x", { enterprise: "e" }, "budgets");
  assert.deepEqual(items, []);
  assert.equal(calls, 1);
});

test("paginateEnvelope: follows Link header for array responses", async () => {
  let call = 0;
  const octokit = {
    request: async () => {
      call++;
      if (call === 1) return { data: [{ id: 1 }], headers: { link: '<https://api/x?page=2>; rel="next"' } };
      return { data: [{ id: 2 }], headers: {} };
    },
  };
  const client = new GitHubClient(octokit, "v");
  const items = await client.paginateEnvelope("GET /x", { enterprise: "e" }, "budgets");
  assert.deepEqual(items.map((i) => i.id), [1, 2]);
});

test("request and pagination emit detailed debug logs without headers", async () => {
  const logs = [];
  const octokit = {
    request: async (_route, params) => ({ data: { budgets: [{ id: 1 }], has_next_page: false, total_count: 1 }, headers: {}, status: 200, params }),
  };
  const client = new GitHubClient(octokit, "v", (message) => logs.push(message));
  const items = await client.paginateEnvelope("GET /x", { enterprise: "e", token: "secret", per_page: 10 }, "budgets");
  assert.equal(items.length, 1);
  assert.ok(logs.some((line) => /DEBUG request GET \/x attempt=1 params=/.test(line)));
  assert.ok(logs.some((line) => /"token":"<redacted>"/.test(line)));
  assert.ok(logs.some((line) => /DEBUG paginate GET \/x: page=1 returned=1/.test(line)));
  assert.equal(logs.some((line) => /headers/i.test(line)), false);
});

// ── rate-limit retry ─────────────────────────────────────────────────────────
function rateLimitError({ status = 429, retryAfter, remaining, reset, message = "You have exceeded a secondary rate limit" } = {}) {
  const e = new Error(message);
  e.status = status;
  const headers = {};
  if (retryAfter != null) headers["retry-after"] = String(retryAfter);
  if (remaining != null) headers["x-ratelimit-remaining"] = String(remaining);
  if (reset != null) headers["x-ratelimit-reset"] = String(reset);
  e.response = { headers };
  return e;
}

test("isRateLimited: distinguishes rate limits from plain 403/404s", () => {
  assert.equal(isRateLimited(rateLimitError({ status: 429, retryAfter: 1 })), true);
  assert.equal(isRateLimited(rateLimitError({ status: 403, remaining: 0 })), true);
  assert.equal(isRateLimited(rateLimitError({ status: 403, message: "primary rate limit exceeded" })), true);
  const perm = new Error("Resource not accessible by integration");
  perm.status = 403;
  perm.response = { headers: {} };
  assert.equal(isRateLimited(perm), false);
  const notFound = new Error("Not Found");
  notFound.status = 404;
  assert.equal(isRateLimited(notFound), false);
});

test("rateLimitWaitMs: prefers retry-after, then reset, then exponential backoff", () => {
  assert.equal(rateLimitWaitMs(rateLimitError({ retryAfter: 3 }), 0, 1000), 3000);
  const soon = Math.floor(Date.now() / 1000) + 5;
  const w = rateLimitWaitMs(rateLimitError({ remaining: 0, reset: soon }), 0, 1000);
  assert.ok(w > 3000 && w <= 5000, `reset wait was ${w}`);
  assert.equal(rateLimitWaitMs(new Error("no headers"), 3, 1000), 8000); // 1000 * 2^3
});

test("request: retries a rate-limited call, then succeeds", async () => {
  let calls = 0;
  const octokit = {
    request: async () => {
      calls++;
      if (calls <= 2) throw rateLimitError({ status: 429, retryAfter: 0 });
      return { data: { ok: 1 }, headers: {} };
    },
  };
  const client = new GitHubClient(octokit, "v", undefined, { maxRetries: 5, baseDelayMs: 0 });
  const res = await client.request("GET /x", { enterprise: "e" });
  assert.equal(res.data.ok, 1);
  assert.equal(calls, 3);
});

test("request: does NOT retry a non-rate-limit 403", async () => {
  let calls = 0;
  const octokit = {
    request: async () => {
      calls++;
      const e = new Error("Resource not accessible by integration");
      e.status = 403;
      e.response = { headers: {} };
      throw e;
    },
  };
  const client = new GitHubClient(octokit, "v", undefined, { maxRetries: 5, baseDelayMs: 0 });
  await assert.rejects(() => client.request("GET /x", {}), /not accessible/);
  assert.equal(calls, 1);
});

test("request: gives up after maxRetries", async () => {
  let calls = 0;
  const octokit = { request: async () => { calls++; throw rateLimitError({ status: 429, retryAfter: 0 }); } };
  const client = new GitHubClient(octokit, "v", undefined, { maxRetries: 3, baseDelayMs: 0 });
  await assert.rejects(() => client.request("GET /x", {}), /rate limit/i);
  assert.equal(calls, 4); // initial + 3 retries
});

test("DEFAULT_MAX_RETRIES is 10", () => {
  assert.equal(DEFAULT_MAX_RETRIES, 10);
});
