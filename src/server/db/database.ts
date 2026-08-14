import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export interface DatabaseHandle {
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
  close(): Promise<void>;
}

export function databaseName(databaseUrl: string): string {
  const pathname = new URL(databaseUrl).pathname;
  return decodeURIComponent(pathname.replace(/^\//, ""));
}

export function assertTestDatabase(databaseUrl: string): void {
  const name = databaseName(databaseUrl);
  if (!name.endsWith("_test")) throw new Error(`Refusing destructive test setup for database '${name}'; TEST_DATABASE_URL must end in _test`);
}

export function createDatabase(databaseUrl: string): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return { pool, db, close: () => pool.end() };
}

export async function migrateDatabase(handle: DatabaseHandle): Promise<void> {
  await migrate(handle.db, { migrationsFolder: "drizzle" });
}
