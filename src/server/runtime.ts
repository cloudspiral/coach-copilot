import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { StructuredModelGateway } from "./openai.js";
import { OpenAIStructuredGateway } from "./openai.js";
import type { AppConfig } from "./config.js";
import { createDatabase, type DatabaseHandle } from "./db/database.js";
import { createPostgresRepositories } from "./db/postgres-repositories.js";
import { ActiveGraphProvider } from "./graph-provider.js";
import type { RuntimeRepositories } from "./repositories.js";
import { WorkflowOrchestrator } from "./workflows.js";

export interface ReadinessStatus {
  ready: boolean;
  database: "postgresql" | "memory";
  databaseConnected: boolean;
  migrations: boolean;
  seedData: boolean;
  activeGraphVersion: string | null;
  workflowCheckpointer: boolean;
}

export interface ApplicationRuntime {
  repositories: RuntimeRepositories;
  graphProvider: ActiveGraphProvider;
  workflows: WorkflowOrchestrator;
  readiness(): Promise<ReadinessStatus>;
  close(): Promise<void>;
}

async function assertApplicationMigrations(database: DatabaseHandle): Promise<void> {
  const result = await database.pool.query<{ migration_table: string | null }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS migration_table",
  );
  if (!result.rows[0]?.migration_table) throw new Error("Database migrations are not installed; run npm run db:migrate");
}

async function checkCheckpointer(checkpointer: PostgresSaver): Promise<void> {
  await checkpointer.get({ configurable: { thread_id: "readiness", checkpoint_ns: "readiness" } });
}

export async function createProductionRuntime(
  config: AppConfig,
  providedGateway?: StructuredModelGateway,
): Promise<ApplicationRuntime> {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required for production runtime");
  const database = createDatabase(config.databaseUrl);
  const checkpointer = PostgresSaver.fromConnString(config.databaseUrl, { schema: "langgraph" });
  try {
    await database.pool.query("SELECT 1");
    await assertApplicationMigrations(database);
    const repositories = createPostgresRepositories(database.db);
    const [member, exercises] = await Promise.all([
      repositories.data.getMember(config.demoMemberId ?? "mbr_01HX9JORDAN"),
      repositories.data.getExercises(),
    ]);
    if (!member || !exercises.length) throw new Error("Required seed data is unavailable; run npm run db:seed");
    const graphProvider = new ActiveGraphProvider(repositories.graphs, repositories.data, config.graphRefreshMs ?? 30_000);
    await graphProvider.initialize();
    await checkCheckpointer(checkpointer);
    const gateway = providedGateway ?? new OpenAIStructuredGateway(config);
    const workflows = new WorkflowOrchestrator(repositories, graphProvider, gateway, config, checkpointer);

    return {
      repositories,
      graphProvider,
      workflows,
      async readiness() {
        let databaseConnected = false;
        let migrations = false;
        let seedData = false;
        let activeGraphVersion: string | null;
        let workflowCheckpointer = false;
        try {
          await database.pool.query("SELECT 1");
          databaseConnected = true;
        } catch {
          // The aggregate response reports this dependency as unavailable.
        }
        try {
          await assertApplicationMigrations(database);
          migrations = true;
        } catch {
          // The aggregate response reports this dependency as unavailable.
        }
        try {
          const [currentMember, currentExercises] = await Promise.all([
            repositories.data.getMember(config.demoMemberId ?? "mbr_01HX9JORDAN"),
            repositories.data.getExercises(),
          ]);
          seedData = Boolean(currentMember && currentExercises.length);
        } catch {
          // The aggregate response reports this dependency as unavailable.
        }
        try {
          const active = await graphProvider.getActive();
          activeGraphVersion = graphProvider.status().refreshError ? null : active.versionId;
        } catch {
          activeGraphVersion = null;
        }
        try {
          await checkCheckpointer(checkpointer);
          workflowCheckpointer = true;
        } catch {
          // The aggregate response reports this dependency as unavailable.
        }
        return {
          ready: databaseConnected && migrations && seedData && Boolean(activeGraphVersion) && workflowCheckpointer,
          database: "postgresql",
          databaseConnected,
          migrations,
          seedData,
          activeGraphVersion,
          workflowCheckpointer,
        };
      },
      async close() {
        await Promise.allSettled([checkpointer.end(), database.close()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([checkpointer.end(), database.close()]);
    throw error;
  }
}
