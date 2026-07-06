# Config schemas

The JSON Schema that validates the YAML config in [`config/`](../config). There is one current schema:

| Schema | Validates | Draft |
| --- | --- | --- |
| `v3/copilot-finops.schema.json` | `config/copilot-finops*.yml` (budgets-first Node action) | 2020-12 |

It powers two things:

1. **Editor validation** — red squiggles, autocomplete, and hover docs via the Red Hat **YAML** extension (wired up in [`.vscode/settings.json`](../.vscode/settings.json), and per-file with the `# yaml-language-server: $schema=…` modeline).
2. **The `validate` operation** — [`src/config/validate.js`](../src/config/validate.js) runs this schema as a gate (via Ajv, draft 2020-12) and then applies a semantic layer for the rules a schema can't express.

The human-readable field reference is generated from this schema to [`docs/config-schema.md`](../docs/config-schema.md) by `npm run docs:schema`. Regenerate and commit it whenever the schema changes.

## The schema ↔ validator boundary

Validation is layered, and the split is deliberate:

**The schema enforces shape and structure:**

- Field types, enums (`oneOf` + `const` + `title` + `description`), and ranges.
- Typo protection — `additionalProperties: false` at every level rejects unknown keys.
- Per-scope required/forbidden fields (for example `users` is required for `scope: user` and forbidden elsewhere).
- The `metered_credits_only` → `enforce` gating (`enforce` is only allowed on collective metered budgets).

**The semantic layer (`src/config/validate.js`) enforces everything else:**

- **Cardinality / uniqueness** — at most one `all_users`, one `enterprise`, and one `organization` budget per org; one budget per resolved cost center + `metered_credits_only` setting.
- **Friendly messages** for billing-sensitive mistakes.

**The apply engine (`src/apply-engine.js`) owns the live rules:**

- Cost center name → ID resolution, and finding/creating the cost center for a team/org.
- Value defaulting (`enforce` → `true`, `alerts` → `[]`).

A JSON Schema can describe one document's shape but cannot read live GitHub state, so the live rules never live in the schema.

## Editor and documentation annotations

The schema stays standards-compliant while giving authors rich help:

- `title` — short display names for fields and enum values.
- `description` — hover text and generated-doc explanations.
- `examples` — public-safe sample values.

Enum-like values use `oneOf` entries with `const` + `title` + `description` (standard JSON Schema), not non-standard keywords like `enumDescriptions` or `meta:enum`, so each allowed value carries its own description while staying portable across validators.

## Versioning model

A config declares its contract version with the top-level `version` field, which must be `3` for this schema. Older contracts (v1/v2, from the retired Bash implementation) are no longer shipped. If the contract ever needs a breaking change, add a new `schemas/v<N>/` folder rather than editing this one, and branch the loader/validator on `version`.

## Tests

The schema and the validator are covered by the `node:test` suite ([`tests/`](../tests)). Config contract cases live in [`tests/cases/v3/copilot-finops.yml`](../tests/cases/v3/copilot-finops.yml): each case has a `name`, a `valid` flag (`true` must pass, `false` must be rejected), and the `config` document; invalid cases assert on the expected error. Run the whole suite with:

```bash
npm test
```

When you change a field, constraint, enum, default, or scope rule: update the schema, add a valid **and** an invalid case, regenerate the docs (`npm run docs:schema`) and the bundle (`npm run build`), and keep `npm test` green. See `## Schema Tests` in [`AGENTS.md`](../AGENTS.md).
