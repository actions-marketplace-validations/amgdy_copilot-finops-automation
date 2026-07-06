# Budget Patterns (v3)

Budgets live under `budgets:` in `config/copilot-finops.yml` (or `config/copilot-finops.local.yml`).
A v3 file declares `version: 3`; `budgets` is optional. Each budget requires `scope` and `amount`.

> **Authoritative shape:** the full field list, enums, and per-`scope` required/forbidden rules live
> in `schemas/v3/copilot-finops.schema.json`, `docs/config-schema.md`, and
> `config/copilot-finops.example.yml`. If this file disagrees with the schema, the schema wins.

There is no product SKU or budget type surface (the engine defaults to `ai_credits`), and there is
no enterprise field (the slug is an action input).

## No-op config

```yaml
version: 3
```

Or explicitly empty:

```yaml
version: 3
budgets: []
```

## All-users default (per user)

Per-user cap for every licensed user. Covers pool + metered; always hard-stop. At most one.

```yaml
budgets:
  - name: all-users-default
    scope: all_users
    amount: 50
```

## Individual users

One hard-stop budget per login; overrides the universal and cost-center per-user budgets for those
logins. Always hard-stop.

```yaml
budgets:
  - name: power-users
    scope: user
    users: [octocat, monalisa]
    amount: 75
```

## Cost center — per member (default)

Per-member pool+metered cap for a **named, existing** cost center. Always hard-stop.

```yaml
budgets:
  - name: engineering-per-user
    scope: cost_center
    cost_center: engineering
    amount: 20
```

## Cost center — collective metered

Caps the cost center's collective metered spend after the pool. `enforce: false` = alert-only.

```yaml
budgets:
  - name: engineering-metered-cap
    scope: cost_center
    cost_center: engineering
    metered_credits_only: true
    amount: 500
    enforce: false
    alerts: [eng-billing-admin]
```

> `scope: cost_center` needs a cost center that already exists. To auto-create one, use `scope: team`
> or `scope: organization` (see `./cost-centers.md`).

## Team — per member (default)

Per-member pool+metered cap, applied through the enterprise team's cost center (found, or created and
the team assigned to it). Always hard-stop. Prefer a bare team slug (no `ent:` prefix); apply also
resolves display names and `ent:<slug>` values to the canonical slug.

```yaml
budgets:
  - name: platform-team-per-user
    scope: team
    team: platform-engineering
    amount: 25
```

## Team — collective metered

Caps that team's cost center's collective metered spend. `allow_shared_cost_center: true` lets it
budget a cost center that also holds other resources (default false skips a shared cost center and
reports it).

```yaml
budgets:
  - name: platform-team-metered
    scope: team
    team: platform-engineering
    metered_credits_only: true
    amount: 300
    enforce: false
    allow_shared_cost_center: true
```

## Organization — direct collective metered

`scope: organization` is a **direct** cap on the org's collective metered spend after the pool (no
cost center). Use `metered_credits_only: true` (or omit it); `metered_credits_only: false` (a
per-member org budget) is **not yet supported** — to cap specific org users per-member, put them in an
enterprise team and budget it with `scope: team`. `enforce: false` = alert-only.
At most one per org. For per-user coverage, use `all_users` or `scope: user`.

```yaml
budgets:
  - name: acme-org-metered-cap
    scope: organization
    organization: acme
    metered_credits_only: true
    amount: 4000
    enforce: false
```

## Enterprise cap

One enterprise-wide collective metered cap after the pool. `enforce` optional (default true). At most
one.

```yaml
budgets:
  - name: enterprise-cap
    scope: enterprise
    amount: 5000
    enforce: false
    alerts: [billing-admin]
```

## Alerts

Optional on any budget: list the logins to notify. A non-empty `alerts` enables alerting.

```yaml
alerts: [copilot-admin]
```

## Validate and dry-run

See `./validation.md`. Quick check after authoring:

```bash
node bin/copilot-finops.js validate config/copilot-finops.yml
```

For workflow dry-runs, `log_level=info` is the default. Use `warn` for quieter runs or `debug` for
budget-resolution, matching, payload, request, retry, and pagination diagnostics. `DEBUG` entries in
the summary's full run log appear only at `log_level=debug`.
