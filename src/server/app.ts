import express from "express";
import path from "node:path";
import { ZodError } from "zod";
import { CopilotRequestSchema, WorkoutRequestSchema } from "../shared/schemas.js";
import type { AppConfig } from "./config.js";
import { exercises, member } from "./data.js";
import { buildGraph } from "./graph.js";
import { OpenAIStructuredGateway, type StructuredModelGateway } from "./openai.js";
import { CopilotService } from "./copilot.js";
import { WorkoutService } from "./workout.js";

export function createApp(config: AppConfig, providedGateway?: StructuredModelGateway) {
  const app = express();
  const graph = buildGraph(exercises, member);
  const gateway = providedGateway ?? new OpenAIStructuredGateway(config);
  const workoutService = new WorkoutService(exercises, member, graph, gateway, config);
  const copilotService = new CopilotService(member, gateway, config);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ apiKeyConfigured: Boolean(config.apiKey), model: config.model, graphReady: graph.nodes.size > 0 && graph.edges.size > 0 });
  });

  app.get("/api/member", (_request, response) => {
    response.json({
      coach: { id: "coach_01HXSAM", name: "Sam" },
      member: {
        id: member.profile.id,
        name: member.profile.name,
        age: member.profile.age,
        tier: member.profile.tier,
        goal: member.goals[0].text,
        knee: `${member.injuries[0].severity} · ${member.injuries[0].status}`,
        equipment: member.equipment_available,
        adherence: member.adherence.weekly_completion_pct.at(-1)?.pct,
        adherenceTrend: member.adherence.trend,
        churnRisk: member.coach_brief.churn_risk.level,
      },
      graph: graph.stats(),
    });
  });

  app.post("/api/workouts/generate", async (request, response, next) => {
    try {
      const body = WorkoutRequestSchema.parse(request.body);
      if (body.memberId !== member.profile.id) return response.status(404).json({ error: "Member not found" });
      return response.json(await workoutService.generate(body));
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/copilot/query", async (request, response, next) => {
    try {
      const body = CopilotRequestSchema.parse(request.body);
      if (body.memberId !== member.profile.id) return response.status(404).json({ error: "Member not found" });
      return response.json(await copilotService.query(body));
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
    const message = error instanceof Error ? error.message : "Unknown server error";
    const safeMessage = /OPENAI_API_KEY/.test(message) ? "Live model is not configured" : message;
    return response.status(500).json({ error: safeMessage });
  });

  return { app, graph, services: { workoutService, copilotService } };
}
