# API Reference

The `apply` operation uses GitHub's **Budget and usage management** (enhanced billing) APIs. Calls are made with Octokit (`@actions/github`) using the token from the action's `token` input (or `COPILOT_FINOPS_TOKEN` / `GITHUB_TOKEN` for the CLI). The `validate` operation makes no API calls.

Every budget — including `organization` scope — is written on the **enterprise** billing endpoint. The 2026-03-10 API accepts every `budget_scope` there; this was confirmed live during the port.

## Common headers

```text
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
```

Rate-limited responses (403/429) are retried automatically, honoring `retry-after` / `x-ratelimit-reset` and otherwise backing off exponentially, up to the `max-retries` input (default 10). Set the action `log-level` input to `debug` to include request parameters (with sensitive fields redacted), response status, retry waits, and pagination counts in the live step log.

## Budgets

```text
GET   /enterprises/{enterprise}/settings/billing/budgets?per_page=10
POST  /enterprises/{enterprise}/settings/billing/budgets
PATCH /enterprises/{enterprise}/settings/billing/budgets/{budget_id}
```

The list endpoint paginates via the response body (`total_count` / `has_next_page`), not a `Link` header; the engine follows it to the last page.

The engine never calls `DELETE`. Manual cleanup can use:

```text
DELETE /enterprises/{enterprise}/settings/billing/budgets/{budget_id}
```

### Apply process

1. List existing budgets once and cache them.
2. Resolve each config budget into one or more desired budgets (some via a cost center — found, or created and assigned).
3. Match each desired budget to a live one by natural key.
4. CREATE when there is no match; PATCH mutable fields when a match differs; leave a matching budget unchanged.
5. Never delete budgets that are no longer in config.

### Create body examples

Enterprise cap (collective metered):

```json
{
  "budget_scope": "enterprise",
  "budget_amount": 5000,
  "prevent_further_usage": true,
  "budget_product_sku": "ai_credits",
  "budget_type": "BundlePricing",
  "budget_alerting": { "will_alert": true, "alert_recipients": ["billing-admin"] }
}
```

Individual user budget (`scope: user`, one per login):

```json
{
  "budget_scope": "user",
  "user": "octocat",
  "budget_amount": 75,
  "prevent_further_usage": true,
  "budget_product_sku": "ai_credits",
  "budget_type": "BundlePricing",
  "budget_alerting": { "will_alert": false, "alert_recipients": [] }
}
```

Cost center budget (`budget_entity_name` is the resolved cost center **ID**):

```json
{
  "budget_scope": "cost_center",
  "budget_entity_name": "<cost-center-id>",
  "budget_amount": 500,
  "prevent_further_usage": false,
  "budget_product_sku": "ai_credits",
  "budget_type": "BundlePricing",
  "budget_alerting": { "will_alert": true, "alert_recipients": ["eng-billing-admin"] }
}
```

Direct organization budget (`scope: organization` — always a collective metered cap, `budget_entity_name` is the org login):

```json
{
  "budget_scope": "organization",
  "budget_entity_name": "acme",
  "budget_amount": 4000,
  "prevent_further_usage": false,
  "budget_product_sku": "ai_credits",
  "budget_type": "BundlePricing",
  "budget_alerting": { "will_alert": false, "alert_recipients": [] }
}
```

### Patch body

Only mutable fields are patched. Identity fields (scope, SKU, user, entity) are not.

```json
{
  "budget_amount": 100,
  "prevent_further_usage": true,
  "budget_alerting": { "will_alert": false, "alert_recipients": [] }
}
```

### Budget natural keys

| Config `scope` (+ `metered_credits_only`) | GitHub `budget_scope` | Match key |
| --- | --- | --- |
| `all_users` | `multi_user_customer` | `budget_scope` + SKU |
| `enterprise` | `enterprise` | `budget_scope` + SKU |
| `user` | `user` × login | `budget_scope` + SKU + login |
| `cost_center` (default) / `team` (default) | `multi_user_cost_center` | `budget_scope` + SKU + cost center (name or ID) |
| `cost_center` / `team` + `metered_credits_only` | `cost_center` | `budget_scope` + SKU + cost center (name or ID) |
| `organization` | `organization` | `budget_scope` + SKU + org login |

Cost-center keys use the cost center **name** for identity (unique per enterprise), so dry-run runs that share a placeholder ID for a not-yet-created cost center never collide falsely.

## Cost centers

Used when a `team` budget (or a `cost_center` budget) needs a cost center ID. An `organization` budget is written directly and never touches a cost center.

```text
GET  /enterprises/{enterprise}/settings/billing/cost-centers
POST /enterprises/{enterprise}/settings/billing/cost-centers
POST /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource
```

The list endpoint paginates via the response body (`total_count` / `has_next_page`).

For `team` budgets:

- The engine finds the cost center that already contains the team (matching a resource `{type: "Team", name: "ent:<slug>"}` — the `ent:` prefix is stripped when matching).
- If none exists, it creates one (`finops-team-<slug>`) and assigns the team to it:

  ```json
  { "name": "finops-team-platform-engineering" }
  ```

  ```json
  { "enterprise_teams": ["platform-engineering"] }
  ```

- If the matched cost center also holds other resources, the budget is skipped and reported unless `allow_shared_cost_center: true`.

The engine does **not** read team membership — GitHub applies a cost-center budget across the cost center's members.
