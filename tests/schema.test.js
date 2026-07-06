import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schemas/v3/copilot-finops.schema.json" with { type: "json" };
import { validateConfig, validateAgainstSchema } from "../src/config/validate.js";

test("schema compiles in ajv strict mode", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats.default(ajv);
  assert.doesNotThrow(() => ajv.compile(schema));
});

test("schema targets JSON Schema draft 2020-12", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("schema requires version and forbids unknown top-level fields", () => {
  assert.deepEqual(schema.required, ["version"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.version.const, 3);
});

test("boundary: schema alone accepts two all_users; validateConfig rejects via semantic uniqueness", () => {
  const doc = {
    version: 3,
    budgets: [
      { scope: "all_users", amount: 30 },
      { scope: "all_users", amount: 40 },
    ],
  };
  assert.equal(validateAgainstSchema(doc).ok, true, "the schema is shape-only and should accept this");
  assert.equal(validateConfig(doc).valid, false, "validateConfig should reject via uniqueness");
});

test("boundary: schema accepts org + metered_credits_only:false; validateConfig gates it as not yet supported", () => {
  const doc = { version: 3, budgets: [{ scope: "organization", organization: "acme", amount: 50, metered_credits_only: false }] };
  assert.equal(validateAgainstSchema(doc).ok, true, "the schema is shape-only: org metered_credits_only is a boolean");
  const r = validateConfig(doc);
  assert.equal(r.valid, false, "validateConfig should gate the per-member org path in code");
  assert.ok(
    r.errors.some((e) => /not yet supported/.test(e.message)),
    "the gate should read 'not yet supported' (a capability limit, not a shape rule)",
  );
});

test("every budget property is annotated with title + description (IDE/self-docs)", () => {
  const props = schema.$defs.budget.properties;
  for (const [name, def] of Object.entries(props)) {
    assert.ok(def.title, `budget.${name} is missing a title`);
    assert.ok(def.description, `budget.${name} is missing a description`);
  }
});

test("every top-level property is annotated with title + description", () => {
  for (const [name, def] of Object.entries(schema.properties)) {
    assert.ok(def.title, `top-level ${name} is missing a title`);
    assert.ok(def.description, `top-level ${name} is missing a description`);
  }
});

test("scope enum lists exactly the six supported scopes", () => {
  const consts = schema.$defs.budget.properties.scope.oneOf.map((s) => s.const);
  assert.deepEqual(consts.sort(), ["all_users", "cost_center", "enterprise", "organization", "team", "user"]);
});
