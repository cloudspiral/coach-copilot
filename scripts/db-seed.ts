import "dotenv/config";
import { createDatabase } from "../src/server/db/database.js";
import { seedDatabase } from "../src/server/db/ingestion.js";
import { exercises, member } from "../src/server/data.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const handle = createDatabase(databaseUrl);
try {
  const result = await seedDatabase(handle.db, { exercises, member });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await handle.close();
}
