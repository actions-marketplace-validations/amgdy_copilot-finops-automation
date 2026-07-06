import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { migrateDoc, migrateFile } from "../src/migrate.js";
import { validateConfig } from "../src/config/validate.js";

test("migrateDoc: rejects non-v2 input", () => {
  assert.throws(() => migrateDoc({ version: 1 }), /migrates v2 -> v3/);
  assert.throws(() => migrateDoc({ version: 3 }), /already v3/);
  assert.throws(() => migrateDoc("nope"), /not a config mapping/);
});

test("migrateDoc: extracts enterprise_slug and drops it from the doc", () => {
  const { doc, enterprise } = migrateDoc({ version: 2, enterprise_slug: "acme" });
  assert.equal(enterprise, "acme");
  assert.equal(doc.version, 3);
  assert.equal("enterprise_slug" in doc, false);
});

test("migrateDoc: all_users keeps alerts, no enforce", () => {
  const { doc } = migrateDoc({
    version: 2,
    ai_credit_spend_policies: [{ name: "b", scope: "all_users", amount: 30, alert_admins: ["x"] }],
  });
  assert.deepEqual(doc.budgets[0], { name: "b", scope: "all_users", amount: 30, alerts: ["x"] });
});

test("migrateDoc: enterprise stop_at_limit -> enforce", () => {
  const { doc } = migrateDoc({
    version: 2,
    ai_credit_spend_policies: [{ scope: "enterprise", amount: 5000, stop_at_limit: false }],
  });
  assert.equal(doc.budgets[0].enforce, false);
});

test("migrateDoc: cost_center becomes metered_credits_only", () => {
  const { doc } = migrateDoc({
    version: 2,
    ai_credit_spend_policies: [{ scope: "cost_center", cost_center: "cc", amount: 200, stop_at_limit: false }],
  });
  assert.equal(doc.budgets[0].metered_credits_only, true);
  assert.equal(doc.budgets[0].enforce, false);
});

test("migrateDoc: team pool_then_metered -> default (no metered)", () => {
  const { doc } = migrateDoc({
    version: 2,
    ai_credit_spend_policies: [{ scope: "team", teams: ["platform"], credit_scope: "pool_then_metered", amount: 100 }],
  });
  assert.deepEqual(doc.budgets[0], { scope: "team", team: "platform", amount: 100 });
});

test("migrateDoc: team with multiple teams fans out with unique names", () => {
  const { doc } = migrateDoc({
    version: 2,
    ai_credit_spend_policies: [{ name: "champs", scope: "team", teams: ["a", "b"], credit_scope: "pool_then_metered", amount: 150 }],
  });
  assert.equal(doc.budgets.length, 2);
  assert.deepEqual(doc.budgets.map((x) => x.name).sort(), ["champs-a", "champs-b"]);
  assert.deepEqual(doc.budgets.map((x) => x.team).sort(), ["a", "b"]);
});

test("migrateDoc: team metered_only drops cost_center with a warning", () => {
  const { doc, warnings } = migrateDoc({
    version: 2,
    ai_credit_spend_policies: [{ name: "t", scope: "team", teams: ["ai"], credit_scope: "metered_only", cost_center: "cc-x", amount: 500 }],
  });
  assert.equal(doc.budgets[0].metered_credits_only, true);
  assert.equal("cost_center" in doc.budgets[0], false);
  assert.ok(warnings.some((w) => /dropped explicit cost_center/.test(w)));
});

test("migrateDoc: org always maps to a direct collective metered cap", () => {
  const { doc: meteredDoc } = migrateDoc({
    version: 2,
    ai_credit_spend_policies: [{ scope: "organization", organization: "o", credit_scope: "metered_only", amount: 4000, stop_at_limit: false }],
  });
  assert.equal("metered_credits_only" in meteredDoc.budgets[0], false);
  assert.equal(meteredDoc.budgets[0].enforce, false);

  const { doc: poolDoc, warnings } = migrateDoc({
    version: 2,
    ai_credit_spend_policies: [{ scope: "organization", organization: "o", credit_scope: "pool_then_metered", amount: 80 }],
  });
  assert.equal("metered_credits_only" in poolDoc.budgets[0], false);
  assert.ok(warnings.some((w) => /does not support for orgs/.test(w)));
});

test("migrateDoc: drops team_cost_center_mappings with a warning", () => {
  const { warnings } = migrateDoc({
    version: 2,
    team_cost_center_mappings: [{ team: "a", cost_center: "cc" }],
  });
  assert.ok(warnings.some((w) => /team_cost_center_mapping/.test(w)));
});

test("migrateDoc: warns loudly when the source has no policies (empty starter)", () => {
  const { doc, warnings } = migrateDoc({ version: 2, enterprise_slug: "e", ai_credit_spend_policies: [] });
  assert.equal("budgets" in doc, false);
  assert.ok(warnings.some((w) => /no ai_credit_spend_policies/.test(w)));
});

test("migrateFile: writes valid v3 and a header", () => {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  try {
    const inPath = join(dir, "v2.yml");
    const outPath = join(dir, "v3.yml");
    writeFileSync(inPath, "version: 2\nenterprise_slug: acme\nai_credit_spend_policies:\n  - {scope: all_users, amount: 30}\n");
    const { warnings } = migrateFile(inPath, outPath);
    const text = readFileSync(outPath, "utf8");
    assert.match(text, /migrated from/);
    assert.match(text, /enterprise` input to: acme/);
    const parsed = validateConfig(loadYaml(text));
    assert.equal(parsed.valid, true, JSON.stringify(parsed.errors));
    assert.equal(Array.isArray(warnings), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
