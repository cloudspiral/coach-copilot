import "dotenv/config";

export interface AppConfig {
  port: number;
  model: string;
  reasoningEffort: "none" | "low" | "medium" | "high";
  apiKey?: string;
  requireLiveModel: boolean;
  databaseUrl?: string;
  graphRefreshMs?: number;
  demoMemberId?: string;
}

export function loadConfig(): AppConfig {
  const configuredEffort = process.env.OPENAI_REASONING_EFFORT;
  const reasoningEffort = configuredEffort === "none" || configuredEffort === "medium" || configuredEffort === "high"
    ? configuredEffort
    : "low";

  return {
    port: Number(process.env.PORT ?? 3001),
    model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
    reasoningEffort,
    apiKey: process.env.DISABLE_LIVE_MODEL === "true" ? undefined : process.env.OPENAI_API_KEY,
    requireLiveModel: process.env.REQUIRE_LIVE_MODEL === "true",
    databaseUrl: process.env.DATABASE_URL,
    graphRefreshMs: Number(process.env.GRAPH_REFRESH_MS ?? 30_000),
    demoMemberId: process.env.DEMO_MEMBER_ID ?? "mbr_01HX9JORDAN",
  };
}
