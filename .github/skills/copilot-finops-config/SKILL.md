---
name: copilot-finops-config
description: "Use when: creating, updating, reviewing, or validating Copilot FinOps config for config/copilot-finops.yml (v3, budgets-first), AI-credit budgets, all-users budgets, per-user budgets, cost center budgets, team budgets, organization budgets, and enterprise caps for GitHub Copilot."
argument-hint: "Describe the budgets you want (scope, amount, teams/orgs/cost centers/users), the target file path, and whether it is tracked or a private .local.yml."
---

# Copilot FinOps Config

Use this skill to help users create valid Copilot FinOps configuration for this repository.

There is one config contract: **v3**, a single **budgets-first** file.

- Tracked config: `config/copilot-finops.yml`, declaring `version: 3`.
- Private/local config: `config/copilot-finops.local.yml` (gitignored).
- The file holds one optional `budgets:` list. Omit it (or use `[]`) for a valid no-op.

v3 manages **AI-credit budgets only**. It does **not** do per-member cost-center sync, and there is
no issue-based config form — both were removed with the legacy Bash implementation.

## No enterprise field

There is **no** `enterprise` / `enterprise_slug` field in v3. The enterprise slug is supplied to the
action/CLI as the `enterprise` input (from the `COPILOT_FINOPS_ENTERPRISE` variable), so real slugs
never live in tracked config. Never add an enterprise field to generated config.

## Source of truth for structure

The authoritative shape — every field, every enum value, and which fields are required or forbidden
per `scope` — lives in three files, not in this skill:

- **Schema:** `schemas/v3/copilot-finops.schema.json`.
- **Generated field reference:** `docs/config-schema.md`.
- **Worked example:** `config/copilot-finops.example.yml` (covers every scope).

The reference files below give idiomatic examples and the judgment the schema cannot express (which
scope to pick, what to ask). When prose disagrees with the schema/example, the schema and example
win. Do not invent fields or relax a per-scope rule from memory — author config to pass the schema,
then confirm with the validator (see `./references/validation.md`).

## The budget fields

Each entry in `budgets:` is one budget:

| Field | Notes |
| --- | --- |
| `scope` | **Required.** One of `all_users`, `user`, `cost_center`, `team`, `organization`, `enterprise`. |
| `amount` | **Required.** Whole USD (integer ≥ 0). |
| `name` | Optional local label (logs/report only; never sent to GitHub). |
| `description` | Optional human-readable note. |
| `metered_credits_only` | Boolean, default `false`. On `cost_center`/`team`: `true` = collective metered cap, `false` = per-user pool+metered cap. On `organization`: use `true` (or omit it); `false` (a per-member org budget) is **not yet supported**. |
| `enforce` | Boolean, default `true`. **Only** on collective metered budgets (`enterprise` or `organization`, or `cost_center`/`team` with `metered_credits_only: true`). `false` = alert-only. Forbidden elsewhere (pool/per-user budgets always hard-stop). |
| `users` | **Required for `scope: user`**, forbidden elsewhere. Non-empty list of logins; each gets its own hard-stop budget. |
| `cost_center` | **Required for `scope: cost_center`**, forbidden elsewhere. Name of an existing cost center. |
| `team` | **Required for `scope: team`**, forbidden elsewhere. Prefer the bare enterprise team slug (no `ent:` prefix); apply also resolves display names and `ent:<slug>` to the canonical slug. |
| `organization` | **Required for `scope: organization`**, forbidden elsewhere. Org login. The budget is a direct collective metered cap (no cost center); use `metered_credits_only: true` (or omit it) — `false` (per-member) is not yet supported. |
| `alerts` | Optional list of logins to notify. A non-empty list enables alerting. |
| `allow_shared_cost_center` | Boolean, default `false`. **Only** on `team`. `true` budgets a cost center even if it holds other resources. |

## What each scope does

- `all_users` — per-user cap for every licensed user (pool + metered, always hard-stop).
- `user` — per-user cap for each login in `users` (pool + metered, always hard-stop; overrides the universal and cost-center per-user budgets).
- `cost_center` — default: per-member pool+metered cap for a **named existing** cost center; `metered_credits_only: true`: the cost center's collective metered cap.
- `team` — applied through the enterprise team's cost center (found, or **created** and the team assigned). Default: per-member cap; `metered_credits_only: true`: the cost center's collective metered cap.
- `organization` — a **direct** cap on the org's collective metered spend after the pool (no cost center); use `metered_credits_only: true` (or omit it). The per-member org path (`metered_credits_only: false`) is **not yet supported** — to cap specific org users per-member, put them in an enterprise team and budget it with `scope: team`.
- `enterprise` — one enterprise-wide collective metered cap after the pool.

## Core rules

1. Ask clarifying questions before creating config unless the user already gave all required values (see `./references/interview.md`).
2. Prefer config-as-code in reviewed files for production; use `config/copilot-finops.local.yml` for private/local config.
3. Every file sets `version: 3`. `budgets` is optional (omit for a no-op).
4. Never add an enterprise/`enterprise_slug` field — the slug is an action input.
5. Use AI-credit terminology only. Never use deprecated request-based billing terms.
6. Never add a product SKU or budget type — the engine defaults to `ai_credits`.
7. Set `enforce` **only** on collective metered budgets (`enterprise` or `organization`, or `cost_center`/`team` with `metered_credits_only: true`). Omit it on `all_users`, `user`, and default (per-member) `cost_center`/`team` — they always hard-stop.
8. Set `metered_credits_only` on `cost_center`, `team`, or `organization`. On `organization` use `true` (or omit it); `metered_credits_only: false` (a per-member org budget) is **not yet supported**.
9. Set `allow_shared_cost_center` only on `team`.
10. Uniqueness: at most one `all_users`, at most one `enterprise`, at most one `organization` budget per org, and at most one budget per (`cost_center` + `metered_credits_only` setting). `all_users` is optional, not required.
11. `scope: cost_center` needs an **existing** cost center. If the user wants one auto-created, use `scope: team` instead. A `scope: organization` budget is written directly (no cost center).
12. Validate generated files with `node bin/copilot-finops.js validate <file>` (see `./references/validation.md`).
13. When repository requirements change, keep this skill and `AGENTS.md` in sync.

## Workflow

1. Ask the necessary questions from `./references/interview.md`.
2. Choose the right patterns:
   - `./references/budgets.md` — every budget scope, with examples.
   - `./references/cost-centers.md` — how `team` budgets resolve or create cost centers, and the shared-cost-center safety.
3. Generate minimal YAML with only the needed fields, grounded in the schema and `config/copilot-finops.example.yml`.
4. Validate with `./references/validation.md`.
5. Explain how to run `finops-apply.yml` (dry-run first) or the CLI. Mention `log_level=debug` only when the operator needs detailed live diagnostics.

## Output guidance

- Write to `config/copilot-finops.yml` (tracked) or `config/copilot-finops.local.yml` (private local).
- Keep public starter configs generic: `acme` (org), `platform-engineering` (team), `octocat` (login).
- Never include a real enterprise slug (there is no field for it), real user logins, cost center names, or budget amounts in tracked config unless the user has approved them for disclosure.
- Always recommend a dry-run (`finops-apply.yml` with `dry_run=true`, or `node bin/copilot-finops.js apply … --enterprise <slug>` without `--live`) before a live apply.
- Workflow live logging defaults to `log_level=info`, which streams apply progress plus the plain-text report. Use `warn` for quieter routine runs, or `debug` for budget-resolution, matching, payload, request, retry, and pagination diagnostics. The job summary still contains the full report; `DEBUG` entries in its full run log appear only at `log_level=debug`.
