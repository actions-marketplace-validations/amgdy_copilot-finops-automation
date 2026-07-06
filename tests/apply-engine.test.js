import test from "node:test";
import assert from "node:assert/strict";
import { applyBudgets, PLACEHOLDER_CC_ID } from "../src/apply-engine.js";
import { FakeClient } from "./helpers/fake-client.js";

const cfg = (budgets) => ({ version: 3, budgets });
const run = (client, budgets, opts = {}) =>
  applyBudgets({ client, config: cfg(budgets), enterprise: "ent", configSource: "c.yml", dryRun: true, ...opts });
const actionFor = (result, policy) => result.actions.find((a) => a.policy === policy);

const liveBudget = (over) => ({
  id: "b1",
  budget_scope: "multi_user_customer",
  budget_product_sku: "ai_credits",
  budget_amount: 30,
  prevent_further_usage: true,
  budget_alerting: { will_alert: false, alert_recipients: [] },
  ...over,
});

test("all_users: CREATE when no live budget (dry-run)", async () => {
  const client = new FakeClient();
  const r = await run(client, [{ name: "base", scope: "all_users", amount: 30 }]);
  const a = actionFor(r, "base");
  assert.equal(a.action, "CREATE");
  assert.equal(a.apiScope, "multi_user_customer");
  assert.deepEqual(a.flags, ["per-user", "hard-stop"]);
  assert.equal(a.newAmount, 30);
});

test("all_users: NO CHANGE when live matches", async () => {
  const client = new FakeClient({ budgets: [liveBudget({ budget_amount: 30 })] });
  const r = await run(client, [{ name: "base", scope: "all_users", amount: 30 }]);
  assert.equal(actionFor(r, "base").action, "NO CHANGE");
});

test("all_users: UPDATE when live amount differs", async () => {
  const client = new FakeClient({ budgets: [liveBudget({ budget_amount: 20 })] });
  const r = await run(client, [{ name: "base", scope: "all_users", amount: 30 }]);
  const a = actionFor(r, "base");
  assert.equal(a.action, "UPDATE");
  assert.equal(a.oldAmount, 20);
  assert.equal(a.newAmount, 30);
});

test("user: fans out one budget per login", async () => {
  const client = new FakeClient();
  const r = await run(client, [{ name: "power", scope: "user", users: ["alice", "bob"], amount: 75 }]);
  const users = r.actions.filter((a) => a.apiScope === "user");
  assert.equal(users.length, 2);
  assert.deepEqual(users.map((a) => a.entity).sort(), ["alice", "bob"]);
  assert.ok(users.every((a) => a.flags.includes("hard-stop")));
});

test("cost_center default -> multi_user_cost_center", async () => {
  const client = new FakeClient({ costCenters: [{ id: "cc-eng", name: "engineering", state: "active", resources: [] }] });
  const r = await run(client, [{ name: "eng", scope: "cost_center", cost_center: "engineering", amount: 20 }]);
  const a = actionFor(r, "eng");
  assert.equal(a.apiScope, "multi_user_cost_center");
  assert.deepEqual(a.flags, ["per-member", "hard-stop"]);
});

test("cost_center metered -> cost_center with alert-only flag when enforce:false", async () => {
  const client = new FakeClient({ costCenters: [{ id: "cc-eng", name: "engineering", state: "active", resources: [] }] });
  const r = await run(client, [
    { name: "eng-cap", scope: "cost_center", cost_center: "engineering", metered_credits_only: true, amount: 500, enforce: false, alerts: ["x"] },
  ]);
  const a = actionFor(r, "eng-cap");
  assert.equal(a.apiScope, "cost_center");
  assert.ok(a.flags.includes("metered-only"));
  assert.ok(a.flags.includes("alert-only"));
  assert.ok(a.flags.includes("alerts"));
});

test("cost_center: not found -> error", async () => {
  const client = new FakeClient({ costCenters: [] });
  const r = await run(client, [{ name: "eng", scope: "cost_center", cost_center: "missing", amount: 20 }]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /not found/);
});

