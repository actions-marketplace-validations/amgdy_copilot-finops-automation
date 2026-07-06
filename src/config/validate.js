/**
 * Validate a v3 Copilot FinOps config.
 *
 * Two layers:
 *   1. Semantic layer (this file) — the authoritative, human-friendly checks:
 *      version, unknown fields, scope/amount, per-scope required/forbidden
 *      identity fields, the metered_credits_only -> enforce gating, and
 *      uniqueness (rule 5). These produce the messages users see.
 *   2. JSON Schema gate (ajv, schemas/v3) — the same structural contract the
 *      IDE (yaml-language-server) and the schema tests use. It runs as a
 *      belt-and-suspenders gate so nothing slips past even if the semantic
 *      layer misses a shape; its (noisy) errors are only surfaced generically
 *      when the semantic layer found nothing.
 *
 * Runtime/live rules (cost center resolution, team/org membership, cross-entity
 * collisions that need a lookup) are NOT here — they live in the apply engine.
 */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../../schemas/v3/copilot-finops.schema.json" with { type: "json" };

export const CONFIG_VERSION = 3;

export const SCOPES = ["all_users", "user", "cost_center", "team", "organization", "enterprise"];

const IDENTITY_FIELDS = ["users", "cost_center", "team", "organization"];
/** The single identity field required by each scope (all_users/enterprise: none). */
const REQUIRED_IDENTITY = {
  user: "users",
  cost_center: "cost_center",
  team: "team",
  organization: "organization",
};
/** Scopes where metered_credits_only may be set (elsewhere it is fixed). */
const METERED_SCOPES = new Set(["cost_center", "team"]);
/** Scopes where allow_shared_cost_center may be set (team resolves via a cost center). */
const SHARED_CC_SCOPES = new Set(["team"]);

const ALLOWED_TOP_KEYS = new Set(["version", "budgets"]);
const ALLOWED_BUDGET_KEYS = new Set([
  "name",
  "description",
  "scope",
  "amount",
  "metered_credits_only",
  "users",
  "cost_center",
  "team",
  "organization",
  "enforce",
  "alerts",
  "allow_shared_cost_center",
]);

// ── Shared ajv validator (schema gate + reused by the schema tests) ──────────
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateSchema = ajv.compile(schema);

/** @returns {{ ok: boolean, errors: import("ajv").ErrorObject[] }} */
export function validateAgainstSchema(doc) {
  const ok = validateSchema(doc);
  return { ok, errors: ok ? [] : validateSchema.errors.slice() };
}

/** True when `enforce` is a meaningful (settable) field for this budget. */
function enforceAllowed(scope, meteredOnly) {
  return scope === "enterprise" || scope === "organization" || (METERED_SCOPES.has(scope) && meteredOnly === true);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate a parsed config document.
 * @param {unknown} doc - The parsed config (from load.js).
 * @returns {{ valid: boolean, errors: { path: string, message: string }[] }}
 */
export function validateConfig(doc) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });

  if (!isPlainObject(doc)) {
    add("(root)", "config must be a YAML mapping.");
    return { valid: false, errors };
  }

  // ── version ────────────────────────────────────────────────────────────
  if (!("version" in doc)) {
    add("version", `missing "version". This tool only supports version ${CONFIG_VERSION}.`);
  } else if (doc.version !== CONFIG_VERSION) {
    add(
      "version",
      `unsupported config version: ${JSON.stringify(doc.version)}. This tool only supports version ${CONFIG_VERSION} — migrate a v1/v2 file with \`npm run migrate\`.`,
    );
  }

  // ── unknown top-level keys ───────────────────────────────────────────────
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_TOP_KEYS.has(key)) add(key, `unknown top-level field "${key}".`);
  }

  // ── budgets ──────────────────────────────────────────────────────────────
  if ("budgets" in doc && doc.budgets !== undefined) {
    if (!Array.isArray(doc.budgets)) {
      add("budgets", "budgets must be a list.");
    } else {
      doc.budgets.forEach((budget, index) => checkBudget(budget, `budgets[${index}]`, add));
      checkUniqueness(doc.budgets, add);
    }
  }

  // ── schema gate (only surfaced if the semantic layer found nothing) ──────
  const { ok: schemaValid } = validateAgainstSchema(doc);
  if (!schemaValid && errors.length === 0) {
    add("(schema)", `config failed schema validation: ${ajv.errorsText(validateSchema.errors, { separator: "; " })}`);
  }

  return { valid: errors.length === 0, errors };
}

