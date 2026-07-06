# Cost Centers in v3

v3 does **not** sync members into cost centers. Cost centers are how `team` budgets are applied, and
how a `cost_center` budget targets an existing group. An `organization` budget is written **directly**
and never uses a cost center.

## Two ways cost centers are involved

1. **`scope: cost_center`** — targets a cost center that **already exists**. The engine resolves the
   name you give in `cost_center:` to its ID. If no cost center with that name exists, apply fails
   with a clear message. Use this when the cost center is managed elsewhere.

2. **`scope: team`** — the engine finds the cost center that already contains the enterprise team,
   or **creates** one named `finops-team-<team-slug>` and assigns the team to it, then places the
   budget on that cost center.

The engine never enumerates individual members — GitHub applies a cost-center budget across the
cost center's members.

> An `organization` budget does not use a cost center at all: it is a direct collective metered cap
> on the org (GitHub rejects an org resource inside a per-member cost center, so v3 does not budget
> orgs per-user). For per-user pool coverage of an org's people, use `all_users` or `scope: user`.

## Shared cost center safety

When the cost center that groups a team **also holds other resources**, budgeting it would affect
more than the intended group. By default the budget is **skipped** and the blast radius is reported.
To budget it anyway, set `allow_shared_cost_center: true`:

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

`allow_shared_cost_center` is only valid on `scope: team`.

## Choosing cost_center vs team

- Use **`scope: team`** when you want the automation to find or create the cost center for you.
- Use **`scope: cost_center`** only when the cost center already exists and you want to target it by
  name (for example a cost center that groups something other than a single team).

## Auto-derived names

| Target | Derived cost center name |
| --- | --- |
| Enterprise team `platform-engineering` | `finops-team-platform-engineering` |

## Validate and dry-run

A dry-run shows exactly which cost centers would be created/assigned before anything is written:

```bash
node bin/copilot-finops.js apply config/copilot-finops.yml --enterprise your-enterprise
```

See `./validation.md` for the full command matrix. In workflow dry-runs, `log_level=debug` can help
diagnose cost-center lookup, derived-name matching, assignment payloads, and pagination in live logs
and the summary's full run log; use `warn` for quieter routine runs.
