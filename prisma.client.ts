import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const databaseUrl = process.env.DATABASE_URL || "file:./prisma/dev.sqlite";
if (process.env.NODE_ENV === "production" && databaseUrl.startsWith("file:")) {
  throw new Error("SQLite is not allowed in production. Set DATABASE_URL to Postgres.");
}

const prismaOptions =
  databaseUrl.startsWith("file:")
    ? {
        adapter: new PrismaBetterSqlite3({
          url: databaseUrl,
        }),
      }
    : {
        datasourceUrl: databaseUrl,
      };

export const prisma = new PrismaClient(prismaOptions);
