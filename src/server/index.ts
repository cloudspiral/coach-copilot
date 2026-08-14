import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createProductionRuntime } from "./runtime.js";

const config = loadConfig();
const runtime = await createProductionRuntime(config);
const { app } = createApp(config, runtime);
const host = process.env.HOST ?? "0.0.0.0";
const server = app.listen(config.port, host, () => {
  console.log(`Coach Copilot API listening on http://${host}:${config.port} (${config.model}; key ${config.apiKey ? "configured" : "missing"})`);
});

async function shutdown(): Promise<void> {
  server.close(async () => {
    await runtime.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
