/**
 * Cost center resolution, creation, and resource assignment.
 *
 * v3 applies team budgets through the cost center that contains the enterprise
 * team. This module finds that cost center, or creates one and assigns the team
 * object to it (GitHub keeps that membership live). It also detects a "shared"
 * cost center — one that holds resources beyond the target — so the engine can
 * skip it unless the budget opts in with allow_shared_cost_center.
 *
 * The exact resource representation in a cost center's resources[] (the `type`
 * value for an enterprise team vs an organization) is confirmed live during the
 * port; the accepted aliases below are intentionally permissive so a naming
 * difference does not break resolution.
 */

/** Accepted resources[].type values for an enterprise team (lowercased). */
const TEAM_RESOURCE_TYPES = new Set(["team", "enterprise_team", "enterpriseteam", "enterprise team"]);
/** Accepted resources[].type values for an organization (lowercased). */
const ORG_RESOURCE_TYPES = new Set(["org", "organization"]);

function norm(value) {
  return String(value ?? "").trim().toLowerCase();
}

function looseNameKey(value) {
  return norm(value).replace(/[^a-z0-9]/g, "");
}

/** Does a cost center resource entry match the target team/org? */
export function isResourceMatch(resource, targetType, targetName) {
  const resourceType = norm(resource?.type);
  const resourceName = norm(resource?.name);
  const normalizedTarget = norm(targetName);
  if (targetType === "team") {
    // Enterprise teams appear in resources[] with an `ent:` prefix (e.g.
    // "ent:my-team", matching the teams-list endpoint), while config uses the
    // bare slug. Normalize the prefix on both sides before comparing.
    const stripEntPrefix = (slug) => (slug.startsWith("ent:") ? slug.slice(4) : slug);
    return TEAM_RESOURCE_TYPES.has(resourceType) && stripEntPrefix(resourceName) === stripEntPrefix(normalizedTarget);
  }
  if (targetType === "organization") return ORG_RESOURCE_TYPES.has(resourceType) && resourceName === normalizedTarget;
  return false;
}

/**
 * Resolve a cost center name to its string ID (the budgets API references cost
 * centers by ID, not display name). Returns null when not found.
 */
export function resolveCostCenterId(costCenters, name) {
  const target = norm(name);
  const match = costCenters.find((costCenter) => norm(costCenter.name) === target);
  return match ? match.id : null;
}

/** Find an active cost center by display name, or null. */
export function findCostCenterByName(costCenters, name) {
  const target = norm(name);
  const looseTarget = looseNameKey(name);
  return costCenters.find((costCenter) => norm(costCenter.name) === target || looseNameKey(costCenter.name) === looseTarget) || null;
}

/** Find the cost center whose resources include the target team/org, or null. */
export function findCostCenterForResource(costCenters, targetType, targetName) {
  return (
    costCenters.find((costCenter) =>
      (costCenter.resources || []).some((resource) => isResourceMatch(resource, targetType, targetName)),
    ) || null
  );
}

/** Resources in a cost center that are NOT the target (the budget blast radius). */
export function otherResourcesOf(costCenter, targetType, targetName) {
  return (costCenter.resources || [])
    .filter((resource) => !isResourceMatch(resource, targetType, targetName))
    .map((resource) => `${resource.type || "resource"} ${resource.name || ""}`.trim());
}

/** List active (non-archived) cost centers for an enterprise. */
export async function listCostCenters(client, enterprise) {
  const items = await client.paginateEnvelope(
    "GET /enterprises/{enterprise}/settings/billing/cost-centers",
    { enterprise },
    "costCenters",
  );
  return items.filter((costCenter) => norm(costCenter.state || "active") !== "deleted");
}

/** Strip GitHub's enterprise-team `ent:` prefix from a slug when present. */
export function bareEnterpriseTeamSlug(value) {
  const text = String(value ?? "").trim();
  return text.toLowerCase().startsWith("ent:") ? text.slice(4) : text;
}

/**
 * Resolve a user-provided enterprise team identifier to the bare slug accepted
 * by cost-center resource assignment. Accepts the bare slug, the API's `ent:`
 * slug, or the team display name.
 */
export async function resolveEnterpriseTeamSlug(client, enterprise, team) {
  const input = bareEnterpriseTeamSlug(team);
  const target = norm(input);
  const teams = await client.paginateEnvelope(
    "GET /enterprises/{enterprise}/teams",
    { enterprise, per_page: 100 },
    "",
  );
  const match = teams.find((teamEntry) => {
    const slug = bareEnterpriseTeamSlug(teamEntry.slug || teamEntry.name);
    return norm(slug) === target || norm(teamEntry.name) === target;
  });
  if (!match) {
    throw new Error(`enterprise team "${team}" not found. Use the enterprise team slug (for example, ghcp-business-team), not the display name.`);
  }
  return bareEnterpriseTeamSlug(match.slug || match.name);
}

/** Create a cost center. Returns { id, name }. */
export async function createCostCenter(client, enterprise, name) {
  const response = await client.request("POST /enterprises/{enterprise}/settings/billing/cost-centers", {
    enterprise,
    name,
  });
  const data = response?.data || {};
  if (!data.id) throw new Error(`created cost center "${name}" but the API returned no id.`);
  return { id: data.id, name: data.name || name };
}

/** Archive a cost center. Used as rollback when auto-provisioning fails mid-flight. */
export async function deleteCostCenter(client, enterprise, costCenterId) {
  await client.request("DELETE /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}", {
    enterprise,
    cost_center_id: costCenterId,
  });
}

/**
 * Assign a resource (enterprise team or organization) to a cost center.
 * @param {object} body - { enterprise_teams: [slug] } or { organizations: [org] }.
 */
export async function assignResource(client, enterprise, costCenterId, body) {
  await client.request(
    "POST /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource",
    { enterprise, cost_center_id: costCenterId, ...body },
  );
}

/** Derived cost center name for an auto-provisioned team budget (org kept for diagnostics/helpers). */
export function derivedCostCenterName(targetType, targetName) {
  return targetType === "team" ? `finops-team-${targetName}` : `finops-org-${targetName}`;
}

/** Resource-assignment body for a target team/org (org used only by diagnostics/helpers). */
export function assignBodyFor(targetType, targetName) {
  return targetType === "team" ? { enterprise_teams: [bareEnterpriseTeamSlug(targetName)] } : { organizations: [targetName] };
}
