import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApply, runValidate } from "../src/operations.js";
import { resolveConfigPath, DEFAULT_CONFIG_FILE } from "../src/config-path.js";
import { renderValidateReport } from "../src/report.js";
import { FakeClient } from "./helpers/fake-client.js";

function tmpConfig(contents) {
  const dir = mkdtempSync(join(tmpdir(), "finops-"));
  const path = join(dir, "copilot-finops.yml");
  writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const VALID = `version: 3
budgets:
  - name: base
    scope: all_users
    amount: 30
  - name: platform
    scope: team
    team: platform
    amount: 25
`;

const INVALID = `version: 3
budgets:
  - scope: all_users
    amount: 30
  - scope: all_users
    amount: 40
`;

test("runValidate: valid config", () => {
  const { path, cleanup } = tmpConfig(VALID);
  try {
    const { valid, errors, markdown } = runValidate({ configFile: path });
    assert.equal(valid, true);
    assert.equal(errors.length, 0);
    assert.match(markdown, /Config is valid/);
  } finally {
    cleanup();
  }
});

test("runValidate: invalid config renders an error table", () => {
  const { path, cleanup } = tmpConfig(INVALID);
  try {
    const { valid, markdown } = runValidate({ configFile: path });
    assert.equal(valid, false);
    assert.match(markdown, /Config is invalid/);
    assert.match(markdown, /at most one all_users/);
  } finally {
    cleanup();
  }
});

test("runApply: dry-run with injected client returns a report", async () => {
  const { path, cleanup } = tmpConfig(VALID);
  try {
    const client = new FakeClient();
    const { markdown, changed, hasErrors, result } = await runApply({
      configFile: path,
      enterprise: "ent",
      dryRun: true,
      client,
    });
    assert.match(markdown, /Apply report/);
    assert.equal(hasErrors, false);
    assert.equal(changed, true); // all_users CREATE + team would-create
    assert.ok(result.actions.length >= 1);
    assert.equal(client.requests.length, 0); // dry-run writes nothing
  } finally {
    cleanup();
  }
});

test("runApply: verbose controls debug detail in the report log", async () => {
  const { path, cleanup } = tmpConfig(VALID);
  try {
    const quiet = await runApply({
      configFile: path,
      enterprise: "ent",
      dryRun: true,
      client: new FakeClient(),
    });
    assert.doesNotMatch(quiet.result.log.join("\n"), /^DEBUG /m);

    const verbose = await runApply({
      configFile: path,
      enterprise: "ent",
      dryRun: true,
      client: new FakeClient(),
      verbose: true,
    });
    assert.match(verbose.result.log.join("\n"), /^DEBUG /m);
  } finally {
    cleanup();
  }
});

test("runApply: requires an enterprise", async () => {
  const { path, cleanup } = tmpConfig(VALID);
  try {
    await assert.rejects(() => runApply({ configFile: path, enterprise: "", client: new FakeClient() }), /enterprise/);
  } finally {
    cleanup();
  }
});

test("runApply: rejects an invalid config before any API call", async () => {
  const { path, cleanup } = tmpConfig(INVALID);
  try {
    const client = new FakeClient();
    await assert.rejects(() => runApply({ configFile: path, enterprise: "ent", client }), /validation failed/);
    assert.equal(client.requests.length, 0);
  } finally {
    cleanup();
  }
});

test("resolveConfigPath: default + missing file", () => {
  assert.throws(() => resolveConfigPath("nope/does-not-exist.yml"), /config file not found/);
  assert.equal(DEFAULT_CONFIG_FILE, "config/copilot-finops.yml");
});

test("renderValidateReport: valid and invalid", () => {
  assert.match(renderValidateReport("c.yml", true, []), /Config is valid/);
  const bad = renderValidateReport("c.yml", false, [{ path: "budgets[0].scope", message: "bad" }]);
  assert.match(bad, /Config is invalid/);
  assert.match(bad, /budgets\[0\]\.scope/);
});
