/**
 * Budget apply engine (the `apply` operation).
 *
 * For each config budget it resolves the target to exactly one GitHub budget API
 * call (a team budget goes via a cost center — found, or created and the team
 * assigned), then compares it against live state: CREATE, UPDATE (mutable
 * fields only), or NO CHANGE. Dry-run computes the same plan without writing
 * (this is the audit). It never deletes budgets. The structured result feeds
 * report.js.
 *
 * Scope -> API control:
 *   all_users                       -> multi_user_customer   (per-user, hard-stop)
 *   user (per login)                -> user                  (per-user, hard-stop)
 *   cost_center (default)           -> multi_user_cost_center (per-member, hard-stop)
 *   cost_center + metered_only      -> cost_center           (collective metered)
 *   team (default)                  -> multi_user_cost_center on the team's cost center
 *   team + metered_only             -> cost_center           on the team's cost center
 *   organization                    -> organization          (direct, collective metered)
 *   enterprise                      -> enterprise            (collective metered)
 *
 * organization is always a DIRECT collective metered cap: a multi_user_cost_center
 * budget rejects an Org resource (API 400 — a per-member cost center may hold only
 * users or enterprise teams), so v3 does not budget orgs per-user. All budgets are written on the enterprise
 * budgets endpoint with budget_entity_name naming the org / cost center (the
 * 2026-03-10 API accepts every scope there; confirmed live during the port).
 */
import {
  listCostCenters,
  resolveCostCenterId,
  findCostCenterByName,
  findCostCenterForResource,
  otherResourcesOf,
  createCostCenter,
  deleteCostCenter,
  assignResource,
  resolveEnterpriseTeamSlug,
  derivedCostCenterName,
  assignBodyFor,
} from "./github/costcenters.js";

const BUDGET_SKU = "ai_credits";
const BUDGET_TYPE = "BundlePricing";
const BUDGETS_LIST_ROUTE = "GET /enterprises/{enterprise}/settings/billing/budgets";
const BUDGETS_CREATE_ROUTE = "POST /enterprises/{enterprise}/settings/billing/budgets";
const BUDGETS_PATCH_ROUTE = "PATCH /enterprises/{enterprise}/settings/billing/budgets/{budget_id}";
/** Placeholder cost center id used only in dry-run when a cost center would be created. */
export const PLACEHOLDER_CC_ID = "<new-cost-center-id>";
/** Format an error with HTTP status + response body when it is an Octokit error. */
export function describeError(error) {
  if (!error) return "unknown error";
  const status = error.status ? `HTTP ${error.status}: ` : "";
  const message = error.message || String(error);
  const data = error.response?.data;
  let body = "";
  if (data) {
    const text = typeof data === "string" ? data : data.message || JSON.stringify(data);
    if (text && !message.includes(text)) body = ` — ${text}`;
  }
  return `${status}${message}${body}`;
}

/**
 * Make the "cost center must contain only user members" 400 as clear at apply
 * time as the validate-time message: a per-member (multi_user_cost_center) budget
 * cannot cover a cost center that holds an organization or repository resource.
 */
export function explainApiError(detail) {
  if (/only user members|Organization and repository members are not supported/i.test(detail)) {
    return `Per-member budgets can't cover a cost center that holds an organization or repository — GitHub only supports per-member budgets on a cost center of individual users or enterprise teams. Recommended path: put the users you want to cap into an enterprise team, add that team to the organization, then budget that team with scope: team — the FinOps engine manages the enterprise team's per-member budget for you.`;
  }
  return detail;
}
// ── Budget REST calls ────────────────────────────────────────────────────────
async function listBudgets(client, enterprise) {
  return client.paginateEnvelope(BUDGETS_LIST_ROUTE, { enterprise, per_page: 10 }, "budgets");
}

async function createBudget(client, enterprise, payload) {
  await client.request(BUDGETS_CREATE_ROUTE, { enterprise, ...payload });
}

async function patchBudget(client, enterprise, budgetId, payload) {
  await client.request(BUDGETS_PATCH_ROUTE, { enterprise, budget_id: budgetId, ...payload });
}

// ── Desired-budget helpers ───────────────────────────────────────────────────
function enforceOf(budget) {
  return budget.enforce === false ? false : true;
}

