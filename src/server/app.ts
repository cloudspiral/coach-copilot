import express from "express";
import path from "node:path";
import { ZodError } from "zod";
import { CopilotRequestSchema, WorkoutRequestSchema } from "../shared/schemas.js";
import type { AppConfig } from "./config.js";
import { MemberNotFoundError } from "./graph-provider.js";
import type { ApplicationRuntime } from "./runtime.js";

export function createApp(config: AppConfig, runtime: ApplicationRuntime) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  app.get("/api/health", (_request, response) => {
    const graph = runtime.graphProvider.status();
    response.json({ apiKeyConfigured: Boolean(config.apiKey), model: config.model, graphReady: graph.ready && graph.nodes > 0 && graph.edges > 0 });
  });

  app.get("/api/ready", async (_request, response) => {
    const readiness = await runtime.readiness();
    return response.status(readiness.ready ? 200 : 503).json(readiness);
  });

  app.get("/api/member", async (_request, response, next) => {
    try {
      const memberId = config.demoMemberId ?? "mbr_01HX9JORDAN";
      const [member, memberGraph] = await Promise.all([
        runtime.repositories.data.getMember(memberId),
        runtime.graphProvider.forMember(memberId),
      ]);
      if (!member) throw new MemberNotFoundError(memberId);
      return response.json({
        coach: { id: member.profile.coach_id, name: "Sam" },
        member: {
          id: member.profile.id,
          name: member.profile.name,
          age: member.profile.age,
          tier: member.profile.tier,
          goal: member.goals[0]?.text ?? "No current goal",
          knee: member.injuries[0] ? `${member.injuries[0].severity} · ${member.injuries[0].status}` : "No recorded knee condition",
          equipment: member.equipment_available,
          adherence: member.adherence.weekly_completion_pct.at(-1)?.pct,
          adherenceTrend: member.adherence.trend,
          churnRisk: member.coach_brief.churn_risk.level,
        },
        graph: memberGraph.graph.stats(),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/workouts/generate", async (request, response, next) => {
    try {
      const body = WorkoutRequestSchema.parse(request.body);
      return response.json(await runtime.workflows.generateWorkout(body));
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/copilot/query", async (request, response, next) => {
    try {
      const body = CopilotRequestSchema.parse(request.body);
      return response.json(await runtime.workflows.queryCopilot(body));
    } catch (error) {
      return next(error);
    }
  });

  if (process.env.NODE_ENV === "production") {
    const clientPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(clientPath));
    app.get("/{*splat}", (_request, response) => response.sendFile(path.join(clientPath, "index.html")));
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) return response.status(400).json({ error: "Invalid request", issues: error.issues });
    if (error instanceof MemberNotFoundError) return response.status(404).json({ error: "Member not found" });
    const message = error instanceof Error ? error.message : "Unknown server error";
    const safeMessage = /OPENAI_API_KEY/.test(message) ? "Live model is not configured" : message;
    return response.status(500).json({ error: safeMessage });
  });

  return { app, runtime };
}
