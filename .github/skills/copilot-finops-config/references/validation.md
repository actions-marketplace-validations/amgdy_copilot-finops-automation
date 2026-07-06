# Validation And Run Commands

Always validate generated config before suggesting a run.

## Validate (no token, no network)

```bash
node bin/copilot-finops.js validate config/copilot-finops.yml
node bin/copilot-finops.js validate config/copilot-finops.local.yml
```

`validate` runs the semantic layer (`src/config/validate.js`) — version, unknown fields,
scope/amount, per-scope required/forbidden fields, the `metered_credits_only` → `enforce` gating, and
uniqueness — with the v3 JSON Schema (`schemas/v3/`) as a belt-and-suspenders gate. The field
reference is `docs/config-schema.md`.

## Dry-run locally (needs the enterprise slug + a token)

```bash
node bin/copilot-finops.js apply config/copilot-finops.yml --enterprise your-enterprise
```

This previews every CREATE / UPDATE / NO CHANGE (and any cost centers that would be created) without
writing. The token comes from `COPILOT_FINOPS_TOKEN` (or `GITHUB_TOKEN`); a local `.env` in the
working directory is loaded automatically. Add `--live` to actually write budgets.

## Workflows

- **`finops-validate.yml`** — runs `validate` on every pull request that touches the config, the
  schema, or the action. Token-free. Fails the PR check on invalid config.
- **`finops-apply.yml`** — runs `apply`. Manual runs default to `dry_run=true`; the weekly schedule
  runs live. Inputs:

  ```text
  config_file: config file to apply (default config/copilot-finops.yml)
  dry_run: true before a live apply
  log_level: live step log level (off, error, warn, info, debug; default info)
  ```

  The enterprise slug comes from the `COPILOT_FINOPS_ENTERPRISE` variable and the token from the
  `COPILOT_FINOPS_TOKEN` secret — neither is a config field or a workflow input.

Always recommend running `finops-apply.yml` with `dry_run=true` (or the CLI without `--live`) and
reviewing the summary before a live apply.

`log_level=info` is the default and prints apply progress plus the plain-text report. Use
`log_level=warn` for quieter routine runs. Use `log_level=debug` only for detailed diagnostics; it
adds budget resolution, live-budget matching, payload, request, retry, and pagination detail with
sensitive fields redacted. `DEBUG` entries in the summary's full run log follow the same setting.

## Local config safety

Files matching `config/*.local.yml` are gitignored. Use them for private, experimental, or
operator-specific values. Check ignore status:

```bash
git check-ignore -v config/copilot-finops.local.yml
```

## Public repo safety

Never put tokens in config. Do not commit private enterprise slugs, team names, cost center names,
user logins, reports, or workflow logs to public branches unless explicitly approved. The enterprise
slug has no config field — keep it in the `COPILOT_FINOPS_ENTERPRISE` variable.