function computeFlags(apiScope, prevent, willAlert) {
  let flags;
  if (apiScope === "multi_user_customer" || apiScope === "user") flags = ["per-user", "hard-stop"];
  else if (apiScope === "multi_user_cost_center") flags = ["per-member", "hard-stop"];
  else flags = ["metered-only", prevent ? "hard-stop" : "alert-only"];
  if (willAlert) flags.push("alerts");
  return flags;
}

/**
 * @typedef {Object} DesiredBudget
 * @property {string} policy        Budget name/label from config.
 * @property {string} scope         Config scope.
 * @property {string} resolution    How the target resolved (DIRECT / CC ...).
 * @property {string} apiScope      GitHub budget_scope.
 * @property {string} entity        budget_entity_name (cost center name / org login), or "".
 * @property {string|null} entityId Cost center ID, when applicable.
 * @property {string|null} user     Login (user scope), else null.
 * @property {number} amount        Whole USD.
 * @property {boolean} prevent      prevent_further_usage (hard stop).
 * @property {boolean} willAlert    Whether alerting is enabled.
 * @property {string[]} recipients  Alert recipient logins.
 * @property {string[]} flags       Display flags for the report.
 */
function makeDesired(parts) {
  const recipients = parts.recipients || [];
  const willAlert = recipients.length > 0;
  return {
    policy: parts.policy,
    scope: parts.scope,
    resolution: parts.resolution,
    apiScope: parts.apiScope,
    entity: parts.entity || "",
    entityId: parts.entityId || null,
    user: parts.user || null,
    amount: parts.amount,
    prevent: parts.prevent,
    willAlert,
    recipients,
    flags: computeFlags(parts.apiScope, parts.prevent, willAlert),
  };
}

/** Natural identity key: budgets colliding on this key are duplicates (last wins). */
function naturalKey(desired) {
  if (desired.apiScope === "user") return `user|${desired.user}`;
  if (desired.apiScope === "cost_center" || desired.apiScope === "multi_user_cost_center") {
    // Key by the cost center NAME (unique per enterprise). Do not use entityId:
    // in dry-run every auto-created cost center shares the placeholder id, which
    // would falsely collide budgets for different cost centers.
    return `${desired.apiScope}|${desired.entity || desired.entityId}`;
  }
  if (desired.apiScope === "organization") return `organization|${desired.entity}`;
  return desired.apiScope; // multi_user_customer, enterprise
}

function skuMatches(live) {
  return (
    live.budget_product_sku === BUDGET_SKU ||
    (Array.isArray(live.budget_product_skus) && live.budget_product_skus.includes(BUDGET_SKU))
  );
}

function findLiveBudget(liveBudgets, desired) {
  return (
    liveBudgets.find((liveBudget) => {
      if (liveBudget.budget_scope !== desired.apiScope || !skuMatches(liveBudget)) return false;
      if (desired.apiScope === "user") return liveBudget.user === desired.user;
      if (desired.apiScope === "cost_center" || desired.apiScope === "multi_user_cost_center") {
        return liveBudget.budget_entity_name === desired.entity || (desired.entityId && liveBudget.budget_entity_name === desired.entityId);
      }
      if (desired.apiScope === "organization") return liveBudget.budget_entity_name === desired.entity;
      return true; // multi_user_customer, enterprise
    }) || null
  );
}

function budgetIsCurrent(live, desired) {
  const liveRecipients = (live.budget_alerting?.alert_recipients || []).slice().sort();
  const wantRecipients = desired.recipients.slice().sort();
  return (
    live.budget_amount === desired.amount &&
    live.prevent_further_usage === desired.prevent &&
    (live.budget_alerting?.will_alert || false) === desired.willAlert &&
    JSON.stringify(liveRecipients) === JSON.stringify(wantRecipients)
  );
}

function buildCreatePayload(desired) {
  const payload = {
    budget_scope: desired.apiScope,
    budget_amount: desired.amount,
    prevent_further_usage: desired.prevent,
    budget_product_sku: BUDGET_SKU,
    budget_type: BUDGET_TYPE,
    budget_alerting: { will_alert: desired.willAlert, alert_recipients: desired.recipients },
  };
  if (desired.user) payload.user = desired.user;
  if (desired.entityId) payload.budget_entity_name = desired.entityId; // cost center: send the ID
  else if (desired.entity && desired.apiScope === "organization") payload.budget_entity_name = desired.entity;
  return payload;
}

