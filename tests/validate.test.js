import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { parseConfig, loadConfigFile, ConfigError } from "../src/config/load.js";
import { validateConfig, formatValidationErrors } from "../src/config/validate.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = yamlLoad(readFileSync(join(here, "cases/v3/copilot-finops.yml"), "utf8"));

test("manifest has cases", () => {
  assert.ok(Array.isArray(manifest.cases) && manifest.cases.length > 0);
});

for (const c of manifest.cases) {
  test(`manifest: ${c.name}`, () => {
    const { valid, errors } = validateConfig(c.config);
    assert.equal(
      valid,
      c.valid,
      `expected valid=${c.valid} for "${c.name}"; errors:\n${formatValidationErrors(errors)}`,
    );
    if (c.valid) {
      assert.equal(errors.length, 0, `valid case "${c.name}" should have no errors`);
    } else {
      assert.ok(errors.length > 0, `invalid case "${c.name}" must produce at least one error`);
      if (c.expect_error) {
        const hit = errors.some(
          (e) => e.message.includes(c.expect_error) || e.path.includes(c.expect_error),
        );
        assert.ok(
          hit,
          `case "${c.name}" expected an error containing "${c.expect_error}"; got:\n${formatValidationErrors(errors)}`,
        );
      }
    }
  });
}

test("parseConfig: empty document -> {}", () => {
  assert.deepEqual(parseConfig(""), {});
  assert.deepEqual(parseConfig("\n\n"), {});
  assert.deepEqual(parseConfig("# only a comment\n"), {});
});

test("parseConfig: top-level list is rejected", () => {
  assert.throws(() => parseConfig("- a\n- b"), ConfigError);
});

test("parseConfig: invalid YAML throws ConfigError", () => {
  assert.throws(() => parseConfig("a: [1, 2\n"), ConfigError);
});

test("loadConfigFile: missing file throws ConfigError", () => {
  assert.throws(() => loadConfigFile(join(here, "does-not-exist.yml")), ConfigError);
});

test("validateConfig: non-object input", () => {
  const { valid, errors } = validateConfig("not a mapping");
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
});

test("formatValidationErrors: renders path + message per line", () => {
  const out = formatValidationErrors([{ path: "budgets[0].scope", message: "bad" }]);
  assert.match(out, /budgets\[0\]\.scope: bad/);
});
