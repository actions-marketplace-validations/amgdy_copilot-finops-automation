/**
 * Resolve which config file the run should use.
 *
 * v3 is file-based only — the v2 issue-config path (issue form, label, body
 * extraction) is dropped. This just picks the config path (input or default)
 * and confirms it exists.
 */
import { existsSync } from "node:fs";

export const DEFAULT_CONFIG_FILE = "config/copilot-finops.yml";

/**
 * @param {string} [input] - The config-file input (may be empty).
 * @returns {string} An existing config file path.
 */
export function resolveConfigPath(input) {
  const path = input && input.trim() ? input.trim() : DEFAULT_CONFIG_FILE;
  if (!existsSync(path)) {
    throw new Error(`config file not found: ${path}`);
  }
  return path;
}
