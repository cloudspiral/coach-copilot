import { MemorySaver } from "@langchain/langgraph";
import type { AppConfig } from "./config.js";
import { exercises, member } from "./data.js";
import { buildDomainGraph } from "./graph.js";
import { ActiveGraphProvider } from "./graph-provider.js";
import type { StructuredModelGateway } from "./openai.js";
import {
  MemoryConversationRepository,
  MemoryDataRepository,
  MemoryGraphRepository,
  MemoryPlanRepository,
  MemoryWorkflowRepository,
  type RuntimeRepositories,
} from "./repositories.js";
import type { ApplicationRuntime } from "./runtime.js";
import { WorkflowOrchestrator } from "./workflows.js";

export async function createTestRuntime(
  config: AppConfig,
  gateway: StructuredModelGateway,
): Promise<ApplicationRuntime> {
  const domainGraph = buildDomainGraph(exercises);
  const repositories: RuntimeRepositories = {
    data: new MemoryDataRepository(member, exercises),
    plans: new MemoryPlanRepository(),
    conversations: new MemoryConversationRepository(),
    graphs: new MemoryGraphRepository({ versionId: "graph_test_v1", graph: domainGraph }),
    workflows: new MemoryWorkflowRepository(),
  };
  const graphProvider = new ActiveGraphProvider(repositories.graphs, repositories.data);
  await graphProvider.initialize();
  const workflows = new WorkflowOrchestrator(repositories, graphProvider, gateway, config, new MemorySaver());
  return {
    repositories,
    graphProvider,
    workflows,
    async readiness() {
      return {
        ready: true,
        database: "memory",
        databaseConnected: true,
        migrations: true,
        seedData: true,
        activeGraphVersion: graphProvider.status().versionId,
        workflowCheckpointer: true,
      };
    },
    async close() {},
  };
}
