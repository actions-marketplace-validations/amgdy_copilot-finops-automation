#!/usr/bin/env node
/**
 * Local CLI for the Copilot FinOps tooling (outside GitHub Actions).
 *
 *   copilot-finops validate [config-file]                     # schema + semantic lint (no token)
 *   copilot-finops migrate  <v2-file> <v3-out>                # v2 -> v3 codemod
 *   copilot-finops apply    [config-file] --enterprise <slug> [--live]
 *                                                             # apply desired budget state (dry-run default)
 *
 * apply reads the token from COPILOT_FINOPS_TOKEN or GITHUB_TOKEN, and the
 * enterprise slug from --enterprise or COPILOT_FINOPS_ENTERPRISE. Even a dry-run
 * reads live budgets/cost centers, so it needs a token with admin:enterprise
 * (read access is enough for dry-run). Exposed via package.json bin.
 */
import process from "node:process";
import { existsSync } from "node:fs";
import { runApply, runValidate } from "../src/operations.js";
import { formatValidationErrors } from "../src/config/validate.js";
import { resolveConfigPath } from "../src/config-path.js";

// Local convenience: load ./.env into process.env if present (Node's built-in
// loader — no dependency). Lets `apply` read COPILOT_FINOPS_TOKEN /
// COPILOT_FINOPS_ENTERPRISE from a gitignored .env. The GitHub Action does NOT
// do this — there env comes from the workflow.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    console.warn(`Could not load .env: ${error.message}`);
  }
}

const [, , command, ...args] = process.argv;

/** Verbose mode: --verbose/-v flag or FINOPS_VERBOSE=1. Streams logs + API traces to stderr. */
const VERBOSE = args.includes("--verbose") || args.includes("-v") || process.env.FINOPS_VERBOSE === "1";

/** Minimal flag parser: --flag, --key value, --key=value; positionals collect in `_`. */
function parseFlags(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--live") flags.live = true;
    else if (arg === "--dry-run") flags.live = false;
    else if (arg === "--verbose" || arg === "-v") flags.verbose = true;
    else if (arg === "--max-retries" || arg === "--retries") flags.maxRetries = Number(argv[++index]);
    else if (arg === "--enterprise" || arg === "--token") flags[arg.slice(2)] = argv[++index];
    else if (arg.startsWith("--enterprise=")) flags.enterprise = arg.slice(13);
    else if (arg.startsWith("--token=")) flags.token = arg.slice(8);
    else if (!arg.startsWith("--")) flags._.push(arg);
  }
  return flags;
}

function usage(code = 2) {
  console.error("Usage:");
  console.error("  copilot-finops validate [config-file]");
  console.error("  copilot-finops migrate  <v2-file> <v3-out>");
  console.error("  copilot-finops apply    [config-file] --enterprise <slug> [--live] [--max-retries N] [--verbose]");
  console.error("");
  console.error("apply reads the token from COPILOT_FINOPS_TOKEN or GITHUB_TOKEN, and the");
  console.error("enterprise from --enterprise or COPILOT_FINOPS_ENTERPRISE. Dry-run by default.");
  console.error("Rate-limited calls are retried (retry-after, else exponential); --max-retries default 10.");
  process.exit(code);
}

async function main() {
  switch (command) {
    case "validate": {
      const file = resolveConfigPath(args[0]);
      const { valid, errors } = runValidate({ configFile: file });
      if (valid) {
        console.log(`\u2713 ${file} is valid.`);
        process.exit(0);
      }
      console.error(`\u2717 ${file} is invalid (${errors.length} error(s)):`);
      console.error(formatValidationErrors(errors));
      process.exit(1);
      break;
    }
    case "migrate": {
      if (args.length < 2) usage();
      const { migrateFile } = await import("../src/migrate.js");
      const { outPath, warnings, enterprise } = migrateFile(args[0], args[1]);
      console.log(`\u2713 Wrote ${outPath}`);
      if (enterprise) {
        console.log(`  Set the action's \`enterprise\` input to: ${enterprise}`);
      }
      for (const warning of warnings) console.warn(`  ! ${warning}`);
      process.exit(0);
      break;
    }
    case "apply": {
      const options = parseFlags(args);
      const verbose = VERBOSE || options.verbose === true;
      const configFile = resolveConfigPath(options._[0]);
      const enterprise = options.enterprise || process.env.COPILOT_FINOPS_ENTERPRISE || "";
      const token = options.token || process.env.COPILOT_FINOPS_TOKEN || process.env.GITHUB_TOKEN || "";
      const dryRun = options.live !== true;
      const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : undefined;
      if (!enterprise) {
        console.error("apply requires an enterprise slug: --enterprise <slug> (or set COPILOT_FINOPS_ENTERPRISE).");
        process.exit(2);
      }
      if (!token) {
        console.error("apply requires a token: set COPILOT_FINOPS_TOKEN or GITHUB_TOKEN (admin:enterprise; read is enough for dry-run).");
        process.exit(2);
      }
      console.error(`Applying ${configFile} to enterprise "${enterprise}" (${dryRun ? "DRY-RUN" : "LIVE"})${verbose ? ", verbose" : ""}...\n`);
      const onLog = verbose ? (message) => console.error(`  ${message}`) : undefined;
      const { text, changed, hasErrors } = await runApply({ configFile, enterprise, token, dryRun, maxRetries, onLog, verbose });
      console.log(text);
      console.error(`\n${dryRun ? "DRY-RUN" : "LIVE"} apply complete: changed=${changed}${hasErrors ? ", hasErrors=true" : ""}.`);
      process.exit(hasErrors ? 1 : 0);
      break;
    }
    default:
      usage();
  }
}

main().catch((error) => {
  console.error(VERBOSE ? error.stack || error.message : error.message);
  process.exit(1);
});
