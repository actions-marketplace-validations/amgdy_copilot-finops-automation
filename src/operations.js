/**
 * Operation orchestration for the action's two operations.
 *
 *   runApply    — apply desired budget state (dry-run = drift/audit). Requires a token
 *                 (or an injected client) and an enterprise slug.
 *   runValidate — schema + semantic lint of the config file. No token, no API.
 *
 * Both are thin: load the config, run the relevant core module, render a
 * markdown job summary. The @actions/core I/O lives in src/index.js so these
 * stay unit-testable (runApply accepts an injected client).
 */
import { loadConfigFile } from "./config/load.js";
import { validateConfig, formatValidationErrors } from "./config/validate.js";
import { createGitHubClient } from "./github/client.js";
import { applyBudgets } from "./apply-engine.js";
import { renderReport, renderTextReport, renderValidateReport } from "./report.js";

/**
 * Validate a config file (token-free).
 * @param {{ configFile: string }} args
 * @returns {{ valid: boolean, errors: object[], markdown: string }}
 */
export function runValidate({ configFile }) {
  const doc = loadConfigFile(configFile);
  const { valid, errors } = validateConfig(doc);
  return { valid, errors, markdown: renderValidateReport(configFile, valid, errors) };
}

/**
 * Apply budgets (apply operation). Validates first, then applies desired state.
 * @param {object} args
 * @param {string} args.configFile
 * @param {string} args.enterprise
 * @param {string} [args.token]
 * @param {boolean} [args.dryRun]
 * @param {string} [args.apiVersion]
 * @param {string} [args.baseUrl]
 * @param {import("./github/client.js").GitHubClient} [args.client] - Injected client (tests).
 * @returns {Promise<{ result: object, markdown: string, text: string, changed: boolean, hasErrors: boolean }>}
 */
export async function runApply({ configFile, enterprise, token, dryRun = true, apiVersion, baseUrl, client, onLog, verbose = false, maxRetries }) {
  if (!enterprise) {
    throw new Error("The `enterprise` input is required for the apply operation.");
  }

  const doc = loadConfigFile(configFile);
  const { valid, errors } = validateConfig(doc);
  if (!valid) {
    const err = new Error(`config validation failed:\n${formatValidationErrors(errors)}`);
    err.validationErrors = errors;
    throw err;
  }

  const githubClient = client || createGitHubClient(token, { apiVersion, baseUrl, log: verbose ? onLog : undefined, maxRetries });
  const result = await applyBudgets({ client: githubClient, config: doc, enterprise, configSource: configFile, dryRun, onLog, verbose });

  const hasErrors = result.errors.length > 0 || result.actions.some((action) => action.action === "ERROR");
  const changed =
    result.actions.some((action) => action.action === "CREATE" || action.action === "UPDATE") ||
    result.costCentersCreated.length > 0;

  return { result, markdown: renderReport(result), text: renderTextReport(result), changed, hasErrors };
}
