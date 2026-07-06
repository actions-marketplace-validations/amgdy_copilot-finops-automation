# Setup

## Recommended: use the hosted v3 action

You do **not** need to fork this whole repository to use the FinOps engine. Keep your enterprise-specific config in your own private/internal repo, then call the reusable v3 action hosted at:

```yaml
uses: amgdy/copilot-finops-automation@v3
```

This is simpler than the previous fork-based setup: one repo hosts the engine, and every consuming enterprise repo only carries its `config/copilot-finops.yml`, `COPILOT_FINOPS_TOKEN` secret, `COPILOT_FINOPS_ENTERPRISE` variable, and workflows.

Minimal consumer config:

```yaml
version: 3
budgets:
  - name: all-users-default
    scope: all_users
    amount: 30
```

For ready-made **validate** and **apply** workflows to copy into your repo, see [Workflows → Reusable v3 action](workflows.md#reusable-v3-action).

## Prerequisites

- A GitHub repository with Actions enabled.
- A token with **`admin:enterprise`** for enterprise Copilot billing. ([Create `COPILOT_FINOPS_TOKEN`](https://github.com/settings/tokens/new?description=Copilot%20FinOps%20Automation&scopes=admin%3Aenterprise).) Save it as the repository secret **`COPILOT_FINOPS_TOKEN`**. If your enterprise enforces SAML SSO, authorize the token for SSO before running the workflow.
- Your enterprise slug stored as the repository (or organization) **Variable** `COPILOT_FINOPS_ENTERPRISE`. The slug is environment identity, not config — it is never written to a tracked config file.
- **Node.js 24+** only if you want to run the CLI (`node bin/copilot-finops.js …`) or the tests locally. The GitHub Action itself is self-contained (`node24` runtime + committed `dist/`) and needs nothing extra on the runner — no `gh`, `jq`, `yq`, or `check-jsonschema`.
- Recommended: the Red Hat **YAML** VS Code extension (`redhat.vscode-yaml`) for live in-editor validation, autocomplete, hover docs, and examples. The repository ships `.vscode/settings.json` and an extension recommendation that wire the schema in automatically.

The `validate` operation needs no token and makes no API calls. Only `apply` needs `COPILOT_FINOPS_TOKEN` and `COPILOT_FINOPS_ENTERPRISE`.

## Public repository hygiene

- Keep real enterprise slugs, organization names, team slugs, cost center names, user logins, and budget amounts out of public branches unless you have explicitly approved them for disclosure.
- Store the token only as a GitHub Actions secret. Never put it in config files, logs, reports, or markdown docs.
- Generated `reports/`, `*.log`, and `*.jsonl` files are ignored and should not be published.
- The apply workflow's `log_level` defaults to `info`, which prints apply progress and the plain-text report. Use `warn` for quieter routine runs, or `debug` for budget-resolution, matching, payload, request, retry, and pagination diagnostics. The job summary always contains the full report.
- Use a private/internal enterprise config repository for live configuration; call the hosted v3 action instead of forking the engine repo.
- Keep the `finops-apply.yml` schedule disabled until the repository has safe config and the right secret and variable configured.

## Configure the config file

All configuration lives in the single v3 file `config/copilot-finops.yml`. For the full field reference, see [docs/config-schema.md](config-schema.md) and the [Copilot FinOps skill](../.github/skills/copilot-finops-config/SKILL.md).

1. Copy the worked example into your working file: `config/copilot-finops.example.yml` → `config/copilot-finops.yml`.
2. Set `version: 3`. There is **no** enterprise field — the slug comes from the action's `enterprise` input (the `COPILOT_FINOPS_ENTERPRISE` variable).
3. Add a `budgets:` list (optional — omit it for a no-op). For each budget:
   - Set `scope` and `amount` (whole USD).
   - `scope: user` → set `users:` (one or more logins).
   - `scope: cost_center` → set `cost_center:` (an existing cost center name).
   - `scope: team` → set `team:` (prefer the bare enterprise team slug; display names and `ent:<slug>` are resolved at apply time).
   - `scope: organization` → set `organization:` (an org login). An org budget is a direct cap on the org's collective metered spend (no cost center); use `metered_credits_only: true` (or omit it) — `metered_credits_only: false` (a per-member org budget) is not yet supported.
   - On `cost_center` and `team`, `metered_credits_only: true` switches from a per-user pool+metered cap to the group's **collective metered** cap.
   - `enforce:` (default `true`) is a hard stop; it is only allowed on collective metered budgets (`scope: enterprise` or `organization`, or `cost_center`/`team` with `metered_credits_only: true`). Set `enforce: false` for an alert-only cap.
   - `alerts:` is an optional list of logins to notify when the budget is hit.
4. Do not set a product SKU or budget type — the engine defaults to `ai_credits`. User-level budgets (`all_users`, `user`, and the default per-member `cost_center`/`team`) always hard-stop.
5. Commit config changes through pull requests. `finops-validate.yml` lints every PR that touches the config.
6. Run `finops-apply.yml` manually with `dry_run=true` and review the summary before switching to `dry_run=false` or enabling the schedule.

Scheduled `apply` runs live from reviewed file-based config. Keep the schedule disabled until the repository has safe config and the right secret and variable configured.

## Cost center provisioning (team budgets)

A `scope: team` budget is applied through a cost center (a `scope: organization` budget is written directly and never uses one):

- The engine looks for the cost center that already contains the team.
- If none exists, it creates one named `finops-team-<team-slug>` and assigns the team to it.
- The budget is then placed on that cost center. The engine does **not** enumerate individual members — GitHub applies a cost-center budget across the cost center's members.

If the matched cost center already holds resources beyond the target team, the budget is **skipped** and the blast radius is reported, unless you set `allow_shared_cost_center: true`.

## Naming conventions

A budget `name:` is a local label used in logs and the apply report; it is never sent to GitHub, so you are free to standardize it. Cost center names you reference in `cost_center:` are resolved to their cost center ID at run time.

| Item | Pattern | Example |
| --- | --- | --- |
| Budget label (`name:`) | `budget-<scope>-<thing>` | `budget-team-platform-engineering` |
| Cost center for a team budget (auto-derived) | `finops-team-<team-slug>` | `finops-team-platform-engineering` |

Enterprise team slugs are best written bare in config (e.g. `team: ai-leads`), with no `ent:` prefix. If a display name is used, apply resolves it to the canonical slug before assigning the team to a cost center.

## Empty config

Keep the config present even when you have no budgets yet:

```yaml
version: 3
```

This lets `validate` and scheduled `apply` runs exit cleanly instead of failing because a file is missing.

## Copilot-assisted config authoring

This repository includes a Copilot skill at `.github/skills/copilot-finops-config/`. Use it when asking Copilot to create, update, or review budget config. The skill asks the required questions, chooses the right YAML pattern, and reminds you to validate before running the workflow.
