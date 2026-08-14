import "dotenv/config";
import { createDatabase, migrateDatabase } from "../src/server/db/database.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const handle = createDatabase(databaseUrl);
try {
  await migrateDatabase(handle);
  console.log("Application migrations are current");
} finally {
  await handle.close();
}
