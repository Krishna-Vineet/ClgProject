import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env, runtimeDatabaseUrl } from "../config/env";
import * as schema from "./schema";

export type DbClient = ReturnType<typeof createDb>;

export function createDb(connectionString: string, max = env.DB_POOL_MAX) {
  const pooled =
    connectionString.includes("-pooler.") || connectionString === env.DATABASE_URL_POOLED;
  const sql = postgres(connectionString, {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    // Neon transaction pooling is safest without client-side prepared statements.
    prepare: !pooled,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

let defaultClient: DbClient | null = null;

export function getDb(connectionString?: string): DbClient {
  if (connectionString) return createDb(connectionString);
  const url = runtimeDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL or DATABASE_URL_POOLED is not configured.");
  defaultClient ??= createDb(url);
  return defaultClient;
}

export async function closeDb(client: DbClient): Promise<void> {
  await client.sql.end({ timeout: 5 });
}
