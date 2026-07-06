import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOG_LEVEL,
  classifyLogMessage,
  normalizeLogLevel,
  shouldEmitLogMessage,
} from "../src/logging.js";

test("normalizeLogLevel: accepts supported levels and defaults invalid values", () => {
  assert.equal(DEFAULT_LOG_LEVEL, "info");
  assert.equal(normalizeLogLevel("DEBUG"), "debug");
  assert.equal(normalizeLogLevel(" info "), "info");
  assert.equal(normalizeLogLevel("noisy"), "info");
});

test("classifyLogMessage: maps engine and API trace messages to levels", () => {
  assert.equal(classifyLogMessage("ERROR creating policy"), "error");
  assert.equal(classifyLogMessage("WARN shared cost center"), "warn");
  assert.equal(classifyLogMessage("SKIP duplicate"), "warn");
  assert.equal(classifyLogMessage("DEBUG request GET /route"), "debug");
  assert.equal(classifyLogMessage("\u2192 GET /enterprises/acme/settings/billing/budgets"), "debug");
  assert.equal(classifyLogMessage("Resolved base: all_users -> multi_user_customer"), "info");
});

test("shouldEmitLogMessage: filters by configured log level", () => {
  assert.equal(shouldEmitLogMessage("ERROR creating policy", "error"), true);
  assert.equal(shouldEmitLogMessage("WARN shared cost center", "error"), false);
  assert.equal(shouldEmitLogMessage("Resolved base", "warn"), false);
  assert.equal(shouldEmitLogMessage("Resolved base", "info"), true);
  assert.equal(shouldEmitLogMessage("DEBUG request GET /route", "info"), false);
  assert.equal(shouldEmitLogMessage("DEBUG request GET /route", "debug"), true);
  assert.equal(shouldEmitLogMessage("\u2192 GET /route", "info"), false);
  assert.equal(shouldEmitLogMessage("\u2192 GET /route", "debug"), true);
  assert.equal(shouldEmitLogMessage("ERROR creating policy", "off"), false);
});