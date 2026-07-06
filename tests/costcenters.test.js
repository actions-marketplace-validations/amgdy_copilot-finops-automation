import test from "node:test";
import assert from "node:assert/strict";
import {
  isResourceMatch,
  resolveCostCenterId,
  findCostCenterByName,
  findCostCenterForResource,
  otherResourcesOf,
  listCostCenters,
  bareEnterpriseTeamSlug,
  resolveEnterpriseTeamSlug,
  createCostCenter,
  deleteCostCenter,
  assignResource,
  derivedCostCenterName,
  assignBodyFor,
} from "../src/github/costcenters.js";
import { FakeClient } from "./helpers/fake-client.js";

test("isResourceMatch: team aliases + case-insensitive name", () => {
  assert.equal(isResourceMatch({ type: "Team", name: "Platform" }, "team", "platform"), true);
  assert.equal(isResourceMatch({ type: "enterprise_team", name: "platform" }, "team", "platform"), true);
  assert.equal(isResourceMatch({ type: "Organization", name: "acme" }, "team", "acme"), false);
});

test("isResourceMatch: enterprise team ent: prefix is normalized", () => {
  // Live shape: cost center resources report enterprise teams as "ent:<slug>".
  assert.equal(isResourceMatch({ type: "Team", name: "ent:github-copilot-enterprise-team" }, "team", "github-copilot-enterprise-team"), true);
  assert.equal(isResourceMatch({ type: "Team", name: "my-team" }, "team", "ent:my-team"), true);
  assert.equal(isResourceMatch({ type: "Team", name: "ent:other" }, "team", "my-team"), false);
});

test("isResourceMatch: organization aliases", () => {
  assert.equal(isResourceMatch({ type: "Organization", name: "acme" }, "organization", "acme"), true);
  assert.equal(isResourceMatch({ type: "Org", name: "ACME" }, "organization", "acme"), true);
  assert.equal(isResourceMatch({ type: "User", name: "acme" }, "organization", "acme"), false);
});

test("resolveCostCenterId: found and not found", () => {
  const ccs = [{ id: "1", name: "engineering" }, { id: "2", name: "Platform" }];
  assert.equal(resolveCostCenterId(ccs, "engineering"), "1");
  assert.equal(resolveCostCenterId(ccs, "platform"), "2"); // case-insensitive
  assert.equal(resolveCostCenterId(ccs, "missing"), null);
});

test("findCostCenterByName: returns matching cost center case-insensitively", () => {
  const ccs = [{ id: "1", name: "finops-team-platform" }, { id: "2", name: "finops-team-GHCP Business Team" }];
  assert.equal(findCostCenterByName(ccs, "FinOps-Team-Platform")?.id, "1");
  assert.equal(findCostCenterByName(ccs, "finops-team-ghcp-business-team")?.id, "2");
  assert.equal(findCostCenterByName(ccs, "missing"), null);
});

test("findCostCenterForResource + otherResourcesOf", () => {
  const ccs = [
    { id: "1", name: "cc-a", resources: [{ type: "Team", name: "platform" }] },
    { id: "2", name: "cc-b", resources: [{ type: "Team", name: "ai" }, { type: "Organization", name: "acme" }] },
  ];
  const hit = findCostCenterForResource(ccs, "team", "ai");
  assert.equal(hit.id, "2");
  assert.deepEqual(otherResourcesOf(hit, "team", "ai"), ["Organization acme"]);
  assert.deepEqual(otherResourcesOf(ccs[0], "team", "platform"), []); // dedicated
  assert.equal(findCostCenterForResource(ccs, "team", "missing"), null);
});

test("listCostCenters: filters archived/deleted", async () => {
  const client = new FakeClient({
    costCenters: [
      { id: "1", name: "active-cc", state: "active" },
      { id: "2", name: "old-cc", state: "deleted" },
    ],
  });
  const ccs = await listCostCenters(client, "ent");
  assert.deepEqual(ccs.map((c) => c.name), ["active-cc"]);
});

test("bareEnterpriseTeamSlug: strips ent prefix case-insensitively", () => {
  assert.equal(bareEnterpriseTeamSlug("ent:ghcp-business-team"), "ghcp-business-team");
  assert.equal(bareEnterpriseTeamSlug("ENT:ghcp-business-team"), "ghcp-business-team");
  assert.equal(bareEnterpriseTeamSlug("ghcp-business-team"), "ghcp-business-team");
});

test("resolveEnterpriseTeamSlug: accepts display name, bare slug, and ent slug", async () => {
  const client = new FakeClient({ teams: [{ name: "GHCP Business Team", slug: "ent:ghcp-business-team" }] });
  assert.equal(await resolveEnterpriseTeamSlug(client, "ent", "GHCP Business Team"), "ghcp-business-team");
  assert.equal(await resolveEnterpriseTeamSlug(client, "ent", "ghcp-business-team"), "ghcp-business-team");
  assert.equal(await resolveEnterpriseTeamSlug(client, "ent", "ent:ghcp-business-team"), "ghcp-business-team");
});

test("createCostCenter: returns id + name and records the request", async () => {
  const client = new FakeClient();
  const cc = await createCostCenter(client, "ent", "finops-team-x");
  assert.match(cc.id, /^cc-id-/);
  assert.equal(cc.name, "finops-team-x");
  assert.equal(client.writes("/cost-centers").length, 1);
});

test("deleteCostCenter: archives the cost center", async () => {
  const client = new FakeClient({ costCenters: [{ id: "cc-1", name: "old", state: "active" }] });
  await deleteCostCenter(client, "ent", "cc-1");
  assert.equal(client.costCenters[0].state, "deleted");
  assert.equal(client.writes("/cost-centers/{cost_center_id}").length, 1);
});

test("assignResource: posts the given body", async () => {
  const client = new FakeClient();
  await assignResource(client, "ent", "cc-1", { enterprise_teams: ["platform"] });
  const req = client.writes("/resource")[0];
  assert.deepEqual(req.params.enterprise_teams, ["platform"]);
  assert.equal(req.params.cost_center_id, "cc-1");
});

test("derivedCostCenterName + assignBodyFor", () => {
  assert.equal(derivedCostCenterName("team", "ai-leads"), "finops-team-ai-leads");
  assert.equal(derivedCostCenterName("organization", "acme"), "finops-org-acme");
  assert.deepEqual(assignBodyFor("team", "ai"), { enterprise_teams: ["ai"] });
  assert.deepEqual(assignBodyFor("organization", "acme"), { organizations: ["acme"] });
});
