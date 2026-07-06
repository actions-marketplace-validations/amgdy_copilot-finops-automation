# Interview Checklist

Gather only the missing information. Do not ask everything if the user already gave enough context.

## First questions

1. What budgets do you want? (any of: all-users default, specific users, a cost center, a team, an organization, an enterprise cap)
2. Should this go in a tracked file (`config/copilot-finops.yml`) or a private local file (`config/copilot-finops.local.yml`)?
3. Are the team slugs, org logins, cost center names, user logins, and amounts safe to commit?

> The enterprise slug is **not** a config field — it is set once as the `COPILOT_FINOPS_ENTERPRISE`
> repository/org variable (and passed to the action's `enterprise` input). Do not ask for it as
> config; if the user is setting up the repo, remind them to set that variable and the
> `COPILOT_FINOPS_TOKEN` secret.

## Per-scope questions

Ask only for the scopes the user wants.

**All-users default (`scope: all_users`)** — optional, at most one:

- Amount in whole USD. (Always hard-stop; no `enforce`.)

**Individual users (`scope: user`)**:

- Which logins (`users:`, one or more)?
- Amount in whole USD (applied to each login). (Always hard-stop.)

**Cost center (`scope: cost_center`)**:

- The name of an **existing** cost center. (If it should be auto-created, use a team budget instead.)
- Per-member cap (default) or the cost center's collective metered cap (`metered_credits_only: true`)?
- If collective metered: hard-stop (`enforce: true`, default) or alert-only (`enforce: false`)?
- Amount in whole USD. Alert recipients, if any (`alerts:`).

**Team (`scope: team`)**:

- Enterprise team identifier (`team:`): prefer the bare slug, but display name and `ent:<slug>` also resolve at apply time.
- Per-member cap (default) or the team's collective metered cap (`metered_credits_only: true`)?
- If collective metered: hard-stop or alert-only? Is it OK to budget the cost center even if it holds other resources (`allow_shared_cost_center: true`)?
- Amount in whole USD.

**Organization (`scope: organization`)** — a direct collective metered cap (`metered_credits_only: true`, or omit it):

- Org login (`organization:`).
- Amount in whole USD.
- Hard-stop (`enforce: true`, default) or alert-only (`enforce: false`)?
- (The per-member org path — `metered_credits_only: false` — is not yet supported; to cap specific org users per-member, put them in an enterprise team and budget it with scope: team.)

**Enterprise cap (`scope: enterprise`)** — optional, at most one:

- Amount in whole USD.
- Hard-stop (`enforce: true`, default) or alert-only (`enforce: false`)?
- Alert recipients, if any (`alerts:`).

## Safety questions

Ask before writing or suggesting production config:

- Tracked file or ignored `.local.yml`?
- Are the names/amounts safe to commit?
- Recommend a dry-run before a live apply — always.
