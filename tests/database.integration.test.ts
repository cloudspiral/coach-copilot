import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { assertTestDatabase, createDatabase, type DatabaseHandle } from "../src/server/db/database.js";
import { seedDatabase } from "../src/server/db/ingestion.js";
import { createPostgresRepositories } from "../src/server/db/postgres-repositories.js";
import * as schema from "../src/server/db/schema.js";
import { exercises, member } from "../src/server/data.js";
import { createProductionRuntime, type ApplicationRuntime } from "../src/server/runtime.js";
import { makeControlledGateway } from "./helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://coach_copilot:coach_copilot@127.0.0.1:5434/coach_copilot_test";
assertTestDatabase(databaseUrl);
const config: AppConfig = {
  port: 3001,
  model: "gpt-5.6-luna",
  reasoningEffort: "low",
  apiKey: "controlled",
  requireLiveModel: true,
  databaseUrl,
};

let database: DatabaseHandle;
let runtime: ApplicationRuntime;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  runtime = await createProductionRuntime(config, makeControlledGateway());
});

afterAll(async () => {
  await runtime.close();
  await database.close();
});

describe("PostgreSQL production persistence", () => {
  it("has application migrations, seed data, one active graph, and working checkpoint tables", async () => {
    const migration = await database.pool.query<{ table_name: string | null }>("SELECT to_regclass('drizzle.__drizzle_migrations')::text AS table_name");
    expect(migration.rows[0]?.table_name).toBe("drizzle.__drizzle_migrations");
    const active = await database.db.select().from(schema.graphVersions).where(eq(schema.graphVersions.status, "active"));
    expect(active).toHaveLength(1);
    const checkpoint = await database.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM langgraph.checkpoints");
    expect(Number(checkpoint.rows[0]?.count)).toBeGreaterThanOrEqual(0);
    const repositories = createPostgresRepositories(database.db);
    expect(await repositories.data.getMember(member.profile.id)).not.toBeNull();
    expect(await repositories.data.getMember("member_from_another_tenant")).toBeNull();
    expect((await repositories.graphs.loadActive())?.graph.nodes.size).toBeGreaterThan(0);
  });

  it("treats an already-successful source hash as an idempotent no-op", async () => {
    const result = await seedDatabase(database.db, { exercises, member });
    expect(result.status).toBe("unchanged");
    const runs = await database.db.select().from(schema.ingestionRuns);
    expect(runs).toHaveLength(1);
  });

  it("rejects dangling or cross-version edges without changing the active version", async () => {
    const [before] = await database.db.select().from(schema.graphVersions).where(eq(schema.graphVersions.status, "active"));
    const suffix = randomUUID();
    await expect(database.db.transaction(async (tx) => {
      const ingestionId = `invalid_ingestion_${suffix}`;
      const versionId = `invalid_graph_${suffix}`;
      await tx.insert(schema.ingestionRuns).values({
        id: ingestionId,
        sourceName: "invalid-test-payload",
        sourceHash: `invalid-${suffix}`,
        schemaVersion: "test",
        rawPayload: {},
        status: "processing",
        errors: [],
      });
      await tx.insert(schema.graphVersions).values({ id: versionId, ingestionRunId: ingestionId, sourceHash: `invalid-${suffix}`, status: "staged" });
      await tx.insert(schema.graphNodes).values({ graphVersionId: versionId, nodeId: "node:present", nodeType: "Anatomy", label: "Present", properties: {} });
      await tx.insert(schema.graphEdges).values({
        graphVersionId: versionId,
        edgeId: "edge:dangling",
        sourceNodeId: "node:present",
        targetNodeId: "node:from-another-version",
        relationshipType: "part_of",
        properties: {},
      });
    })).rejects.toThrow();
    const [after] = await database.db.select().from(schema.graphVersions).where(eq(schema.graphVersions.status, "active"));
    expect(after.id).toBe(before.id);
  });

  it("persists plans, adjustments, conversations, follow-ups, workflow runs, and checkpoints across runtime recreation", async () => {
    let app = createApp(config, runtime).app;
    const original = await request(app).post("/api/workouts/generate").send({
      memberId: member.profile.id,
      prompt: "Create a 35-minute full-body workout",
      durationMinutes: 35,
    }).expect(200);
    const first = await request(app).post("/api/copilot/query").send({ memberId: member.profile.id, message: "How is adherence trending?" }).expect(200);
    await runtime.close();

    runtime = await createProductionRuntime(config, makeControlledGateway());
    app = createApp(config, runtime).app;
    const adjusted = await request(app).post("/api/workouts/generate").send({
      memberId: member.profile.id,
      basePlanId: original.body.plan.id,
      prompt: "Exclude deadlifts and replace anything similar.",
      durationMinutes: 35,
    }).expect(200);
    expect(adjusted.body.status).toBe("ready");
    expect(JSON.stringify(adjusted.body.plan)).not.toMatch(/deadlift/i);

    const followUp = await request(app).post("/api/copilot/query").send({
      memberId: member.profile.id,
      conversationId: first.body.conversationId,
      message: "What might explain that?",
    }).expect(200);
    expect(followUp.body.topic).toBe("adherence_explanation");

    const [counts] = await database.db.select({
      workflows: sql<number>`count(distinct ${schema.workflowRuns.id})::int`,
      plans: sql<number>`count(distinct ${schema.generatedWorkoutPlans.id})::int`,
    }).from(schema.workflowRuns).leftJoin(schema.generatedWorkoutPlans, eq(schema.generatedWorkoutPlans.workflowRunId, schema.workflowRuns.id));
    expect(counts.workflows).toBeGreaterThanOrEqual(4);
    expect(counts.plans).toBeGreaterThanOrEqual(2);
    const checkpoint = await database.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM langgraph.checkpoints");
    expect(Number(checkpoint.rows[0]?.count)).toBeGreaterThan(0);
  });
});
