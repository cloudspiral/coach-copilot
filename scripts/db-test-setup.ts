import "dotenv/config";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { assertTestDatabase, createDatabase, databaseName, migrateDatabase } from "../src/server/db/database.js";
import { seedDatabase } from "../src/server/db/ingestion.js";
import { exercises, member } from "../src/server/data.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
assertTestDatabase(databaseUrl);
const name = databaseName(databaseUrl);
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const adminPool = new pg.Pool({ connectionString: adminUrl.toString() });
try {
  const existing = await adminPool.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists", [name]);
  if (!existing.rows[0]?.exists) await adminPool.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
} finally {
  await adminPool.end();
}
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  await pool.query("DROP SCHEMA IF EXISTS langgraph CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
} finally {
  await pool.end();
}
const handle = createDatabase(databaseUrl);
try {
  await migrateDatabase(handle);
  await seedDatabase(handle.db, { exercises, member });
} finally {
  await handle.close();
}
const checkpointer = PostgresSaver.fromConnString(databaseUrl, { schema: "langgraph" });
try {
  await checkpointer.setup();
} finally {
  await checkpointer.end();
}
console.log("Dedicated test database reset, migrated, seeded, and prepared for LangGraph checkpoints");
