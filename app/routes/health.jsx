import { json } from "@remix-run/node";
import { getEnvHealth } from "../utils/env.server";

export async function loader() {
  const env = getEnvHealth();
  return json(
    {
      status: "ok",
      service: "netcash-ai",
      environment: process.env.NODE_ENV || "development",
      appUrl: env.appUrl,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || "0.0.0",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}