function buildPatchPayload(desired) {
  return {
    budget_amount: desired.amount,
    prevent_further_usage: desired.prevent,
    budget_alerting: { will_alert: desired.willAlert, alert_recipients: desired.recipients },
  };
}

function toAction(desired) {
  return {
    policy: desired.policy,
    scope: desired.scope,
    resolution: desired.resolution,
    apiScope: desired.apiScope,
    entity: desired.entity || desired.user || "",
    flags: desired.flags,
  };
}

function targetOf(desired) {
  if (desired.apiScope === "multi_user_customer") return "all licensed users";
  return desired.entity || desired.user || "enterprise";
}

function summarizeRecipients(recipients) {
  return recipients.length ? `${recipients.length} [${recipients.join(", ")}]` : "0";
}

function summarizeCounts(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item) || "(unknown)";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => `${key}=${count}`).join(", ") || "none";
}

function configBudgetTarget(budget) {
  if (budget.scope === "user") return `users=${Array.isArray(budget.users) ? budget.users.join(", ") : "(missing)"}`;
  if (budget.scope === "cost_center") return `cost_center=${budget.cost_center || "(missing)"}`;
  if (budget.scope === "team") return `team=${budget.team || "(missing)"}`;
  if (budget.scope === "organization") return `organization=${budget.organization || "(missing)"}`;
  if (budget.scope === "all_users") return "target=all licensed users";
  return "target=enterprise";
}

function describeConfigBudget(budget, index, total) {
  const label = budget.name || budget.scope || `budget-${index + 1}`;
  const metered = Object.hasOwn(budget, "metered_credits_only") ? budget.metered_credits_only : "default";
  const enforce = Object.hasOwn(budget, "enforce") ? budget.enforce : "default";
  const allowShared = Object.hasOwn(budget, "allow_shared_cost_center") ? budget.allow_shared_cost_center : "default";
  const alerts = Array.isArray(budget.alerts) ? summarizeRecipients(budget.alerts) : "0";
  return `${index + 1}/${total} ${label}: scope=${budget.scope}, ${configBudgetTarget(budget)}, amount=$${budget.amount}, metered_credits_only=${metered}, enforce=${enforce}, alerts=${alerts}, allow_shared_cost_center=${allowShared}`;
}

function describeDesired(desired) {
  return `${desired.policy}: scope=${desired.scope}, api_scope=${desired.apiScope}, target=${targetOf(desired)}, amount=$${desired.amount}, prevent_further_usage=${desired.prevent}, alerts=${summarizeRecipients(desired.recipients)}, flags=${desired.flags.join(", ")}, resolution=${desired.resolution}`;
}

function describeLiveBudget(live) {
  const target = live.user || live.budget_entity_name || "enterprise";
  const recipients = live.budget_alerting?.alert_recipients || [];
  return `id=${live.id || "(missing)"}, scope=${live.budget_scope}, target=${target}, amount=$${live.budget_amount}, prevent_further_usage=${live.prevent_further_usage}, alerts=${summarizeRecipients(recipients)}`;
}

function compactJson(value) {
  return JSON.stringify(value);
}

