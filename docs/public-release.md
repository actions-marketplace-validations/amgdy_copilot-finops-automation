# Public Release Checklist

Use this checklist before publishing this repository, a fork, or a template copy.

## Remove private data

- Search tracked files for real enterprise slugs, organization names, team slugs, cost center names, user logins, alert recipients, and budget amounts.
- Replace any live `config/copilot-finops.yml` values with public-safe placeholders, or reduce it to a no-op (`version: 3`). Keep private working config in `config/*.local.yml` (gitignored).
- Remove generated audit reports, run logs, JSONL summary files, screenshots, and copied workflow output.
- Verify no token, API response, or authorization header was pasted into docs, examples, issues, or commit messages.
- Confirm the enterprise slug lives only in the `COPILOT_FINOPS_ENTERPRISE` variable, never in tracked config.

## Publish safe defaults

Keep the default config valid but harmless — a no-op is fine:

```yaml
version: 3
```

This lets `validate` and any scheduled `apply` run exit cleanly while adopters are still configuring their private config repo.

## Protect live deployments

- Use a private repository for live enterprise configuration whenever possible.
- Store `COPILOT_FINOPS_TOKEN` as a repository or organization secret, never in a file.
- Store the enterprise slug as the `COPILOT_FINOPS_ENTERPRISE` variable.
- Require reviews for `.github/workflows/**` and `config/**`.
- Keep manual `apply` runs in `dry_run=true` until the preview summary is reviewed.
- Disable the `finops-apply.yml` schedule in public demo repositories that are not connected to a real enterprise.

## Final checks

Run these before publishing:

```bash
npm test
node bin/copilot-finops.js validate config/copilot-finops.yml
node bin/copilot-finops.js validate config/copilot-finops.example.yml
git diff --check
```

Confirm the committed bundle and generated docs are fresh (CI enforces this):

```bash
npm run build         # dist/ must be unchanged after this
npm run docs:schema   # docs/config-schema.md must be unchanged after this
git status --short    # expect no changes from the two commands above
```

If `actionlint` is available, also lint the workflows:

```bash
actionlint .github/workflows/*.yml
```

## Copilot customizations

- Review `AGENTS.md` and `.github/skills/copilot-finops-config/` before publishing.
- Keep the skill public-safe: no private enterprise slugs, team names, cost center names, users, budgets, reports, or tokens.
- If config requirements changed, make sure the skill references and docs were updated in the same change.
