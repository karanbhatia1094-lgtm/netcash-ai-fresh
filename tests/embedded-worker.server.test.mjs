import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBool,
  parseTypes,
  shouldAutoStartWorker,
} from "../app/utils/worker-config.server.js";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) process.env[key] = value;
}

test("parseBool resolves common boolean forms", () => {
  assert.equal(parseBool("true"), true);
  assert.equal(parseBool("1"), true);
  assert.equal(parseBool("yes"), true);
  assert.equal(parseBool("false"), false);
  assert.equal(parseBool("0"), false);
  assert.equal(parseBool("off"), false);
  assert.equal(parseBool(""), null);
  assert.equal(parseBool("maybe"), null);
});

test("parseTypes normalizes comma-separated values", () => {
  assert.deepEqual(parseTypes(""), []);
  assert.deepEqual(parseTypes("connector_sync"), ["connector_sync"]);
  assert.deepEqual(parseTypes(" connector_sync , truth_rollup_refresh ,, "), [
    "connector_sync",
    "truth_rollup_refresh",
  ]);
});

test("shouldAutoStartWorker respects override and NODE_ENV", () => {
  process.env.AUTO_START_WORKER = "true";
  process.env.NODE_ENV = "development";
  assert.equal(shouldAutoStartWorker(process.env), true);

  process.env.AUTO_START_WORKER = "false";
  process.env.NODE_ENV = "production";
  assert.equal(shouldAutoStartWorker(process.env), false);

  delete process.env.AUTO_START_WORKER;
  process.env.NODE_ENV = "production";
  assert.equal(shouldAutoStartWorker(process.env), true);

  delete process.env.AUTO_START_WORKER;
  process.env.NODE_ENV = "development";
  assert.equal(shouldAutoStartWorker(process.env), false);

  restoreEnv();
});