// ── Resolution (may create/assign a cost center) ─────────────────────────────
async function resolveGroupCostCenter(ctx, { targetType, targetName, allowShared, label }) {
  const { client, enterprise, costCenters, dryRun, result, log, debug } = ctx;
  debug(`${label}: resolving ${targetType} target "${targetName}" (dryRun=${dryRun}, allow_shared_cost_center=${allowShared}).`);
  let resolvedTargetName = targetName;
  if (targetType === "team" && !dryRun) {
    debug(`${label}: resolving enterprise team slug for "${targetName}".`);
    resolvedTargetName = await resolveEnterpriseTeamSlug(client, enterprise, targetName);
    debug(`${label}: enterprise team target "${targetName}" resolved to "${resolvedTargetName}".`);
  }
  debug(`${label}: scanning ${costCenters.length} active cost center(s) for ${targetType} "${resolvedTargetName}".`);
  const existing = findCostCenterForResource(costCenters, targetType, resolvedTargetName);

  if (existing) {
    debug(`${label}: found containing cost center "${existing.name}" (id=${existing.id}, resources=${(existing.resources || []).length}).`);
    const others = otherResourcesOf(existing, targetType, resolvedTargetName);
    if (others.length > 0) {
      result.sharedCostCenters.push({
        policy: label,
        costCenter: existing.name,
        target: `${targetType} ${resolvedTargetName}`,
        otherResources: others,
        applied: allowShared === true,
      });
      if (!allowShared) {
        log(`SKIP ${label}: cost center "${existing.name}" is shared (also holds: ${others.join(", ")}). Set allow_shared_cost_center: true to budget it.`);
        return null;
      }
      log(`WARN ${label}: budgeting shared cost center "${existing.name}" (also affects: ${others.join(", ")}).`);
    }
    return { ccId: existing.id, ccName: existing.name, resolution: `existing CC ${existing.name}` };
  }

  const ccName = derivedCostCenterName(targetType, resolvedTargetName);
  debug(`${label}: no containing cost center found; derived cost center name "${ccName}".`);
  const namedCostCenter = findCostCenterByName(costCenters, ccName);
  if (namedCostCenter) {
    debug(`${label}: found derived-name cost center "${namedCostCenter.name}" (id=${namedCostCenter.id}, resources=${(namedCostCenter.resources || []).length}).`);
    const others = otherResourcesOf(namedCostCenter, targetType, resolvedTargetName);
    if (others.length > 0) {
      result.sharedCostCenters.push({
        policy: label,
        costCenter: namedCostCenter.name,
        target: `${targetType} ${resolvedTargetName}`,
        otherResources: others,
        applied: allowShared === true,
      });
      if (!allowShared) {
        log(`SKIP ${label}: cost center "${namedCostCenter.name}" exists but is shared (also holds: ${others.join(", ")}). Set allow_shared_cost_center: true to budget it.`);
        return null;
      }
      log(`WARN ${label}: assigning ${targetType} ${resolvedTargetName} to shared cost center "${namedCostCenter.name}" (also affects: ${others.join(", ")}).`);
    }
    if (dryRun) {
      log(`DRY RUN: would assign ${targetType} ${resolvedTargetName} to existing cost center "${namedCostCenter.name}".`);
    } else {
      const assignBody = assignBodyFor(targetType, resolvedTargetName);
      debug(`${label}: assigning ${targetType} to cost center "${namedCostCenter.name}" with body=${compactJson(assignBody)}.`);
      await assignResource(client, enterprise, namedCostCenter.id, assignBody);
      namedCostCenter.resources = [...(namedCostCenter.resources || []), { type: targetType === "team" ? "Team" : "Organization", name: resolvedTargetName }];
      log(`Assigned ${targetType} ${resolvedTargetName} to existing cost center "${namedCostCenter.name}".`);
    }
    return { ccId: namedCostCenter.id, ccName: namedCostCenter.name, resolution: `existing CC ${namedCostCenter.name} (assigned ${targetType})` };
  }
  if (dryRun) {
    log(`DRY RUN: would create cost center "${ccName}" and assign ${targetType} ${resolvedTargetName}.`);
    // Record the create once per cost center name (several budgets may target it).
    if (!result.costCentersCreated.some((costCenter) => costCenter.name === ccName)) {
      result.costCentersCreated.push({ name: ccName, assigned: `${targetType} ${resolvedTargetName}`, forPolicy: label });
    }
    return { ccId: PLACEHOLDER_CC_ID, ccName, resolution: `CC ${ccName} (would create + assign ${targetType})` };
  }

  const created = await createCostCenter(client, enterprise, ccName);
  try {
    const assignBody = assignBodyFor(targetType, resolvedTargetName);
    debug(`${label}: created cost center "${created.name}" (id=${created.id}); assigning ${targetType} with body=${compactJson(assignBody)}.`);
    await assignResource(client, enterprise, created.id, assignBody);
  } catch (error) {
    const detail = describeError(error);
    try {
      await deleteCostCenter(client, enterprise, created.id);
      log(`Rolled back cost center "${created.name}" after failing to assign ${targetType} ${targetName}.`);
    } catch (cleanupError) {
      log(`WARN: could not roll back cost center "${created.name}" after assignment failure: ${describeError(cleanupError)}`);
    }
    throw new Error(`created cost center "${created.name}" but could not assign ${targetType} ${resolvedTargetName}: ${detail}`);
  }
  costCenters.push({
    id: created.id,
    name: created.name,
    state: "active",
    resources: [{ type: targetType === "team" ? "Team" : "Organization", name: resolvedTargetName }],
  });
  result.costCentersCreated.push({ name: created.name, assigned: `${targetType} ${resolvedTargetName}`, forPolicy: label });
  log(`Created cost center "${created.name}" (id=${created.id}) and assigned ${targetType} ${resolvedTargetName}.`);
  return { ccId: created.id, ccName: created.name, resolution: `CC ${created.name} (created + assigned ${targetType})` };
}

