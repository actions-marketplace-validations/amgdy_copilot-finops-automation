# Troubleshooting

## Config validation fails

Run the validator directly so the error points at the config file before any API call happens (no token needed):

```bash
node bin/copilot-finops.js validate config/copilot-finops.yml
```

Common causes:

- The file is missing `version: 3`.
- A budget is missing the field its `scope` requires: `users` for `scope: user`, `cost_center` for `scope: cost_center`, `team` for `scope: team`, `organization` for `scope: organization`.
- A budget sets a field its `scope` forbids (for example `users` on a `team` budget, or `cost_center` on an `all_users` budget).
- `amount` is missing or is not a whole number.
- `enforce` is set on a budget that is always hard-stop (`all_users`, `user`, or a default per-member `cost_center`/`team`/`organization`). `enforce` is only allowed on collective metered budgets — `scope: enterprise`, or `cost_center`/`team`/`organization` with `metered_credits_only: true`.
- `allow_shared_cost_center` is set on a scope other than `team` or `organization`.
- More than one `all_users` budget, more than one `enterprise` budget, more than one direct `organization` (metered-only) budget, or two budgets that resolve to the same cost center with the same `metered_credits_only` setting. These uniqueness rules are enforced by the semantic layer (`src/config/validate.js`).

Schema-level errors (misspelled or wrongly nested keys) read like `must NOT have additional properties` or `must be equal to one of the allowed values`; the field reference is [docs/config-schema.md](config-schema.md).

## `apply` says a cost center was not found

```
cost center "engineering" not found (create it in GitHub, or use scope: team to auto-provision one).
```

`scope: cost_center` resolves an **existing** cost center by name. Either create that cost center in GitHub first, or use `scope: team`, which finds or **creates** the cost center and assigns the team to it automatically. (An `organization` budget is written directly and never needs a cost center.)

## `apply` skipped a team budget as "shared"

When the cost center that groups a team also holds other resources, budgeting it would affect more than the intended group, so the budget is skipped and the blast radius is reported. To budget it anyway, set `allow_shared_cost_center: true` on that budget.

## API returns 403 or 429 (rate limited)

The GitHub client retries rate-limited calls automatically, honoring `retry-after` / `x-ratelimit-reset` and otherwise backing off exponentially (capped), up to the `max-retries` input (default 10). If it still fails after the retries, re-run later or lower the number of budgets per run.

For live diagnostics, re-run with `log_level=info` or `log_level=debug` in `finops-apply.yml`. `info` is the default and prints apply progress plus the plain-text report. `debug` also prints budget resolution, live-budget matching, create/patch payloads, request parameters with sensitive fields redacted, response status, retry waits, and pagination counts. The job summary always includes the full apply report even if live logging is lowered to `warn` or `error`.

If you see FinOps lines prefixed with `[debug]`, the workflow input being passed to the action is `debug`. Set `log_level` to `info` or lower; GitHub's separate step-debug setting does not override the FinOps `log-level` input. `DEBUG` entries in the job summary's full run log follow the same setting.

## API returns 404

For `apply`, a 404 usually means one of:

- The enhanced billing API is not available for the enterprise.
- The token does not have `admin:enterprise` (or is not SSO-authorized).
- The enterprise slug (the `enterprise` input / `COPILOT_FINOPS_ENTERPRISE` variable) is wrong.

Check [docs/permissions.md](permissions.md), then re-run in dry-run where possible.

## Budgets are not deleted

This is expected. `apply` creates missing budgets and updates changed ones, but it **never deletes** budgets that were removed from config. Delete old budgets manually after review:

```text
DELETE /enterprises/{enterprise}/settings/billing/budgets/{budget_id}
```

## A budget appears to be created twice / conflicts

GitHub allows only one budget per entity. If two config budgets resolve to the same natural key (for example two budgets on the same cost center), the semantic validator flags it before apply. Fix the config so each entity is budgeted once.

## Nothing changed but I expected a change

`apply` is idempotent: it reports `NO CHANGE` when the live budget already matches config (amount, hard-stop, and alert recipients). Change the config value to see an `UPDATE`. The dry-run preview shows exactly what a live run would do.
