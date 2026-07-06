/**
 * Render the apply report (job summary) from a structured apply result.
 *
 * This replaces the jq renderers (.github/summary/*.jq). renderReport() is pure
 * (result -> markdown string); the action writes the string to core.summary.
 * The result shape below is the contract the apply engine emits.
 *
 * @typedef {Object} ApplyResult
 * @property {"dry-run"|"live"} mode
 * @property {string} enterprise
 * @property {string} configSource
 * @property {BudgetAction[]} actions            One row per resolved budget.
 * @property {CostCenterCreated[]} costCentersCreated
 * @property {Duplicate[]} duplicates
 * @property {SharedCostCenter[]} sharedCostCenters
 * @property {RunError[]} errors
 * @property {string[]} log                       Full run log lines.
 *
 * @typedef {Object} BudgetAction
 * @property {string} policy                      Budget name/label from config.
 * @property {string} scope                       Config scope (all_users, team, ...).
 * @property {string} resolution                  "DIRECT" | "existing CC <name>" | "CC <name> (created + team assigned)".
 * @property {string} apiScope                    budget_scope written to the API.
 * @property {string} entity                      budget_entity_name / login, or "".
 * @property {"CREATE"|"UPDATE"|"NO CHANGE"|"SKIP"|"ERROR"} action
 * @property {number|null} oldAmount
 * @property {number|null} newAmount
 * @property {string[]} flags                     e.g. ["per-member","hard-stop"].
 * @property {string} [note]
 *
 * @typedef {Object} CostCenterCreated
 * @property {string} name
 * @property {string} assigned                    The team/org assigned to it.
 * @property {string} forPolicy
 *
 * @typedef {Object} Duplicate
 * @property {string} entity                      The shared budget entity.
 * @property {string[]} policies
 * @property {string} winner
 * @property {string[]} skipped
 *
 * @typedef {Object} SharedCostCenter
 * @property {string} policy
 * @property {string} costCenter
 * @property {string} target                      The team/org being budgeted.
 * @property {string[]} otherResources            The blast radius.
 * @property {boolean} applied                    true if allow_shared_cost_center let it through.
 *
 * @typedef {Object} RunError
 * @property {string} [policy]
 * @property {string} message
 */

const money = (value) => (value === null || value === undefined ? "—" : `$${value}`);
const cell = (value) => String(value ?? "").replace(/\|/g, "\\|");
const code = (value) => (value ? `\`${cell(value)}\`` : "—");

function displayAction(action, mode) {
  if (mode === "dry-run") {
    if (action === "CREATE") return "would CREATE";
    if (action === "UPDATE") return "would UPDATE";
    if (action === "SKIP") return "would SKIP";
  }
  return action;
}

function amountCell(row) {
  if (row.action === "CREATE") return `— → ${money(row.newAmount)}`;
  if (row.action === "UPDATE") return `${money(row.oldAmount)} → ${money(row.newAmount)}`;
  if (row.action === "ERROR" || row.action === "SKIP") return money(row.newAmount ?? row.oldAmount);
  return money(row.newAmount ?? row.oldAmount);
}

function counts(result) {
  const countByAction = (name) => result.actions.filter((row) => row.action === name).length;
  return {
    created: countByAction("CREATE"),
    updated: countByAction("UPDATE"),
    unchanged: countByAction("NO CHANGE"),
    skipped: countByAction("SKIP"),
    costCentersCreated: result.costCentersCreated.length,
    errors: result.errors.length + countByAction("ERROR"),
  };
}

/**
 * Render a full markdown report from an apply result.
 * @param {ApplyResult} result
 * @returns {string}
 */