test("cost_center: live match by cost center ID (name/id echo asymmetry) -> NO CHANGE", async () => {
  const client = new FakeClient({
    costCenters: [{ id: "cc-eng", name: "engineering", state: "active", resources: [] }],
    budgets: [
      {
        id: "b",
        budget_scope: "multi_user_cost_center",
        budget_product_sku: "ai_credits",
        budget_amount: 20,
        prevent_further_usage: true,
        budget_alerting: { will_alert: false, alert_recipients: [] },
        budget_entity_name: "cc-eng", // API echoes the ID here
      },
    ],
  });
  const r = await run(client, [{ name: "eng", scope: "cost_center", cost_center: "engineering", amount: 20 }]);
  assert.equal(actionFor(r, "eng").action, "NO CHANGE");
});

test("team default: resolves an existing dedicated cost center", async () => {
  const client = new FakeClient({
    costCenters: [{ id: "cc1", name: "platform-cc", state: "active", resources: [{ type: "Team", name: "platform" }] }],
  });
  const r = await run(client, [{ name: "plat", scope: "team", team: "platform", amount: 25 }]);
  const a = actionFor(r, "plat");
  assert.equal(a.apiScope, "multi_user_cost_center");
  assert.match(a.resolution, /existing CC platform-cc/);
});

test("team default: would create a cost center in dry-run", async () => {
  const client = new FakeClient({ costCenters: [] });
  const r = await run(client, [{ name: "plat", scope: "team", team: "platform", amount: 25 }]);
  assert.equal(r.costCentersCreated.length, 1);
  assert.equal(r.costCentersCreated[0].name, "finops-team-platform");
  const a = actionFor(r, "plat");
  assert.equal(a.action, "CREATE");
  assert.match(a.resolution, /would create/);
  // dry-run makes no writes
  assert.equal(client.requests.length, 0);
});

test("team default (live): creates cost center, assigns team, creates budget", async () => {
  const client = new FakeClient({ costCenters: [], teams: [{ name: "platform", slug: "ent:platform" }] });
  const r = await applyBudgets({ client, config: cfg([{ name: "plat", scope: "team", team: "platform", amount: 25 }]), enterprise: "ent", dryRun: false });
  assert.equal(client.writes("/cost-centers").length >= 1, true);
  assert.equal(client.writes("/resource").length, 1);
  assert.equal(client.writes("/budgets").length, 1);
  assert.equal(actionFor(r, "plat").action, "CREATE");
  assert.equal(r.costCentersCreated.length, 1);
});

test("team default (live): display name is resolved to enterprise team slug before assignment", async () => {
  const client = new FakeClient({ costCenters: [], teams: [{ name: "GHCP Business Team", slug: "ent:ghcp-business-team" }] });
  const r = await applyBudgets({ client, config: cfg([{ name: "biz", scope: "team", team: "GHCP Business Team", amount: 60 }]), enterprise: "ent", dryRun: false });
  assert.equal(actionFor(r, "biz").action, "CREATE");
  assert.deepEqual(client.writes("/resource")[0].params.enterprise_teams, ["ghcp-business-team"]);
  assert.equal(r.costCentersCreated[0].assigned, "team ghcp-business-team");
});

test("team default (live): reuses an existing derived-name cost center instead of creating and hitting 409", async () => {
  const client = new FakeClient({
    costCenters: [{ id: "cc-existing", name: "finops-team-GHCP Business Team", state: "active", resources: [] }],
    teams: [{ name: "GHCP Business Team", slug: "ent:ghcp-business-team" }],
  });
  const r = await applyBudgets({ client, config: cfg([{ name: "biz", scope: "team", team: "GHCP Business Team", amount: 60 }]), enterprise: "ent", dryRun: false });
  const createCcWrites = client.requests.filter((req) => req.route === "POST /enterprises/{enterprise}/settings/billing/cost-centers");
  assert.equal(createCcWrites.length, 0);
  assert.deepEqual(client.writes("/resource")[0].params.enterprise_teams, ["ghcp-business-team"]);
  assert.equal(actionFor(r, "biz").apiScope, "multi_user_cost_center");
  assert.match(actionFor(r, "biz").resolution, /assigned team/);
  assert.equal(r.costCentersCreated.length, 0);
});

test("team default (live): rolls back a newly created cost center when assignment fails", async () => {
  const client = new FakeClient({ costCenters: [], teams: [{ name: "platform", slug: "ent:platform" }], failResourceAssign: true });
  const r = await applyBudgets({ client, config: cfg([{ name: "plat", scope: "team", team: "platform", amount: 25 }]), enterprise: "ent", dryRun: false });
  assert.equal(r.actions.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /could not assign team platform/);
  assert.equal(client.costCenters[0].state, "deleted");
  assert.equal(client.writes("/budgets").length, 0);
});

