# Permissions

Use a dedicated token in `COPILOT_FINOPS_TOKEN` for the `apply` operation. The `validate` operation needs no token and makes no API calls.

## Roles

The Budget and usage management (enhanced billing) endpoints are accessible to:

- **Enterprise owners**
- **Billing managers**

Creating and updating enterprise budgets and cost centers requires an enterprise admin or billing manager.

## Token scope

Create a dedicated classic PAT with `admin:enterprise`:

[Create `COPILOT_FINOPS_TOKEN`](https://github.com/settings/tokens/new?description=Copilot%20FinOps%20Automation&scopes=admin%3Aenterprise)

After creating the token, authorize it for SAML SSO if your enterprise requires SSO authorization. Save it as the repository secret `COPILOT_FINOPS_TOKEN`.

Everything the `apply` operation does runs on the **enterprise** billing endpoints:

- `GET | POST | PATCH /enterprises/{enterprise}/settings/billing/budgets…` — list, create, and update budgets (every scope, including `organization`, is written here).
- `GET | POST /enterprises/{enterprise}/settings/billing/cost-centers…` (including `/resource`) — list cost centers, and, for `team` budgets, create a cost center and assign the team to it.

`admin:enterprise` covers all of these.

## Why team/organization membership scopes are not required

Unlike a per-member sync model, v3 does **not** enumerate team or organization members. A `scope: team` budget is applied by assigning the **team itself** as a resource on a cost center, then placing a cost-center budget on it; a `scope: organization` budget is written **directly** on the enterprise endpoint. Either way GitHub expands the cap across the members. Because the engine never calls the team-membership or org-membership APIs, the token does **not** need `read:org` or enterprise-team read permission for budgets to work.

## Least privilege by operation

| Operation | Needs write? | Token |
| --- | ---: | --- |
| `validate` | No | none (no network) |
| `apply` (dry-run) | No | `admin:enterprise` (reads budgets + cost centers to compute the drift) |
| `apply` (live) | Yes | `admin:enterprise` (creates/updates budgets; creates/assigns a cost center for team budgets) |

The enterprise slug is supplied via the action's `enterprise` input (from the `COPILOT_FINOPS_ENTERPRISE` variable), not the token and not the config.

## Safety recommendations

- Protect `config/**` and `.github/workflows/**` with required reviews and CODEOWNERS.
- Keep manual `apply` runs defaulted to `dry_run=true`, and keep the schedule disabled until reviewed file-based config is ready.
- Use branch protection on `main`.
- Prefer a dedicated automation token that can be rotated without affecting a human's everyday account.
- Rotate the token immediately if it ever appears in logs, reports, issues, commits, or screenshots.
