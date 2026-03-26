import "dotenv/config";
import { spawnSync } from "node:child_process";

const databaseUrl = String(process.env.DATABASE_URL || "");
if (!databaseUrl) {
  console.error(JSON.stringify({ ok: false, error: "DATABASE_URL is required" }, null, 2));
  process.exit(1);
}
if (databaseUrl.startsWith("file:")) {
  console.error(JSON.stringify({ ok: false, error: "Postgres DATABASE_URL required for index verification" }, null, 2));
  process.exit(1);
}

const sql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_job_queue_status_run_after') THEN
    RAISE EXCEPTION 'Missing index: idx_job_queue_status_run_after';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_job_queue_shop_created') THEN
    RAISE EXCEPTION 'Missing index: idx_job_queue_shop_created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_job_queue_type_status') THEN
    RAISE EXCEPTION 'Missing index: idx_job_queue_type_status';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_api_request_metric_route_created') THEN
    RAISE EXCEPTION 'Missing index: idx_api_request_metric_route_created';
  END IF;
END $$;
`;

const result = spawnSync("npx prisma db execute --stdin --config prisma.config.postgres.ts", {
  input: sql,
  encoding: "utf8",
  shell: true,
});

const ok = result.status === 0;
console.log(JSON.stringify({
  ok,
  command: "npx prisma db execute --stdin --config prisma.config.postgres.ts",
  stdout: String(result.stdout || "").trim(),
  stderr: String(result.stderr || "").trim(),
  checkedAt: new Date().toISOString(),
}, null, 2));
if (!ok) process.exit(1);