/** Resolve one config budget into zero or more desired API budgets. */
async function resolveBudget(budget, ctx) {
  const { costCenters, debug } = ctx;
  const scope = budget.scope;
  const amount = budget.amount;
  const recipients = Array.isArray(budget.alerts) ? budget.alerts.slice() : [];
  const meteredOnly = budget.metered_credits_only === true;
  const allowShared = budget.allow_shared_cost_center === true;
  const label = budget.name || scope;
  const common = { policy: label, scope, amount, recipients };

  switch (scope) {
    case "all_users":
      debug(`${label}: direct all-users per-user budget.`);
      return [makeDesired({ ...common, resolution: "DIRECT", apiScope: "multi_user_customer", prevent: true })];

    case "enterprise":
      debug(`${label}: direct enterprise metered budget (enforce=${enforceOf(budget)}).`);
      return [makeDesired({ ...common, resolution: "DIRECT", apiScope: "enterprise", prevent: enforceOf(budget) })];

    case "user":
      debug(`${label}: expanding user budget to ${budget.users.length} login(s): ${budget.users.join(", ")}.`);
      return budget.users.map((login) =>
        makeDesired({ ...common, resolution: "DIRECT", apiScope: "user", user: login, prevent: true }),
      );

    case "cost_center": {
      const costCenterId = resolveCostCenterId(costCenters, budget.cost_center);
      debug(`${label}: cost center lookup "${budget.cost_center}" -> ${costCenterId || "not found"}.`);
      if (!costCenterId) {
        throw new Error(`cost center "${budget.cost_center}" not found (create it in GitHub, or use scope: team to auto-provision one).`);
      }
      const apiScope = meteredOnly ? "cost_center" : "multi_user_cost_center";
      return [
        makeDesired({
          ...common,
          resolution: `existing CC ${budget.cost_center}`,
          apiScope,
          entity: budget.cost_center,
          entityId: costCenterId,
          prevent: meteredOnly ? enforceOf(budget) : true,
        }),
      ];
    }

    case "organization":
      // Always a direct, collective metered cap (like enterprise, scoped to one
      // org). A per-user org budget would need multi_user_cost_center, which the
      // API only accepts on a cost center of USER members — an Org resource is
      // rejected — so v3 does not enumerate org members. Use all_users or
      // scope: user for per-user pool coverage.
      debug(`${label}: direct organization metered budget for "${budget.organization}" (enforce=${enforceOf(budget)}).`);
      return [
        makeDesired({ ...common, resolution: "DIRECT", apiScope: "organization", entity: budget.organization, prevent: enforceOf(budget) }),
      ];

    case "team": {
      const group = await resolveGroupCostCenter(ctx, { targetType: "team", targetName: budget.team, allowShared, label });
      if (!group) return [];
      const apiScope = meteredOnly ? "cost_center" : "multi_user_cost_center";
      return [
        makeDesired({ ...common, resolution: group.resolution, apiScope, entity: group.ccName, entityId: group.ccId, prevent: meteredOnly ? enforceOf(budget) : true }),
      ];
    }

    default:
      throw new Error(`unsupported scope "${scope}".`);
  }
}