/** Per-budget checks (rules 1-4). */
function checkBudget(budget, path, add) {
  if (!isPlainObject(budget)) {
    add(path, "each budget must be a mapping.");
    return;
  }

  // Unknown fields (typo protection).
  for (const key of Object.keys(budget)) {
    if (!ALLOWED_BUDGET_KEYS.has(key)) add(`${path}.${key}`, `unknown field "${key}".`);
  }

  // Optional labels.
  if ("name" in budget && !isNonEmptyString(budget.name)) add(`${path}.name`, "name must be a non-empty string.");
  if ("description" in budget && typeof budget.description !== "string") add(`${path}.description`, "description must be a string.");

  // scope (rule 1).
  const scope = budget.scope;
  if (scope === undefined) {
    add(`${path}.scope`, `missing "scope" (one of: ${SCOPES.join(", ")}).`);
  } else if (!SCOPES.includes(scope)) {
    add(`${path}.scope`, `invalid scope ${JSON.stringify(scope)} (must be one of: ${SCOPES.join(", ")}).`);
  }

  // amount (rule 1).
  if (!("amount" in budget)) {
    add(`${path}.amount`, `missing "amount" (whole USD).`);
  } else if (!Number.isInteger(budget.amount) || budget.amount < 0) {
    add(`${path}.amount`, `amount must be a whole number of USD >= 0 (got ${JSON.stringify(budget.amount)}).`);
  }

  // Everything below depends on a known scope.
  if (!SCOPES.includes(scope)) return;

  const meteredOnly = budget.metered_credits_only;

  // Identity fields (rule 3): the required one present + valid; others absent.
  const requiredField = REQUIRED_IDENTITY[scope];
  for (const field of IDENTITY_FIELDS) {
    const present = field in budget && budget[field] !== undefined;
    if (field === requiredField) {
      if (!present) {
        add(`${path}.${field}`, `scope "${scope}" requires "${field}".`);
      } else {
        checkIdentityValue(field, budget[field], `${path}.${field}`, add);
      }
    } else if (present) {
      add(`${path}.${field}`, `"${field}" is not allowed for scope "${scope}".`);
    }
  }

  // metered_credits_only (rule 2).
  if ("metered_credits_only" in budget && budget.metered_credits_only !== undefined) {
    if (typeof meteredOnly !== "boolean") {
      add(`${path}.metered_credits_only`, "metered_credits_only must be a boolean.");
    } else if (scope === "organization") {
      // Org per-member (a per-user ULB) via a cost center of the org's users is a
      // planned capability, not yet implemented. Gate it here (in code), not the
      // schema: metered_credits_only is a valid boolean shape, but false is not
      // yet supported. metered_credits_only: true (or omitted) = collective metered.
      if (meteredOnly === false) {
        add(
          `${path}.metered_credits_only`,
          `Per-member (per-user) budgets for a whole organization are not yet supported. Recommended path: put the users you want to cap into an enterprise team, add that team to the organization, then budget that team with scope: team — the FinOps engine manages the enterprise team's per-member budget for you. (For an org-wide metered cap instead, set metered_credits_only: true.)`,
        );
      }
    } else if (!METERED_SCOPES.has(scope)) {
      add(
        `${path}.metered_credits_only`,
        `"metered_credits_only" is not allowed for scope "${scope}" (only cost_center, team, organization).`,
      );
    }
  }

  // enforce (rule 4).
  if ("enforce" in budget && budget.enforce !== undefined) {
    if (typeof budget.enforce !== "boolean") {
      add(`${path}.enforce`, "enforce must be a boolean.");
    } else if (!enforceAllowed(scope, meteredOnly)) {
      add(
        `${path}.enforce`,
        `"enforce" is only allowed on collective metered budgets (scope: enterprise or organization, or cost_center/team with metered_credits_only: true). Pool/per-user budgets are always hard-stop.`,
      );
    }
  }

  // allow_shared_cost_center.
  if ("allow_shared_cost_center" in budget && budget.allow_shared_cost_center !== undefined) {
    if (typeof budget.allow_shared_cost_center !== "boolean") {
      add(`${path}.allow_shared_cost_center`, "allow_shared_cost_center must be a boolean.");
    } else if (!SHARED_CC_SCOPES.has(scope)) {
      add(
        `${path}.allow_shared_cost_center`,
        `"allow_shared_cost_center" is only allowed for scope: team.`,
      );
    }
  }

  // alerts.
  if ("alerts" in budget && budget.alerts !== undefined) {
    if (!Array.isArray(budget.alerts) || !budget.alerts.every(isNonEmptyString)) {
      add(`${path}.alerts`, "alerts must be a list of non-empty login strings.");
    }
  }
}

function checkIdentityValue(field, value, path, add) {
  if (field === "users") {
    if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
      add(path, "users must be a non-empty list of login strings.");
    } else if (new Set(value).size !== value.length) {
      add(path, "users must not contain duplicate logins.");
    }
  } else if (!isNonEmptyString(value)) {
    add(path, `${field} must be a non-empty string.`);
  }
}

/** Uniqueness across budgets (rule 5, the part checkable without live lookups). */
function checkUniqueness(budgets, add) {
  let allUsers = 0;
  let enterprise = 0;
  const seenCostCenter = new Set();
  const seenOrg = new Set();

  budgets.forEach((budget, index) => {
    if (!isPlainObject(budget)) return;
    const path = `budgets[${index}]`;
    const meteredKey = budget.metered_credits_only === true ? "metered" : "pool";
    switch (budget.scope) {
      case "all_users":
        if (++allUsers > 1) add(path, "at most one all_users budget is allowed.");
        break;
      case "enterprise":
        if (++enterprise > 1) add(path, "at most one enterprise budget is allowed.");
        break;
      case "cost_center":
        if (isNonEmptyString(budget.cost_center)) {
          const key = `${budget.cost_center}|${meteredKey}`;
          if (seenCostCenter.has(key)) {
            add(path, `duplicate cost_center budget for "${budget.cost_center}" (metered_credits_only: ${budget.metered_credits_only === true}).`);
          } else {
            seenCostCenter.add(key);
          }
        }
        break;
      case "organization":
        if (isNonEmptyString(budget.organization)) {
          if (seenOrg.has(budget.organization)) {
            add(path, `duplicate organization budget for "${budget.organization}" (at most one per organization).`);
          } else {
            seenOrg.add(budget.organization);
          }
        }
        break;
      default:
        break;
    }
  });
}

/** Render validation errors as a plain, one-per-line string. */
export function formatValidationErrors(errors) {
  return errors.map((error) => `  - ${error.path}: ${error.message}`).join("\n");
}
