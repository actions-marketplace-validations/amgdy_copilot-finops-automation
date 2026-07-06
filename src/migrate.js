/**
 * v2 -> v3 config codemod.
 *
 * Reads a v2 merged config (ai_credit_spend_policies + team_cost_center_mappings)
 * and emits a v3 budgets-first config. It:
 *   - renames the vocabulary (credit_scope -> metered_credits_only, stop_at_limit
 *     -> enforce, alert_admins -> alerts, ai_credit_spend_policies -> budgets);
 *   - fans a v2 `teams: [...]` policy out into one v3 `team:` budget per team;
 *   - drops team_cost_center_mappings (v3 does no ongoing member sync);
 *   - prints any v2 enterprise_slug so it can be set as the action's `enterprise`
 *     input (v3 has no enterprise field);
 *   - warns on shapes with no clean v3 equivalent (org teams, org + per-user).
 *
 * Only v2 documents (version: 2) are accepted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import { validateConfig, formatValidationErrors } from "./config/validate.js";

function baseFields(policy) {
  const fields = {};
  if (policy.name) fields.name = policy.name;
  if (policy.description) fields.description = policy.description;
  return fields;
}

function alertsOf(policy) {
  return Array.isArray(policy.alert_admins) && policy.alert_admins.length ? policy.alert_admins.slice() : null;
}

/** Map one v2 policy to zero or more v3 budgets. */
function mapPolicy(policy, warnings) {
  const scope = policy.scope;
  const label = policy.name || scope || "policy";
  const alerts = alertsOf(policy);

  if (policy.enterprise) {
    warnings.push(`${label}: dropped per-entry enterprise override "${policy.enterprise}" (v3 takes the enterprise from the action input).`);
  }

  switch (scope) {
    case "all_users": {
      const budget = { ...baseFields(policy), scope: "all_users", amount: policy.amount };
      if (alerts) budget.alerts = alerts;
      return [budget];
    }
    case "enterprise": {
      const budget = { ...baseFields(policy), scope: "enterprise", amount: policy.amount };
      if (policy.stop_at_limit === false) budget.enforce = false;
      if (alerts) budget.alerts = alerts;
      return [budget];
    }
    case "user": {
      const budget = { ...baseFields(policy), scope: "user", users: (policy.users || []).slice(), amount: policy.amount };
      if (alerts) budget.alerts = alerts;
      return [budget];
    }
    case "cost_center": {
      // v2 cost_center is a collective metered cap.
      const budget = { ...baseFields(policy), scope: "cost_center", cost_center: policy.cost_center, metered_credits_only: true, amount: policy.amount };
      if (policy.stop_at_limit === false) budget.enforce = false;
      if (alerts) budget.alerts = alerts;
      return [budget];
    }
    case "team": {
      const teams = Array.isArray(policy.teams) ? policy.teams : policy.team ? [policy.team] : [];
      const metered = policy.credit_scope === "metered_only";
      if (policy.organization) {
        warnings.push(`${label}: v2 org team (organization: ${policy.organization}) — v3 team budgets target ENTERPRISE teams; verify these are enterprise teams.`);
      }
      if (policy.cost_center) {
        warnings.push(`${label}: dropped explicit cost_center "${policy.cost_center}"; v3 resolves or creates the team's cost center automatically.`);
      }
      if (policy.remove_extra_members) {
        warnings.push(`${label}: dropped remove_extra_members; v3 does not sync membership (managed in GitHub).`);
      }
      return teams.map((team) => {
        const budget = { ...baseFields(policy), scope: "team" };
        if (teams.length > 1 && budget.name) budget.name = `${budget.name}-${team}`;
        budget.team = team;
        if (metered) budget.metered_credits_only = true;
        budget.amount = policy.amount;
        if (metered && policy.stop_at_limit === false) budget.enforce = false;
        if (alerts) budget.alerts = alerts;
        return budget;
      });
    }
    case "organization": {
      // v3 organization is always a DIRECT collective metered cap (no cost center,
      // no per-user mode, no metered_credits_only field); enforce is always allowed.
      const metered = policy.credit_scope === "metered_only";
      const budget = { ...baseFields(policy), scope: "organization", organization: policy.organization, amount: policy.amount };
      if (policy.stop_at_limit === false) budget.enforce = false;
      if (alerts) budget.alerts = alerts;
      if (!metered) {
        warnings.push(`${label}: v2 organization + pool_then_metered was a per-user cap, which v3 does not support for orgs — migrated as a collective metered org cap. For per-user pool coverage use all_users or scope: user.`);
      }
      return [budget];
    }
    default:
      warnings.push(`skipped policy "${label}" with unsupported scope ${JSON.stringify(scope)}.`);
      return [];
  }
}

/**
 * Migrate a parsed v2 document to a v3 document.
 * @returns {{ doc: object, warnings: string[], enterprise: string }}
 */
export function migrateDoc(v2) {
  if (!v2 || typeof v2 !== "object" || Array.isArray(v2)) {
    throw new Error("input is not a config mapping.");
  }
  if (v2.version === 3) throw new Error("input is already v3.");
  if (v2.version !== 2) {
    throw new Error(
      `this codemod migrates v2 -> v3; got version ${JSON.stringify(v2.version)}.`,
    );
  }

  const warnings = [];
  const enterprise = typeof v2.enterprise_slug === "string" ? v2.enterprise_slug : "";
  const budgets = [];
  const policies = Array.isArray(v2.ai_credit_spend_policies) ? v2.ai_credit_spend_policies : [];
  for (const policy of policies) {
    budgets.push(...mapPolicy(policy, warnings));
  }

  const mappings = Array.isArray(v2.team_cost_center_mappings) ? v2.team_cost_center_mappings : [];
  if (mappings.length) {
    warnings.push(`dropped ${mappings.length} team_cost_center_mapping(s): v3 does no ongoing member sync (membership is managed in GitHub).`);
  }

  if (budgets.length === 0) {
    warnings.push(
      policies.length === 0
        ? "the source has no ai_credit_spend_policies, so the migrated config has no budgets. Did you mean to migrate a populated v2 file (e.g. config/copilot-finops.example.yml or your private config) instead of the empty starter?"
        : "no budgets were produced from the source policies (all were skipped — see the warnings above).",
    );
  }

  const doc = { version: 3 };
  if (budgets.length) doc.budgets = budgets;
  return { doc, warnings, enterprise };
}

/**
 * Migrate a v2 file to a v3 file on disk.
 * @returns {{ doc: object, outPath: string, warnings: string[], enterprise: string }}
 */
export function migrateFile(inPath, outPath) {
  const v2 = yamlLoad(readFileSync(inPath, "utf8"));
  const { doc, warnings, enterprise } = migrateDoc(v2);

  const { valid, errors } = validateConfig(doc);
  if (!valid) {
    warnings.push(`the migrated config did not fully validate — review it:\n${formatValidationErrors(errors)}`);
  }

  const header =
    `# Copilot FinOps config (v3), migrated from ${inPath}.\n` +
    `# v3 has no enterprise field — set the action's \`enterprise\` input` +
    (enterprise ? ` to: ${enterprise}\n` : ` to your enterprise slug.\n`);
  writeFileSync(outPath, header + yamlDump(doc, { lineWidth: -1, noRefs: true }));
  return { doc, outPath, warnings, enterprise };
}
