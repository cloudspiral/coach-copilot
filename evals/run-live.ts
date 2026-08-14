import fs from "node:fs";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { member } from "../src/server/data.js";
import { copilotScenarios, workoutScenarios } from "./scenarios.js";

interface Result { id: string; workflow: "workout" | "copilot"; passed: boolean; latencyMs: number; modelCallCount?: number; responseIds?: string[]; tokenUsage?: unknown[]; error?: string; representative?: unknown }

const config = { ...loadConfig(), requireLiveModel: true };
if (!config.apiKey) throw new Error("OPENAI_API_KEY is required for npm run test:live");
const { app } = createApp(config);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind live evaluation server");
const baseUrl = `http://127.0.0.1:${address.port}`;
const results: Result[] = [];

async function send(path: string, body: unknown) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json() as Record<string, any>;
  return { response, payload, latencyMs: Math.round(performance.now() - started) };
}

try {
  for (const scenario of workoutScenarios) {
    try {
      const { response, payload, latencyMs } = await send("/api/workouts/generate", { memberId: member.profile.id, prompt: scenario.prompt, durationMinutes: scenario.durationMinutes });
      let passed = scenario.expectedStatus === "invalid" ? response.status === 400 : response.ok && payload.status === (scenario.expectedStatus ?? "ready");
      if (payload.status === "ready") {
        const names = payload.plan.sections.flatMap((section: any) => section.exercises.map((exercise: any) => exercise.name)).join(" ");
        passed = passed && payload.mode === "live" && payload.modelCallCount === 2 && payload.plan.totalMinutes >= scenario.durationMinutes - 2 && payload.plan.totalMinutes <= scenario.durationMinutes + 2;
        for (const forbidden of scenario.forbidden ?? []) passed = passed && !names.toLowerCase().includes(forbidden.toLowerCase());
      }
      results.push({ id: scenario.id, workflow: "workout", passed, latencyMs, modelCallCount: payload.modelCallCount, responseIds: payload.modelCalls?.map((call: any) => call.responseId), tokenUsage: payload.modelCalls?.map((call: any) => call.tokenUsage), error: passed ? undefined : payload.error ?? payload.clarification, representative: ["W01", "W05", "W13", "W19"].includes(scenario.id) ? payload : undefined });
    } catch (error) {
      results.push({ id: scenario.id, workflow: "workout", passed: false, latencyMs: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const scenario of copilotScenarios) {
    try {
      const { response, payload, latencyMs } = await send("/api/copilot/query", { memberId: member.profile.id, message: scenario.message });
      const text = JSON.stringify(payload.answer ?? {}).toLowerCase();
      let passed = response.ok && payload.mode === "live" && payload.modelCallCount === 2;
      if (scenario.expectedTopic) passed = passed && payload.topic === scenario.expectedTopic;
      if (scenario.broadSelection) passed = passed && payload.topics?.includes(payload.topic) && payload.topics.length >= 2 && payload.topics.length <= 4;
      for (const expected of scenario.contains) passed = passed && text.includes(expected.toLowerCase());
      if (scenario.containsAny) passed = passed && scenario.containsAny.some((expected) => text.includes(expected.toLowerCase()));
      passed = passed && payload.answer?.narrative?.every((item: any) => item.evidenceIds?.length > 0);
      results.push({ id: scenario.id, workflow: "copilot", passed, latencyMs, modelCallCount: payload.modelCallCount, responseIds: payload.modelCalls?.map((call: any) => call.responseId), tokenUsage: payload.modelCalls?.map((call: any) => call.tokenUsage), error: passed ? undefined : payload.error ?? `topic=${payload.topic}`, representative: ["C01", "C04", "C06", "C13", "C23", "C24", "C25"].includes(scenario.id) ? payload : undefined });
    } catch (error) {
      results.push({ id: scenario.id, workflow: "copilot", passed: false, latencyMs: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const passed = results.filter((result) => result.passed).length;
const criticalFailures = results.filter((result) => !result.passed && ["W01", "W03", "W13", "W19", "C03", "C06", "C13", "C23", "C24"].includes(result.id));
const summary = {
  generatedAt: new Date().toISOString(), model: config.model, unretried: true, total: results.length, passed, failed: results.length - passed,
  passRate: Number((passed / results.length * 100).toFixed(1)), criticalFailures: criticalFailures.map((result) => result.id),
  latency: { averageMs: Math.round(results.reduce((sum, result) => sum + result.latencyMs, 0) / results.length), maxMs: Math.max(...results.map((result) => result.latencyMs)) },
  results,
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync("artifacts/live-evaluation.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ model: summary.model, passed: summary.passed, total: summary.total, passRate: summary.passRate, criticalFailures: summary.criticalFailures, averageLatencyMs: summary.latency.averageMs }, null, 2));
if (summary.passRate < 95 || criticalFailures.length) process.exitCode = 1;
