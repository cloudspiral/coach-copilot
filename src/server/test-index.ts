import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { OpenAIStructuredGateway } from "./openai.js";
import { createTestRuntime } from "./test-runtime.js";

const config = loadConfig();
const gateway = new OpenAIStructuredGateway(config);
const runtime = await createTestRuntime(config, gateway);
const { app } = createApp(config, runtime);
const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(`Coach Copilot test API listening on http://127.0.0.1:${config.port}`);
});

async function shutdown(): Promise<void> {
  server.close(async () => {
    await runtime.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
