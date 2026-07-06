#!/usr/bin/env node
/**
 * Generate docs/config-schema.md from schemas/v3/copilot-finops.schema.json.
 *
 * The JSON Schema is the source of truth; this renders a human-readable field
 * reference from its title/description/examples annotations. Output is stable so
 * a CI "schema docs up to date" check can diff it. Run: npm run docs:schema.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const schema = JSON.parse(readFileSync(join(root, "schemas/v3/copilot-finops.schema.json"), "utf8"));
const outPath = join(root, "docs/config-schema.md");

const esc = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

function typeOf(prop) {
  if (prop.const !== undefined) return `\`${JSON.stringify(prop.const)}\``;
  if (Array.isArray(prop.oneOf)) return prop.oneOf.map((option) => `\`${option.const}\``).join(" \\| ");
  if (prop.type === "array") {
    const itemType = prop.items?.type ? `${prop.items.type}[]` : "array";
    return itemType;
  }
  return prop.type || "—";
}

function examplesOf(prop) {
  if (!Array.isArray(prop.examples) || prop.examples.length === 0) return "";
  return prop.examples.map((example) => `\`${JSON.stringify(example)}\``).join(", ");
}

const lines = [];
lines.push("# Copilot FinOps config (v3) — field reference", "");
lines.push("> Generated from `schemas/v3/copilot-finops.schema.json` by `npm run docs:schema`. Do not edit by hand.", "");
lines.push(esc(schema.description), "");

// Top-level fields.
lines.push("## Top-level fields", "");
lines.push("| Field | Type | Required | Description |");
lines.push("| --- | --- | --- | --- |");
const topRequired = new Set(schema.required || []);
for (const [name, prop] of Object.entries(schema.properties)) {
  lines.push(`| \`${name}\` | ${typeOf(prop)} | ${topRequired.has(name) ? "yes" : "no"} | ${esc(prop.description)} |`);
}
lines.push("");

// Budget fields.
const budget = schema.$defs.budget;
const budgetRequired = new Set(budget.required || []);
lines.push("## Budget fields (`budgets[]`)", "");
lines.push("Each entry in `budgets` is one budget. `scope` selects who it is for and which fields are required or forbidden.", "");
lines.push("| Field | Type | Required | Default | Description |");
lines.push("| --- | --- | --- | --- | --- |");
for (const [name, prop] of Object.entries(budget.properties)) {
  if (name === "scope") continue; // rendered as its own table below
  const defaultValue = prop.default !== undefined ? `\`${JSON.stringify(prop.default)}\`` : "—";
  lines.push(`| \`${name}\` | ${typeOf(prop)} | ${budgetRequired.has(name) ? "yes" : "no"} | ${defaultValue} | ${esc(prop.description)} |`);
}
lines.push("");

// scope enum table.
lines.push("### `scope` values", "");
lines.push("| Value | Meaning |");
lines.push("| --- | --- |");
for (const scopeOption of budget.properties.scope.oneOf) {
  lines.push(`| \`${scopeOption.const}\` | ${esc(scopeOption.description)} |`);
}
lines.push("");

// Examples.
const topExamples = examplesOf({ examples: schema.examples });
if (topExamples) {
  lines.push("## Example", "");
  lines.push("```yaml");
  lines.push("version: 3");
  lines.push("budgets:");
  lines.push("  - name: all-users-default");
  lines.push("    scope: all_users");
  lines.push("    amount: 30");
  lines.push("```", "");
}

lines.push("---", "");
lines.push("Cross-field rules (per-scope required/forbidden fields, the `metered_credits_only` → `enforce` gating) and uniqueness are enforced by the validator; see `src/config/validate.js`.", "");

writeFileSync(outPath, lines.join("\n"));
console.log(`Wrote ${outPath}`);