async function applyBudget(desired, ctx) {
  const { client, enterprise, liveBudgets, dryRun, log, debug } = ctx;
  const base = toAction(desired);
  const live = findLiveBudget(liveBudgets, desired);
  const target = targetOf(desired);
  const key = naturalKey(desired);
  debug(`${desired.policy}: matching desired budget key=${key} against ${liveBudgets.length} live budget(s).`);

  if (!live) {
    const createPayload = buildCreatePayload(desired);
    debug(`${desired.policy}: no live budget matched; create payload=${compactJson(createPayload)}.`);
    if (dryRun) {
      log(`DRY RUN: would CREATE ${desired.policy} (${desired.apiScope} ${target}) $${desired.amount}`);
      return { ...base, action: "CREATE", oldAmount: null, newAmount: desired.amount };
    }
    try {
      await createBudget(client, enterprise, createPayload);
      log(`Created budget ${desired.policy} (${desired.apiScope} ${target}).`);
      return { ...base, action: "CREATE", oldAmount: null, newAmount: desired.amount };
    } catch (error) {
      const rawError = describeError(error);
      const note = explainApiError(rawError);
      log(`ERROR creating ${desired.policy}: ${rawError}`);
      return { ...base, action: "ERROR", oldAmount: null, newAmount: desired.amount, note };
    }
  }

  const oldAmount = live.budget_amount ?? null;
  debug(`${desired.policy}: matched live budget ${describeLiveBudget(live)}.`);
  debug(`${desired.policy}: desired state ${describeDesired(desired)}.`);
  if (budgetIsCurrent(live, desired)) {
    log(`NO CHANGE ${desired.policy} (${desired.apiScope} ${target}) already matches amount=$${desired.amount}, prevent_further_usage=${desired.prevent}, alerts=${summarizeRecipients(desired.recipients)}.`);
    return { ...base, action: "NO CHANGE", oldAmount, newAmount: desired.amount };
  }
  const patchPayload = buildPatchPayload(desired);
  debug(`${desired.policy}: patch payload=${compactJson(patchPayload)}.`);
  if (dryRun) {
    log(`DRY RUN: would UPDATE ${desired.policy} (${desired.apiScope} ${target}) $${oldAmount} -> $${desired.amount}`);
    return { ...base, action: "UPDATE", oldAmount, newAmount: desired.amount };
  }
  try {
    await patchBudget(client, enterprise, live.id, patchPayload);
    log(`Updated budget ${desired.policy} (id=${live.id}).`);
    return { ...base, action: "UPDATE", oldAmount, newAmount: desired.amount };
  } catch (error) {
    const rawError = describeError(error);
    const note = explainApiError(rawError);
    log(`ERROR updating ${desired.policy}: ${rawError}`);
    return { ...base, action: "ERROR", oldAmount, newAmount: desired.amount, note };
  }
}

/**
 * Apply all budgets in a config.
 * @param {object} args
 * @param {import("./github/client.js").GitHubClient} args.client
 * @param {object} args.config - A validated v3 config document.
 * @param {string} args.enterprise
 * @param {string} [args.configSource]
 * @param {boolean} [args.dryRun]
 * @param {boolean} [args.verbose]
 * @returns {Promise<import("./report.js").ApplyResult>}
 */
