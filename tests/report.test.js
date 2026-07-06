import test from "node:test";
import assert from "node:assert/strict";
import { renderReport, renderTextReport } from "../src/report.js";

function sampleResult(overrides = {}) {
  return {
    mode: "dry-run",
    enterprise: "acme-corp",
    configSource: "config/copilot-finops.yml",
    actions: [
      {
        policy: "all-users-default",
        scope: "all_users",
        resolution: "DIRECT",
        apiScope: "multi_user_customer",
        entity: "",
        action: "UPDATE",
        oldAmount: 20,
        newAmount: 30,
        flags: ["per-user", "hard-stop"],
      },
      {
        policy: "ai-leads",
        scope: "team",
        resolution: "CC finops-team-ai-leads (created + team assigned)",
        apiScope: "multi_user_cost_center",
        entity: "finops-team-ai-leads",
        action: "CREATE",
        oldAmount: null,
        newAmount: 30,
        flags: ["per-member", "hard-stop"],
      },
    ],
    costCentersCreated: [{ name: "finops-team-ai-leads", assigned: "team ai-leads", forPolicy: "ai-leads" }],
    duplicates: [{ entity: "engineering", policies: ["a", "b"], winner: "b", skipped: ["a"] }],
    sharedCostCenters: [
      { policy: "org-cap", costCenter: "shared-cc", target: "org acme", otherResources: ["team x"], applied: false },
    ],
    errors: [{ policy: "eng-cap", message: "cost center 'engineering' not found" }],
    log: ["line 1", "line 2"],
    ...overrides,
  };
}

test("renderReport: header, counts, and all sections present", () => {
  const md = renderReport(sampleResult());
  assert.match(md, /## Copilot FinOps — Apply report/);
  assert.match(md, /\*\*Mode:\*\* dry-run/);
  assert.match(md, /\*\*Enterprise:\*\* `acme-corp`/);
  assert.match(md, /### Budgets/);
  assert.match(md, /### Cost centers created/);
  assert.match(md, /### Duplicates/);
  assert.match(md, /### Shared cost centers/);
  assert.match(md, /### Errors/);
  assert.match(md, /<details><summary>Full run log<\/summary>/);
});

test("renderReport: dry-run prefixes actions with 'would'", () => {
  const md = renderReport(sampleResult());
  assert.match(md, /would CREATE/);
  assert.match(md, /would UPDATE/);
});

test("renderReport: live mode does not prefix with 'would'", () => {
  const md = renderReport(sampleResult({ mode: "live" }));
  assert.doesNotMatch(md, /would CREATE/);
  assert.match(md, /\| CREATE \|/);
});

test("renderReport: amount cells show create/update transitions", () => {
  const md = renderReport(sampleResult());
  assert.match(md, /— → \$30/); // CREATE
  assert.match(md, /\$20 → \$30/); // UPDATE
});

test("renderReport: counts row reflects actions", () => {
  const md = renderReport(sampleResult());
  // 1 created, 1 updated, 0 unchanged, 0 skipped, 1 cc created, 1 error
  assert.match(md, /\| 1 \| 1 \| 0 \| 0 \| 1 \| 1 \|/);
});

test("renderReport: empty result renders a no-budgets note", () => {
  const md = renderReport({
    mode: "live",
    enterprise: "e",
    configSource: "c",
    actions: [],
    costCentersCreated: [],
    duplicates: [],
    sharedCostCenters: [],
    errors: [],
    log: [],
  });
  assert.match(md, /_No budgets to apply._/);
});

test("renderTextReport: plain text, no markdown syntax", () => {
  const txt = renderTextReport(sampleResult());
  assert.doesNotMatch(txt, /^\s*#/m); // no markdown headers
  assert.doesNotMatch(txt, /\| --- \|/); // no table separators
  assert.doesNotMatch(txt, /<details>/); // no HTML
  assert.doesNotMatch(txt, /`/); // no backticks
  assert.match(txt, /Copilot FinOps — apply \(dry-run\)/);
  assert.match(txt, /Summary: 1 create, 1 update/);
  assert.match(txt, /would CREATE/);
  assert.match(txt, /Errors:/);
});
