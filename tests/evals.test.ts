import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { member } from "../src/server/data.js";
import { copilotScenarios, workoutScenarios } from "../evals/scenarios.js";
import { makeControlledGateway } from "./helpers.js";

const config: AppConfig = { port: 3001, model: "gpt-5.6-luna", reasoningEffort: "low", apiKey: "controlled", requireLiveModel: true };
const available = new Set(member.equipment_available);

describe("controlled semantic evaluation matrix", () => {
  const { app } = createApp(config, makeControlledGateway());

  for (const scenario of workoutScenarios) {
    it(`${scenario.id} ${scenario.prompt}`, async () => {
      const response = await request(app).post("/api/workouts/generate").send({ memberId: member.profile.id, prompt: scenario.prompt, durationMinutes: scenario.durationMinutes });
      if (scenario.expectedStatus === "invalid") {
        expect(response.status).toBe(400);
        return;
      }
      expect(response.status).toBe(200);
      expect(response.body.status).toBe(scenario.expectedStatus ?? "ready");
      if (response.body.status !== "ready") {
        expect(response.body.plan).toBeNull();
        return;
      }
      expect(response.body.mode).toBe("live");
      expect(response.body.modelCallCount).toBe(2);
      expect(response.body.plan.totalMinutes).toBeGreaterThanOrEqual(scenario.durationMinutes - 2);
      expect(response.body.plan.totalMinutes).toBeLessThanOrEqual(scenario.durationMinutes + 2);
      expect(response.body.plan.sections.map((section: { phase: string }) => section.phase)).toEqual(["warmup", "main", "cooldown"]);
      if (scenario.expectedFocus) expect(response.body.plan.title).toContain(scenario.expectedFocus);
      const prescriptions = response.body.plan.sections.flatMap((section: { exercises: unknown[] }) => section.exercises) as Array<{ name: string; reps: string | null; durationSeconds: number | null; requiredEquipment: string[]; evidenceIds: string[] }>;
      expect(prescriptions.length).toBeGreaterThan(2);
      expect(prescriptions.every((exercise) => exercise.requiredEquipment.every((item) => available.has(item)))).toBe(true);
      expect(prescriptions.every((exercise) => exercise.evidenceIds.length > 0)).toBe(true);
      expect(prescriptions.every((exercise) => !(exercise.reps && exercise.durationSeconds))).toBe(true);
      for (const forbidden of scenario.forbidden ?? []) expect(prescriptions.map((exercise) => exercise.name).join(" ").toLowerCase()).not.toContain(forbidden.toLowerCase());
      expect(JSON.stringify(response.body.plan)).not.toMatch(/Static Jump|Vertical Jump to Broad Jump|Kettlebell Goblet Cyclist Squat/);
    });
  }

  it("recomputes both adjustment sequences from a base plan", async () => {
    const original = await request(app).post("/api/workouts/generate").send({ memberId: member.profile.id, prompt: "Create a 35-minute full-body workout", durationMinutes: 35 }).expect(200);
    const exclude = await request(app).post("/api/workouts/generate").send({ memberId: member.profile.id, basePlanId: original.body.plan.id, prompt: "Exclude deadlifts and replace anything similar.", durationMinutes: 35 }).expect(200);
    expect(exclude.body.plan.id).not.toBe(original.body.plan.id);
    expect(JSON.stringify(exclude.body.plan)).not.toMatch(/deadlift/i);
    expect(exclude.body.modelCallCount).toBe(2);

    const swap = await request(app).post("/api/workouts/generate").send({ memberId: member.profile.id, basePlanId: exclude.body.plan.id, prompt: "Swap anything requiring unavailable equipment for dumbbell or kettlebell alternatives.", durationMinutes: 35 }).expect(200);
    const prescriptions = swap.body.plan.sections.flatMap((section: { exercises: unknown[] }) => section.exercises) as Array<{ requiredEquipment: string[] }>;
    expect(prescriptions.every((exercise) => exercise.requiredEquipment.every((item) => available.has(item)))).toBe(true);
    expect(swap.body.modelCallCount).toBe(2);
  });

  for (const scenario of copilotScenarios) {
    it(`${scenario.id} ${scenario.message}`, async () => {
      const response = await request(app).post("/api/copilot/query").send({ memberId: member.profile.id, message: scenario.message }).expect(200);
      expect(response.body.topic).toBe(scenario.expectedTopic);
      expect(response.body.mode).toBe("live");
      expect(response.body.modelCallCount).toBe(2);
      const text = JSON.stringify(response.body.answer);
      for (const expected of scenario.contains) expect(text.toLowerCase()).toContain(expected.toLowerCase());
      expect(response.body.answer.claims.every((claim: { evidenceIds: string[] }) => claim.evidenceIds.length > 0)).toBe(true);
      const evidenceIds = new Set(response.body.evidence.map((item: { id: string }) => item.id));
      expect(response.body.answer.claims.every((claim: { evidenceIds: string[] }) => claim.evidenceIds.every((id) => evidenceIds.has(id)))).toBe(true);
      if (scenario.chartValues) expect(response.body.chart.data.map((point: Record<string, string | number>) => Object.values(point).at(-1))).toEqual(scenario.chartValues);
    });
  }

  it("resolves all four required multi-turn follow-ups", async () => {
    const sequences = [
      ["How is adherence trending?", "What might explain that?", "adherence_explanation"],
      ["Show me the brief.", "Draft the congratulations message.", "draft_message"],
      ["What was her latest workout?", "Was there anything concerning?", "workout_concerns"],
      ["Summarize her latest labs.", "Which values are outside the reference range?", "labs_reference"],
    ];
    for (const [firstMessage, followUp, topic] of sequences) {
      const first = await request(app).post("/api/copilot/query").send({ memberId: member.profile.id, message: firstMessage }).expect(200);
      const second = await request(app).post("/api/copilot/query").send({ memberId: member.profile.id, conversationId: first.body.conversationId, message: followUp }).expect(200);
      expect(second.body.topic).toBe(topic);
      expect(second.body.modelCallCount).toBe(2);
    }
  });
});
