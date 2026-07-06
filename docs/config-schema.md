# Copilot FinOps config (v3) — field reference

> Generated from `schemas/v3/copilot-finops.schema.json` by `npm run docs:schema`. Do not edit by hand.

Schema for config/copilot-finops*.yml (version 3). v3 is budgets-first: it manages GitHub Copilot AI-credit budgets and drops the v2 ongoing per-member cost-center sync (there is no team_cost_center_mappings block). A budget's `scope` selects who it is for; `metered_credits_only` (boolean, default false) picks whether it caps the shared-pool + metered phase per user (the default) or only metered spend after the pool. There is NO `enterprise` field here — the enterprise slug is supplied only via the action's `enterprise` input, so real slugs never live in tracked config. This schema encodes shape, types, enums, typo protection (additionalProperties:false) and the per-scope required/forbidden field structure (including the metered_credits_only -> enforce gating). It targets JSON Schema draft 2020-12. Cardinality and uniqueness (at most one all_users / enterprise / organization budget, one budget per resolved cost center + metered_credits_only), plus every live lookup (cost center resolution, team membership) and value defaulting, stay in the semantic layer (src/config/validate.js) and the apply engine, not here.

## Top-level fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | `3` | yes | Config contract version. Must be 3. |
| `budgets` | array | no | List of AI-credit budgets to apply. Optional — omit it (or use []) for a no-op config. Each entry maps to exactly one GitHub budget API call (some via a resolved cost center). |

## Budget fields (`budgets[]`)

Each entry in `budgets` is one budget. `scope` selects who it is for and which fields are required or forbidden.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | string | no | — | Local label used in logs and the apply report. Never sent to the GitHub API (budgets have no name field). |
| `description` | string | no | — | Optional human-readable description of what the budget is for. |
| `amount` | integer | yes | — | Budget cap in whole USD. Maps to budget_amount. |
| `metered_credits_only` | boolean | no | `false` | false (default) caps the whole shared-pool + metered phase per user (a per-user hard-stop for the group); true caps only metered/additional spend after the pool (collective). Settable on cost_center and team, and on organization (where metered_credits_only: false — a per-member org budget — is currently gated as 'not yet supported' by the validator); fixed elsewhere (all_users/user always false; enterprise always metered) and forbidden there. |
| `users` | string[] | no | — | GitHub logins to budget; each login gets its own hard-stop user budget. Required (one or more) for scope: user; forbidden on every other scope. |
| `cost_center` | string | no | — | Cost center name (resolved to its ID at apply time). Required for scope: cost_center; forbidden on every other scope. |
| `team` | string | no | — | Enterprise team identifier. Prefer the bare slug (no ent: prefix), but apply also resolves the API slug (ent:<slug>) or display name to the canonical bare slug before assigning the team to a cost center. Required for scope: team; forbidden on every other scope. Resolved to the cost center that contains the team, or a cost center is created and the team assigned to it. |
| `organization` | string | no | — | Organization login. Required for scope: organization; forbidden on every other scope. The budget is a direct collective metered cap for the org (no cost center, no member enumeration). |
| `enforce` | boolean | no | `true` | Hard-stop usage at the cap (maps to prevent_further_usage). Allowed only on collective metered budgets (scope: enterprise or organization, or scope: cost_center/team with metered_credits_only: true); default true. Pool/per-user budgets are always hard-stop and forbid this field. |
| `alerts` | string[] | no | `[]` | GitHub logins to alert when the budget is hit. Optional; defaults to []. A non-empty list enables alerting. |
| `allow_shared_cost_center` | boolean | no | `false` | Opt in to budgeting a cost center that already holds resources beyond the target team. Only valid on scope: team. Default false: if the resolved cost center is shared, the budget is skipped and the blast radius is reported. When true, the whole cost center is budgeted. |

### `scope` values

| Value | Meaning |
| --- | --- |
| `all_users` | Universal per-user budget for every licensed user (API multi_user_customer). Covers pool + metered; always hard-stop. |
| `user` | Individual per-user budget for each login in `users` (API user). Covers pool + metered; always hard-stop; overrides the universal and cost-center user-level budgets. |
| `cost_center` | Budget for a named cost center (`cost_center`). Default (metered_credits_only:false) = per-user pool+metered cap for every member (API multi_user_cost_center, hard-stop). metered_credits_only:true = collective metered cap for the cost center (API cost_center). |
| `team` | Budget for an enterprise team (`team`), applied through the cost center that contains it (found, or created and the team assigned). Default = per-member pool+metered cap (multi_user_cost_center); metered_credits_only:true = the cost center's collective metered cap. |
| `organization` | Budget for an organization (`organization`) — a direct cap on the org's collective metered spend after the shared pool (API organization). Use metered_credits_only: true (or omit it); the per-member path (metered_credits_only: false, a per-user ULB) is not yet supported — use all_users or scope: user for per-user coverage. Optional hard-stop via `enforce`. |
| `enterprise` | One enterprise-wide budget capping collective metered spend after the shared pool (API enterprise). Optional hard-stop via `enforce`. |

## Example

```yaml
version: 3
budgets:
  - name: all-users-default
    scope: all_users
    amount: 30
```

---

Cross-field rules (per-scope required/forbidden fields, the `metered_credits_only` → `enforce` gating) and uniqueness are enforced by the validator; see `src/config/validate.js`.