export async function applyBudgets({ client, config, enterprise, configSource = "", dryRun = true, onLog, verbose = false }) {
  const result = {
    mode: dryRun ? "dry-run" : "live",
    enterprise,
    configSource,
    actions: [],
    costCentersCreated: [],
    duplicates: [],
    sharedCostCenters: [],
    errors: [],
    log: [],
  };
  const log = (message) => {
    result.log.push(message);
    if (typeof onLog === "function") onLog(message);
  };
  const debug = (message) => {
    if (verbose) log(`DEBUG ${message}`);
  };
  const budgets = Array.isArray(config?.budgets) ? config.budgets : [];

  log(`Config source: ${configSource || "(inline)"}; mode=${dryRun ? "dry-run" : "live"}; declared budgets=${budgets.length}.`);
  log(`Budget scope counts: ${summarizeCounts(budgets, (budget) => budget.scope)}.`);

  if (budgets.length === 0) {
    log("No budgets in config; nothing to apply.");
    return result;
  }

  log(`Applying ${budgets.length} budget(s) for enterprise "${enterprise}" (${dryRun ? "dry-run" : "live"}).`);

  let liveBudgets = [];
  try {
    liveBudgets = await listBudgets(client, enterprise);
    log(`Loaded ${liveBudgets.length} existing budget(s).`);
    debug(`Live budget scope counts: ${summarizeCounts(liveBudgets, (liveBudget) => liveBudget.budget_scope)}.`);
    debug(`Live budget sample: ${liveBudgets.slice(0, 10).map(describeLiveBudget).join("; ") || "none"}.`);
  } catch (error) {
    const message = `could not list existing budgets (${describeError(error)}); refusing to apply because creates would be unsafe without a baseline.`;
    result.errors.push({ policy: "preflight", message });
    log(`ERROR: ${message}`);
    return result;
  }

  let costCenters = [];
  try {
    costCenters = await listCostCenters(client, enterprise);
    log(`Loaded ${costCenters.length} active cost center(s).`);
    debug(`Active cost center sample: ${costCenters.slice(0, 10).map((costCenter) => `${costCenter.name} (id=${costCenter.id}, resources=${(costCenter.resources || []).length})`).join("; ") || "none"}.`);
  } catch (error) {
    log(`WARN: could not list cost centers (${describeError(error)}); team and cost_center budgets may not resolve.`);
  }

  const ctx = { client, enterprise, costCenters, liveBudgets, dryRun, result, log, debug };

  // Resolve every config budget into desired API budgets.
  const desired = [];
  for (const [index, budget] of budgets.entries()) {
    try {
      log(`Resolving budget ${describeConfigBudget(budget, index, budgets.length)}.`);
      const resolved = await resolveBudget(budget, ctx);
      for (const resolvedBudget of resolved) {
        log(`Resolved ${resolvedBudget.policy}: ${resolvedBudget.scope} -> ${resolvedBudget.apiScope} target=${targetOf(resolvedBudget)} amount=$${resolvedBudget.amount} prevent_further_usage=${resolvedBudget.prevent} alerts=${summarizeRecipients(resolvedBudget.recipients)} [${resolvedBudget.resolution}]`);
        debug(`Desired budget ${describeDesired(resolvedBudget)}; natural_key=${naturalKey(resolvedBudget)}.`);
      }
      desired.push(...resolved);
    } catch (error) {
      result.errors.push({ policy: budget.name || budget.scope, message: describeError(error) });
      log(`ERROR resolving ${budget.name || budget.scope}: ${describeError(error)}`);
    }
  }

  // Duplicate detection: budgets colliding on a natural key — last in config order wins.
  const budgetsByKey = new Map();
  for (const desiredBudget of desired) {
    const key = naturalKey(desiredBudget);
    if (!budgetsByKey.has(key)) budgetsByKey.set(key, []);
    budgetsByKey.get(key).push(desiredBudget);
  }
  const skipped = new Set();
  for (const group of budgetsByKey.values()) {
    if (group.length < 2) continue;
    const losers = group.slice(0, -1);
    const winner = group[group.length - 1];
    for (const loser of losers) skipped.add(loser);
    result.duplicates.push({
      entity: winner.entity || winner.user || winner.apiScope,
      policies: group.map((entry) => entry.policy),
      winner: winner.policy,
      skipped: losers.map((loser) => loser.policy),
    });
    log(`WARN duplicate target ${winner.entity || winner.user || winner.apiScope}: policies=${group.map((entry) => entry.policy).join(", ")}; winner=${winner.policy}.`);
    debug(`Duplicate natural key ${naturalKey(winner)}: skipped=${losers.map((loser) => loser.policy).join(", ")}, winner=${winner.policy}.`);
  }

  log(`Resolved ${desired.length} desired API budget(s); ${skipped.size} duplicate item(s) will be skipped.`);

  // Apply (or preview) each desired budget.
  log(`${dryRun ? "Planning" : "Applying"} ${desired.length - skipped.size} budget operation(s).`);
  for (const desiredBudget of desired) {
    if (skipped.has(desiredBudget)) {
      result.actions.push({ ...toAction(desiredBudget), action: "SKIP", oldAmount: null, newAmount: desiredBudget.amount, note: "duplicate (last wins)" });
      continue;
    }
    result.actions.push(await applyBudget(desiredBudget, ctx));
  }

  log(`Apply complete: actions=${result.actions.length}, cost_centers_created=${result.costCentersCreated.length}, duplicate_groups=${result.duplicates.length}, errors=${result.errors.length}.`);

  return result;
}
