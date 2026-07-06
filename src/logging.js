/** Live step log level handling for the GitHub Action entrypoint. */
export const DEFAULT_LOG_LEVEL = "info";
export const LOG_LEVELS = ["off", "error", "warn", "info", "debug"];

const LOG_LEVEL_RANK = {
  off: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export function isValidLogLevel(value) {
  return LOG_LEVELS.includes(String(value ?? "").trim().toLowerCase());
}

export function normalizeLogLevel(value) {
  const level = String(value ?? DEFAULT_LOG_LEVEL).trim().toLowerCase();
  return isValidLogLevel(level) ? level : DEFAULT_LOG_LEVEL;
}

export function classifyLogMessage(message) {
  const text = String(message ?? "").trim();
  if (/^(ERROR\b|ERROR:|\u2717)/i.test(text)) return "error";
  if (/^(WARN\b|WARN:|SKIP\b|SKIP:)/i.test(text)) return "warn";
  if (/^DEBUG\b|^DEBUG:/i.test(text) || text.startsWith("\u2192") || text.startsWith("\u2190") || /^rate limited\b/i.test(text)) return "debug";
  return "info";
}

export function shouldEmitLogMessage(message, configuredLogLevel) {
  const level = normalizeLogLevel(configuredLogLevel);
  if (level === "off") return false;
  return LOG_LEVEL_RANK[classifyLogMessage(message)] <= LOG_LEVEL_RANK[level];
}