export function renderReport(result) {
  const mode = result.mode === "dry-run" ? "dry-run (preview only)" : "live (changes applied)";
  const totals = counts(result);
  const lines = [];

  lines.push("## Copilot FinOps — Apply report", "");
  lines.push(`**Mode:** ${mode}  `);
  lines.push(`**Enterprise:** ${code(result.enterprise)}  `);
  lines.push(`**Config:** ${code(result.configSource)}`, "");

  lines.push("| Created | Updated | Unchanged | Skipped | Cost centers created | Errors |");
  lines.push("| ---: | ---: | ---: | ---: | ---: | ---: |");
  lines.push(
    `| ${totals.created} | ${totals.updated} | ${totals.unchanged} | ${totals.skipped} | ${totals.costCentersCreated} | ${totals.errors} |`,
    "",
  );

  // ── Budgets ──────────────────────────────────────────────────────────────
  lines.push("### Budgets", "");
  if (result.actions.length === 0) {
    lines.push("_No budgets to apply._", "");
  } else {
    lines.push("| Policy | Scope | Resolution | API scope · entity | Action | Amount | Flags |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const row of result.actions) {
      const apiEntity = row.entity ? `\`${cell(row.apiScope)}\` · ${cell(row.entity)}` : `\`${cell(row.apiScope)}\``;
      lines.push(
        `| ${code(row.policy)} | ${cell(row.scope)} | ${cell(row.resolution)} | ${apiEntity} | ${displayAction(row.action, result.mode)} | ${amountCell(row)} | ${row.flags.length ? row.flags.map(cell).join(", ") : "—"} |`,
      );
    }
    lines.push("");
  }

  // ── Cost centers created ─────────────────────────────────────────────────
  if (result.costCentersCreated.length > 0) {
    lines.push("### Cost centers created", "");
    lines.push("| Cost center | Assigned | For budget |");
    lines.push("| --- | --- | --- |");
    for (const costCenter of result.costCentersCreated) {
      lines.push(`| ${code(costCenter.name)} | ${cell(costCenter.assigned)} | ${code(costCenter.forPolicy)} |`);
    }
    lines.push("");
  }

  // ── Duplicates ───────────────────────────────────────────────────────────
  if (result.duplicates.length > 0) {
    lines.push("### Duplicates", "");
    lines.push(
      "Two or more budgets resolved to the same entity (GitHub allows one). The **last** in config order wins; earlier ones were skipped.",
      "",
    );
    lines.push("| Entity | Policies | Winner | Skipped |");
    lines.push("| --- | --- | --- | --- |");
    for (const duplicate of result.duplicates) {
      lines.push(
        `| ${code(duplicate.entity)} | ${duplicate.policies.map(code).join(", ")} | ${code(duplicate.winner)} | ${duplicate.skipped.map(code).join(", ") || "—"} |`,
      );
    }
    lines.push("");
  }

  // ── Shared cost centers ──────────────────────────────────────────────────
  if (result.sharedCostCenters.length > 0) {
    lines.push("### Shared cost centers", "");
    lines.push(
      "The resolved cost center holds resources **beyond** the target. A budget applies to the whole cost center, so these were skipped unless `allow_shared_cost_center: true`.",
      "",
    );
    lines.push("| Policy | Cost center | Target | Also affected | Applied |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const shared of result.sharedCostCenters) {
      lines.push(
        `| ${code(shared.policy)} | ${code(shared.costCenter)} | ${cell(shared.target)} | ${shared.otherResources.map(cell).join(", ") || "—"} | ${shared.applied ? "yes" : "SKIPPED"} |`,
      );
    }
    lines.push("");
  }

  // ── Errors ───────────────────────────────────────────────────────────────
  if (totals.errors > 0) {
    lines.push("### Errors", "");
    lines.push("| Policy | Message |");
    lines.push("| --- | --- |");
    for (const row of result.actions.filter((entry) => entry.action === "ERROR")) {
      lines.push(`| ${code(row.policy)} | ${cell(row.note || "failed")} |`);
    }
    for (const error of result.errors) {
      lines.push(`| ${error.policy ? code(error.policy) : "—"} | ${cell(error.message)} |`);
    }
    lines.push("");
  }

  // ── Full run log ─────────────────────────────────────────────────────────
  if (result.log.length > 0) {
    lines.push("<details><summary>Full run log</summary>", "");
    lines.push("```");
    lines.push(...result.log);
    lines.push("```", "", "</details>", "");
  }

  return lines.join("\n");
}