test("live apply aborts before writes when existing budgets cannot be listed", async () => {
  const client = new FakeClient({ failBudgetList: true });
  const r = await applyBudgets({ client, config: cfg([{ name: "base", scope: "all_users", amount: 30 }]), enterprise: "ent", dryRun: false });
  assert.equal(r.actions.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /could not list existing budgets/);
  assert.match(r.errors[0].message, /refusing to apply/);
  assert.equal(client.writes("/budgets").length, 0);
});

test("team metered -> cost_center on the team's cost center", async () => {
  const client = new FakeClient({
    costCenters: [{ id: "cc1", name: "platform-cc", state: "active", resources: [{ type: "Team", name: "platform" }] }],
  });
  const r = await run(client, [
    { name: "plat-cap", scope: "team", team: "platform", metered_credits_only: true, amount: 300, enforce: false },
  ]);
  assert.equal(actionFor(r, "plat-cap").apiScope, "cost_center");
});

test("organization -> direct organization budget (collective metered)", async () => {
  const client = new FakeClient();
  const r = await run(client, [
    { name: "org-cap", scope: "organization", organization: "acme", amount: 4000, enforce: false },
  ]);
  const a = actionFor(r, "org-cap");
  assert.equal(a.apiScope, "organization");
  assert.equal(a.entity, "acme");
  assert.ok(a.flags.includes("metered-only"));
});

test("organization: never resolves or creates a cost center", async () => {
  const client = new FakeClient({ costCenters: [] });
  const r = await run(client, [{ name: "org", scope: "organization", organization: "acme", amount: 40 }]);
  const a = actionFor(r, "org");
  assert.equal(a.apiScope, "organization");
  assert.equal(a.entity, "acme");
  assert.equal(r.costCentersCreated.length, 0);
});

test("enterprise: enterprise scope, metered-only flags", async () => {
  const client = new FakeClient();
  const r = await run(client, [{ name: "ent-cap", scope: "enterprise", amount: 5000, enforce: false }]);
  const a = actionFor(r, "ent-cap");
  assert.equal(a.apiScope, "enterprise");
  assert.ok(a.flags.includes("metered-only"));
  assert.ok(a.flags.includes("alert-only"));
});

test("apply: 'only user members' 400 (per-member budget on a CC holding an org) yields the friendly recommended-path note", async () => {
  const client = new FakeClient({
    costCenters: [{ id: "cc1", name: "org-test", state: "active", resources: [{ type: "Org", name: "acme" }] }],
    failBudgetWrite: {
      status: 400,
      message:
        "A multi_user_cost_center budget requires the cost center to contain only user members. Organization and repository members are not supported.",
    },
  });
  const r = await run(client, [{ name: "cc", scope: "cost_center", cost_center: "org-test", amount: 50 }], { dryRun: false });
  const a = actionFor(r, "cc");
  assert.equal(a.action, "ERROR");
  assert.match(a.note, /enterprise team/);
  assert.match(a.note, /scope: team/);
});

test("shared cost center: skipped unless allow_shared_cost_center", async () => {
  const costCenters = [
    { id: "cc1", name: "shared", state: "active", resources: [{ type: "Team", name: "platform" }, { type: "Team", name: "other" }] },
  ];
  const skipRun = await run(new FakeClient({ costCenters: structuredClone(costCenters) }), [
    { name: "plat", scope: "team", team: "platform", amount: 25 },
  ]);
  assert.equal(skipRun.actions.length, 0);
  assert.equal(skipRun.sharedCostCenters.length, 1);
  assert.equal(skipRun.sharedCostCenters[0].applied, false);

  const allowRun = await run(new FakeClient({ costCenters: structuredClone(costCenters) }), [
    { name: "plat", scope: "team", team: "platform", amount: 25, allow_shared_cost_center: true },
  ]);
  assert.equal(allowRun.actions.length, 1);
  assert.equal(allowRun.sharedCostCenters[0].applied, true);
});

