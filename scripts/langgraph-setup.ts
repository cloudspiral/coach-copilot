import "dotenv/config";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const checkpointer = PostgresSaver.fromConnString(databaseUrl, { schema: "langgraph" });
try {
  await checkpointer.setup();
  console.log("LangGraph checkpoint migrations are current");
} finally {
  await checkpointer.end();
}