/**
 * Render the job summary for the `validate` operation.
 * @param {string} configSource
 * @param {boolean} valid
 * @param {{ path: string, message: string }[]} errors
 * @returns {string}
 */
export function renderValidateReport(configSource, valid, errors) {
  const lines = ["## Copilot FinOps — Validate", "", `**Config:** ${code(configSource)}`, ""];
  if (valid) {
    lines.push("✅ Config is valid.", "");
    return lines.join("\n");
  }
  lines.push(`❌ Config is invalid — ${errors.length} error(s):`, "");
  lines.push("| Location | Problem |", "| --- | --- |");
  for (const error of errors) {
    lines.push(`| ${code(error.path)} | ${cell(error.message)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function textAmount(row) {
  if (row.action === "CREATE") return `→ ${money(row.newAmount)}`;
  if (row.action === "UPDATE") return `${money(row.oldAmount)} → ${money(row.newAmount)}`;
  return money(row.newAmount ?? row.oldAmount);
}

/**
 * Render the apply report as plain text for the terminal (CLI). Same content as
 * renderReport() but without markdown syntax (no headers, tables, or <details>).
 * @param {ApplyResult} result
 * @returns {string}
 */
export function renderTextReport(result) {
  const totals = counts(result);
  const pad = (text, width) => String(text).padEnd(width);
  const lines = [];

  lines.push(`Copilot FinOps — apply (${result.mode})`);
  lines.push(`Enterprise: ${result.enterprise}`);
  lines.push(`Config:     ${result.configSource}`);
  lines.push("");
  lines.push(
    `Summary: ${totals.created} create, ${totals.updated} update, ${totals.unchanged} unchanged, ${totals.skipped} skip, ${totals.costCentersCreated} cost center(s), ${totals.errors} error(s)`,
  );

  if (result.actions.length) {
    lines.push("", "Budgets:");
    for (const row of result.actions) {
      const actionLabel = displayAction(row.action, result.mode);
      const scopeDesc = `${row.scope} → ${row.apiScope}${row.entity ? ` ${row.entity}` : ""}`;
      const flags = row.flags.length ? `  (${row.flags.join(", ")})` : "";
      const note = row.note ? `  — ${row.note}` : "";
      lines.push(`  ${pad(actionLabel, 13)} ${row.policy}  [${scopeDesc}]  ${textAmount(row)}${flags}${note}`);
    }
  }

  if (result.costCentersCreated.length) {
    lines.push("", "Cost centers to create:");
    for (const costCenter of result.costCentersCreated) {
      lines.push(`  ${costCenter.name}  <- ${costCenter.assigned}  (for ${costCenter.forPolicy})`);
    }
  }

  if (result.duplicates.length) {
    lines.push("", "Duplicates (last wins):");
    for (const duplicate of result.duplicates) {
      lines.push(`  ${duplicate.entity}: winner ${duplicate.winner}; skipped ${duplicate.skipped.join(", ") || "none"}`);
    }
  }

  if (result.sharedCostCenters.length) {
    lines.push("", "Shared cost centers:");
    for (const shared of result.sharedCostCenters) {
      lines.push(`  ${shared.policy}: ${shared.costCenter} also holds ${shared.otherResources.join(", ") || "—"} (${shared.applied ? "applied" : "SKIPPED"})`);
    }
  }

  const warnings = result.log.filter((line) => line.startsWith("WARN"));
  if (warnings.length) {
    lines.push("", "Notes:");
    for (const warning of warnings) lines.push(`  ${warning}`);
  }

  if (totals.errors) {
    lines.push("", "Errors:");
    for (const row of result.actions.filter((entry) => entry.action === "ERROR")) {
      lines.push(`  ${row.policy}: ${row.note || "failed"}`);
    }
    for (const error of result.errors) lines.push(`  ${error.policy || "—"}: ${error.message}`);
  }

  return lines.join("\n");
}
