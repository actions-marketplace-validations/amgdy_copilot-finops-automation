/**
 * GitHub API client for the Copilot FinOps action.
 *
 * A thin wrapper over the Octokit that @actions/github provides. It injects the
 * billing API version header, retries any call that hits a GitHub rate limit
 * (403/429) — honoring `retry-after` / `x-ratelimit-reset`, else exponential
 * backoff, up to `maxRetries` times — and paginates list responses via the
 * billing endpoints' `has_next_page` body field or standard Link headers. An
 * empty `200` is a genuinely empty list (no retry); rate limiting returns
 * 403/429, never an empty `200`.
 */
import { getOctokit } from "@actions/github";
import { setTimeout as sleep } from "node:timers/promises";

/** Latest GA billing (budgets + cost centers) REST API version. */
export const DEFAULT_API_VERSION = "2026-03-10";
/** Default max retries for rate-limited calls. */
export const DEFAULT_MAX_RETRIES = 10;

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const SENSITIVE_PARAM = /authorization|token|secret|password/i;

function redactForLog(value) {
  if (Array.isArray(value)) return value.map(redactForLog);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SENSITIVE_PARAM.test(key) ? "<redacted>" : redactForLog(item)]),
  );
}

function requestParamsForLog(params) {
  const { headers: _headers, ...safeParams } = params || {};
  return JSON.stringify(redactForLog(safeParams));
}

/**
 * Create a GitHub client from a token.
 * @param {string} token - A token with admin:enterprise for apply operations.
 * @param {{ baseUrl?: string, apiVersion?: string, log?: (m: string) => void, maxRetries?: number }} [options]
 * @returns {GitHubClient}
 */
export function createGitHubClient(token, { baseUrl, apiVersion = DEFAULT_API_VERSION, log, maxRetries } = {}) {
  if (!token) {
    throw new Error("A GitHub token with admin:enterprise is required for this operation.");
  }
  const options = {};
  if (baseUrl) options.baseUrl = baseUrl;
  const octokit = getOctokit(token, options);
  // Optional request tracing: log every REST call and its status/errors.
  if (typeof log === "function") {
    octokit.hook.before("request", (req) => log(`\u2192 ${req.method} ${req.url}`));
    octokit.hook.after("request", (res, req) => log(`\u2190 ${res.status} ${req.method} ${req.url}`));
    octokit.hook.error("request", (error, req) => {
      log(`\u2717 ${error.status ?? "ERR"} ${req.method} ${req.url}: ${error.message}`);
      throw error;
    });
  }
  return new GitHubClient(octokit, apiVersion, log, { maxRetries });
}

/** Is this error a GitHub rate-limit response (primary or secondary)? */
export function isRateLimited(error) {
  const status = error?.status;
  if (status !== 403 && status !== 429) return false;
  const headers = error?.response?.headers || {};
  const remaining = headers["x-ratelimit-remaining"];
  const hasRetryAfter = headers["retry-after"] != null;
  const message = String(error?.message || "");
  // A plain permission 403 has none of these; a rate-limit 403/429 has at least one.
  return hasRetryAfter || remaining === "0" || /rate limit|secondary rate/i.test(message);
}

/** How long to wait before retrying a rate-limited request, in ms. */
export function rateLimitWaitMs(error, attempt, baseDelayMs = BASE_BACKOFF_MS) {
  const headers = error?.response?.headers || {};
  // 1) retry-after (seconds): the API tells us exactly how long to wait.
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  // 2) x-ratelimit-reset (UTC epoch seconds) when the primary budget is exhausted.
  if (headers["x-ratelimit-remaining"] === "0") {
    const reset = Number(headers["x-ratelimit-reset"]);
    if (Number.isFinite(reset)) {
      const ms = reset * 1000 - Date.now();
      if (ms > 0) return Math.min(ms, MAX_BACKOFF_MS);
    }
  }
  // 3) exponential backoff.
  return Math.min(baseDelayMs * 2 ** attempt, MAX_BACKOFF_MS);
}

export class GitHubClient {
  /**
   * @param {import("@actions/github/lib/utils.js").GitHub} octokit
   * @param {string} apiVersion
   * @param {(message: string) => void} [log]
   * @param {{ maxRetries?: number, baseDelayMs?: number }} [options]
   */
  constructor(octokit, apiVersion = DEFAULT_API_VERSION, log, { maxRetries = DEFAULT_MAX_RETRIES, baseDelayMs = BASE_BACKOFF_MS } = {}) {
    this.octokit = octokit;
    this.apiVersion = apiVersion;
    this.log = typeof log === "function" ? log : undefined;
    this.maxRetries = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : DEFAULT_MAX_RETRIES;
    this.baseDelayMs = baseDelayMs;
  }

  /** Default headers (billing API version) merged into every request. */
  #headers(extra) {
    return { "X-GitHub-Api-Version": this.apiVersion, ...extra };
  }

  /**
   * Make a single REST request, retrying on rate limits (403/429). All domain
   * calls (reads, writes, pagination pages) go through here, so every GitHub
   * call is rate-limit-aware.
   * @param {string} route - e.g. "POST /enterprises/{enterprise}/settings/billing/budgets".
   * @param {object} [params]
   */
  async request(route, params = {}) {
    const { headers, ...rest } = params;
    const merged = { headers: this.#headers(headers), ...rest };
    for (let attempt = 0; ; attempt++) {
      try {
        this.log?.(`DEBUG request ${route} attempt=${attempt + 1} params=${requestParamsForLog(rest)}`);
        const response = await this.octokit.request(route, merged);
        this.log?.(`DEBUG request ${route} succeeded attempt=${attempt + 1} status=${response?.status ?? "unknown"}`);
        return response;
      } catch (error) {
        this.log?.(`DEBUG request ${route} failed attempt=${attempt + 1} status=${error.status ?? "ERR"}: ${error.message}`);
        if (attempt < this.maxRetries && isRateLimited(error)) {
          const waitMs = rateLimitWaitMs(error, attempt, this.baseDelayMs);
          this.log?.(
            `rate limited on ${route} (${error.status}); retry ${attempt + 1}/${this.maxRetries} in ${Math.round(waitMs / 1000)}s`,
          );
          await sleep(waitMs);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Paginate a list route, following the billing endpoints' body-level
   * `has_next_page` signal or standard Link headers. Items come from an envelope
   * key (e.g. "budgets", "costCenters") or a bare array. Returns a flat array.
   * An empty `200` yields an empty array (no retry — empty means empty).
   * @param {string} route
   * @param {object} params
   * @param {string} envelopeKey
   * @returns {Promise<object[]>}
   */
  async paginateEnvelope(route, params, envelopeKey) {
    const { headers, per_page = 100, ...rest } = params;
    const all = [];
    for (let page = 1; page <= 1000; page++) {
      this.log?.(`DEBUG paginate ${route}: requesting page=${page}, per_page=${per_page}, envelope=${envelopeKey}`);
      const res = await this.request(route, { ...rest, per_page, page, headers });
      const body = res?.data;
      const items = Array.isArray(body)
        ? body
        : Array.isArray(body?.[envelopeKey])
          ? body[envelopeKey]
          : [];
      all.push(...items);
      const linkHasNext = /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(res?.headers?.link || "");
      const hasNext = typeof body?.has_next_page === "boolean" ? body.has_next_page : linkHasNext;
      this.log?.(
        `DEBUG paginate ${route}: page=${page} returned=${items.length}, accumulated=${all.length}, has_next_page=${hasNext}, total_count=${body?.total_count ?? "unknown"}`,
      );
      if (!hasNext || items.length === 0) break;
    }
    return all;
  }
}
