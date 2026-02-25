import { json } from "@remix-run/node";
import { prisma } from "../utils/db.server";
import { getEnvHealth } from "../utils/env.server";
import { recordApiMetric } from "../utils/api-metrics.server";

export async function loader() {
  const startedAt = Date.now();
  const env = getEnvHealth();
  let dbOk = false;
  let dbError = null;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (error) {
    dbError = error?.message || "Database check failed";
  }

  const ready = env.ok && dbOk;
  const payload = {
    ready,
    environment: process.env.NODE_ENV || "development",
    checks: {
      env: {
        ok: env.ok,
        missingRequired: env.missingRequired,
      },
      db: {
        ok: dbOk,
        error: dbError,
      },
    },
    timestamp: new Date().toISOString(),
  };
  const status = ready ? 200 : 503;
  await recordApiMetric({
    routeKey: "health.readiness",
    statusCode: status,
    durationMs: Date.now() - startedAt,
    ok: ready,
  });

  return json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
