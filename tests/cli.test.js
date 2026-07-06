import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "../bin/copilot-finops.js");
const CONFIG = join(here, "../config/copilot-finops.example.yml");

/** process.env with the enterprise/token keys removed (so only a .env can set them). */
function cleanEnv() {
  const env = { ...process.env };
  delete env.COPILOT_FINOPS_ENTERPRISE;
  delete env.COPILOT_FINOPS_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

/** Run the CLI in an isolated temp cwd (no ambient .env) unless one is provided. */
function runCli(argv, { cwd } = {}) {
  const dir = cwd || mkdtempSync(join(tmpdir(), "finops-cli-"));
  try {
    const stdout = execFileSync("node", [BIN, ...argv], { encoding: "utf8", cwd: dir, env: cleanEnv() });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout || "", stderr: e.stderr || "" };
  } finally {
    if (!cwd) rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI validate: valid config exits 0", () => {
  const r = runCli(["validate", CONFIG]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /is valid/);
});

test("CLI apply: requires an enterprise (no network)", () => {
  const r = runCli(["apply", CONFIG]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /enterprise/);
});

test("CLI apply: requires a token once enterprise is set (no network)", () => {
  const r = runCli(["apply", CONFIG, "--enterprise", "acme"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /token/);
});

test("CLI apply: reads enterprise from a .env file in the working dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "finops-env-"));
  try {
    writeFileSync(join(dir, ".env"), "COPILOT_FINOPS_ENTERPRISE=acme-from-dotenv\n");
    // enterprise now comes from .env, so it gets past the enterprise check and
    // fails on the missing token — proving the .env was loaded.
    const r = runCli(["apply", CONFIG], { cwd: dir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: unknown command prints usage and exits 2", () => {
  const r = runCli(["frobnicate"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage/);
});

test("CLI apply: forwards --max-retries to runApply", () => {
  const source = readFileSync(BIN, "utf8");
  assert.match(source, /runApply\(\{[^}]*maxRetries/s);
});
