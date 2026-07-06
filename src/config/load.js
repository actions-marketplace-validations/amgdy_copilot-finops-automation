/**
 * Load and parse a v3 Copilot FinOps config document.
 *
 * Parsing only — no schema or semantic validation (see ./validate.js). Returns
 * a plain object; an empty document normalizes to {}.
 */
import { readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";

/** Error thrown when a config file cannot be read or parsed. */
export class ConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ConfigError";
  }
}

/**
 * Parse a YAML config string into a plain object.
 * @param {string} raw - Raw YAML text.
 * @param {string} [source] - Label used in error messages (e.g. a file path).
 * @returns {object} The parsed mapping (empty document -> {}).
 */
export function parseConfig(raw, source = "<config>") {
  let doc;
  try {
    doc = yamlLoad(raw);
  } catch (cause) {
    // js-yaml v5 throws on an empty or comment-only document; treat it as {}.
    if (cause && typeof cause.message === "string" && cause.message.includes("input is empty")) {
      return {};
    }
    throw new ConfigError(`Could not parse YAML in ${source}: ${cause.message}`, { cause });
  }
  if (doc === undefined || doc === null) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    const got = Array.isArray(doc) ? "a list" : typeof doc;
    throw new ConfigError(`${source} must be a YAML mapping at the top level (got ${got}).`);
  }
  return doc;
}

/**
 * Read and parse a YAML config file.
 * @param {string} path - Path to the config file.
 * @returns {object} The parsed mapping.
 */
export function loadConfigFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ConfigError(`Could not read config file ${path}: ${cause.message}`, { cause });
  }
  return parseConfig(raw, path);
}
