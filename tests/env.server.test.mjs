import test from "node:test";
import assert from "node:assert/strict";
import { getEnvHealth, resolveAppUrl } from "../app/utils/env.server.js";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) process.env[key] = value;
}

test("resolveAppUrl prefers SHOPIFY_APP_URL", () => {
  process.env.SHOPIFY_APP_URL = "https://example.com";
  process.env.APP_URL = "https://fallback.com";
  assert.equal(resolveAppUrl(), "https://example.com");
  restoreEnv();
});

test("getEnvHealth returns not ok when required envs are missing", () => {
  delete process.env.SHOPIFY_API_KEY;
  delete process.env.SHOPIFY_API_SECRET;
  delete process.env.SCOPES;
  delete process.env.SHOPIFY_APP_URL;
  delete process.env.DATABASE_PROVIDER;
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = "production";

  const health = getEnvHealth();
  assert.equal(health.ok, false);
  assert.ok(health.missingRequired.includes("SHOPIFY_API_KEY"));
  assert.ok(health.missingRequired.includes("SHOPIFY_API_SECRET"));
  assert.ok(health.missingRequired.includes("DATABASE_PROVIDER"));
  assert.ok(health.missingRequired.includes("DATABASE_URL"));
  restoreEnv();
});

test("getEnvHealth returns ok with required envs in non-production", () => {
  process.env.SHOPIFY_API_KEY = "abc";
  process.env.SHOPIFY_API_SECRET = "def";
  process.env.SCOPES = "read_orders";
  process.env.SHOPIFY_APP_URL = "http://localhost:3000";
  process.env.DATABASE_PROVIDER = "sqlite";
  process.env.DATABASE_URL = "file:./prisma/dev.sqlite";
  process.env.NODE_ENV = "development";

  const health = getEnvHealth();
  assert.equal(health.ok, true);
  restoreEnv();
});
