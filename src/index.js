/**
 * Action entrypoint. Reads inputs, dispatches on `operation` (apply | validate),
 * writes the job summary, sets outputs, and fails the step on errors.
 *
 * All logic lives in src/operations.js and the core modules; this file is the thin
 * @actions/core I/O layer.
 */
import * as core from "@actions/core";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runApply, runValidate } from "./operations.js";
import { resolveConfigPath } from "./config-path.js";
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  classifyLogMessage,
  isValidLogLevel,
  normalizeLogLevel,
  shouldEmitLogMessage,
} from "./logging.js";

async function writeSummary(markdown) {
  try {
    await core.summary.addRaw(markdown).write();
  } catch (error) {
    core.warning(`Could not write job summary: ${error.message}`);
    core.info(markdown);
  }
  try {
    const path = join(process.env.RUNNER_TEMP || process.cwd(), "copilot-finops-summary.md");
    writeFileSync(path, markdown);
    core.setOutput("summary-path", path);
  } catch {
    // best-effort: the job summary is the primary output
  }
}

/** default true; only an explicit "false" goes live. */
function parseDryRun(value) {
  return String(value ?? "").trim().toLowerCase() !== "false";
}

/** Parse the max-retries input; default 10. */
function parseMaxRetries(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 10;
}

/** Parse the log-level input; default info. */
function parseLogLevel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return DEFAULT_LOG_LEVEL;
  if (!isValidLogLevel(raw)) {
    core.warning(`Unknown log-level "${raw}"; using "${DEFAULT_LOG_LEVEL}". Supported values: ${LOG_LEVELS.join(", ")}.`);
  }
  return normalizeLogLevel(raw);
}

function writeActionLog(message, logLevel) {
  if (!shouldEmitLogMessage(message, logLevel)) return;
  const messageLevel = classifyLogMessage(message);
  if (messageLevel === "error") core.error(message);
  else if (messageLevel === "warn") core.warning(message);
  else if (messageLevel === "debug") core.info(`[debug] ${message}`);
  else core.info(message);
}

export async function main() {
  try {
    const operation = (core.getInput("operation") || "apply").trim();
    const configFile = resolveConfigPath(core.getInput("config-file"));

    if (operation === "validate") {
      const { valid, errors, markdown } = runValidate({ configFile });
      core.setOutput("changed", "false");
      await writeSummary(markdown);
      if (valid) core.info(`${configFile} is valid.`);
      else core.setFailed(`${configFile} is invalid (${errors.length} error(s)).`);
      return;
    }

    if (operation === "apply") {
      const enterprise = core.getInput("enterprise");
      const token = core.getInput("token");
      const dryRun = parseDryRun(core.getInput("dry-run"));
      const maxRetries = parseMaxRetries(core.getInput("max-retries"));
      const configuredLogLevel = parseLogLevel(core.getInput("log-level"));
      const logLevel = configuredLogLevel;
      const { markdown, text, changed, hasErrors } = await runApply({
        configFile,
        enterprise,
        token,
        dryRun,
        maxRetries,
        onLog: (message) => writeActionLog(message, logLevel),
        verbose: logLevel === "debug",
      });
      core.setOutput("changed", String(changed));
      await writeSummary(markdown);
      if (shouldEmitLogMessage(text, logLevel)) core.info(text);
      core.info(`Apply ${dryRun ? "(dry-run)" : "(live)"} complete: changed=${changed}.`);
      if (hasErrors) core.setFailed("One or more budgets failed to apply (see the report).");
      return;
    }

    core.setFailed(`Unknown operation "${operation}" (expected: apply | validate).`);
  } catch (error) {
    core.setFailed(error.message);
  }
}

main();