test("duplicate detection: team + cost_center resolving to same CC -> last wins", async () => {
  const client = new FakeClient({
    costCenters: [{ id: "cc-eng", name: "eng", state: "active", resources: [{ type: "Team", name: "platform" }] }],
  });
  const r = await run(client, [
    { name: "via-team", scope: "team", team: "platform", amount: 25 },
    { name: "via-cc", scope: "cost_center", cost_center: "eng", amount: 25 },
  ]);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].winner, "via-cc");
  assert.equal(actionFor(r, "via-team").action, "SKIP");
  assert.equal(actionFor(r, "via-cc").action, "CREATE");
});

test("no budgets: empty result", async () => {
  const r = await run(new FakeClient(), []);
  assert.equal(r.actions.length, 0);
  assert.match(r.log.join("\n"), /No budgets/);
});

test("dry-run: budgets to different auto-created cost centers are NOT duplicates", async () => {
  const client = new FakeClient({ costCenters: [] });
  const r = await run(client, [
    { name: "team-b", scope: "team", team: "platform", amount: 25 },
    { name: "org-b", scope: "organization", organization: "acme", amount: 40 },
  ]);
  assert.equal(r.duplicates.length, 0);
  assert.equal(actionFor(r, "team-b").action, "CREATE");
  assert.equal(actionFor(r, "org-b").action, "CREATE");
});

test("dry-run: same team budgeted twice -> one cost center recorded, last wins", async () => {
  const client = new FakeClient({ costCenters: [] });
  const r = await run(client, [
    { name: "t1", scope: "team", team: "platform", amount: 25 },
    { name: "t2", scope: "team", team: "platform", amount: 30 },
  ]);
  assert.equal(r.costCentersCreated.length, 1);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].winner, "t2");
});

test("live write failure surfaces as an ERROR action", async () => {
  const client = new FakeClient({ failBudgetWrite: true });
  const r = await applyBudgets({ client, config: cfg([{ name: "base", scope: "all_users", amount: 30 }]), enterprise: "ent", dryRun: false });
  assert.equal(actionFor(r, "base").action, "ERROR");
});

test("onLog streams apply log lines", async () => {
  const client = new FakeClient();
  const lines = [];
  await applyBudgets({
    client,
    config: cfg([{ name: "base", scope: "all_users", amount: 30 }]),
    enterprise: "ent",
    dryRun: true,
    onLog: (m) => lines.push(m),
  });
  assert.ok(lines.length > 0);
  assert.ok(lines.some((l) => /Applying 1 budget/.test(l)));
  assert.ok(lines.some((l) => /Resolved base/.test(l)));
});

test("apply log includes progress context by default and debug detail when verbose", async () => {
  const client = new FakeClient({ budgets: [liveBudget({ id: "existing-base", budget_amount: 30 })] });
  const r = await run(client, [{ name: "base", scope: "all_users", amount: 30 }]);
  const log = r.log.join("\n");
  assert.match(log, /Config source: c\.yml; mode=dry-run; declared budgets=1/);
  assert.match(log, /Budget scope counts: all_users=1/);
  assert.match(log, /Resolving budget 1\/1 base: scope=all_users/);
  assert.match(log, /Resolved base: all_users -> multi_user_customer target=all licensed users amount=\$30/);
  assert.match(log, /NO CHANGE base .*already matches amount=\$30/);
  assert.match(log, /Apply complete: actions=1/);
  assert.doesNotMatch(log, /^DEBUG /m);

  const verboseClient = new FakeClient({ budgets: [liveBudget({ id: "existing-base", budget_amount: 30 })] });
  const verboseRun = await run(verboseClient, [{ name: "base", scope: "all_users", amount: 30 }], { verbose: true });
  const verboseLog = verboseRun.log.join("\n");
  assert.match(verboseLog, /DEBUG base: matching desired budget key=multi_user_customer/);
  assert.match(verboseLog, /DEBUG base: matched live budget id=existing-base/);
});

test("ERROR note includes HTTP status + response body", async () => {
  const client = new FakeClient({ failBudgetWrite: true });
  const r = await applyBudgets({ client, config: cfg([{ name: "base", scope: "all_users", amount: 30 }]), enterprise: "ent", dryRun: false });
  const a = actionFor(r, "base");
  assert.equal(a.action, "ERROR");
  assert.match(a.note, /HTTP 422/);
  assert.match(a.note, /budget rejected by API/);
});

test("PLACEHOLDER_CC_ID is exported for dry-run resolution", () => {
  assert.equal(typeof PLACEHOLDER_CC_ID, "string");
});
