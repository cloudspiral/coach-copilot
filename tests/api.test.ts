import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { makeControlledGateway } from "./helpers.js";

const config: AppConfig = { port: 3001, model: "gpt-5.6-luna", reasoningEffort: "low", apiKey: "configured-for-mock", requireLiveModel: true };
const { app } = createApp(config, makeControlledGateway());

describe("Coach Copilot API", () => {
  it("reports safe health metadata without exposing credentials", async () => {
    const response = await request(app).get("/api/health").expect(200);
    expect(response.body).toEqual({ apiKeyConfigured: true, model: "gpt-5.6-luna", graphReady: true });
    expect(JSON.stringify(response.body)).not.toContain("configured-for-mock");
  });

  it("generates a knee-aware plan with exactly two controlled calls", async () => {
    const response = await request(app).post("/api/workouts/generate").send({ memberId: "mbr_01HX9JORDAN", prompt: "Create a 30-minute lower-body workout for Jordan. Go easy on her left knee.", durationMinutes: 30 }).expect(200);
    expect(response.body).toMatchObject({ status: "ready", mode: "live", model: "gpt-5.6-luna", modelCallCount: 2 });
    expect(response.body.plan.totalMinutes).toBe(30);
    expect(response.body.plan.sections.map((section: { phase: string }) => section.phase)).toEqual(["warmup", "main", "cooldown"]);
    expect(response.body.plan.sections.flatMap((section: { exercises: Array<{ reps: string | null; durationSeconds: number | null }> }) => section.exercises).every((exercise: { reps: string | null; durationSeconds: number | null }) => !(exercise.reps && exercise.durationSeconds))).toBe(true);
    const names = response.body.plan.sections.flatMap((section: { exercises: Array<{ name: string }> }) => section.exercises.map((exercise) => exercise.name));
    expect(names).not.toContain("Static Jump");
    expect(names).not.toContain("Kettlebell Goblet Cyclist Squat");
    expect(response.body.decisions.some((decision: { reason: string }) => /plyometric/i.test(decision.reason))).toBe(true);
    const prescriptions = response.body.plan.sections.flatMap((section: { exercises: Array<{ exerciseId: string; evidenceIds: string[] }> }) => section.exercises);
    for (const exercise of prescriptions) {
      const citedEvidence = response.body.evidence.filter((item: { id: string }) => exercise.evidenceIds.includes(item.id));
      expect(citedEvidence.some((item: { ruleId?: string }) => item.ruleId === "KNEE-GRAPH-01")).toBe(true);
      expect(citedEvidence.find((item: { ruleId?: string }) => item.ruleId === "KNEE-GRAPH-01")?.graphPath).toContain(`exercise:${exercise.exerciseId}`);
      expect(response.body.decisions.find((decision: { exerciseId: string }) => decision.exerciseId === exercise.exerciseId)?.reason).toMatch(/graph/i);
    }
  });

  it("clarifies unknown safety anatomy and validates request bounds", async () => {
    const unknown = await request(app).post("/api/workouts/generate").send({ memberId: "mbr_01HX9JORDAN", prompt: "Her zorp joint hurts", durationMinutes: 30 }).expect(200);
    expect(unknown.body.status).toBe("needs_clarification");
    expect(unknown.body.plan).toBeNull();
    await request(app).post("/api/workouts/generate").send({ memberId: "mbr_01HX9JORDAN", prompt: "five minutes", durationMinutes: 5 }).expect(400);
  });

  it("answers adherence with grounded exact values, chart data, and follow-up context", async () => {
    const first = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", message: "Plot adherence trend" }).expect(200);
    expect(first.body).toMatchObject({ mode: "live", modelCallCount: 2, topic: "adherence" });
    expect(first.body.answer.narrative[0].text).toContain("100%, 100%, 75%, and 50%");
    expect(first.body.chart.data.map((point: { Completion: number }) => point.Completion)).toEqual([100, 100, 75, 50]);
    expect(first.body.answer.narrative.every((item: { evidenceIds: string[] }) => item.evidenceIds.length > 0)).toBe(true);

    const followUp = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", conversationId: first.body.conversationId, message: "What might explain that?" }).expect(200);
    expect(followUp.body.topic).toBe("adherence_explanation");
    expect(JSON.stringify(followUp.body.answer)).toContain("work demands and fatigue");
  });

  it("handles unavailable and clinical interpretation questions safely", async () => {
    const bp = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", message: "What is her blood pressure?" }).expect(200);
    expect(bp.body.answer.narrative[0].text).toContain("not available");
    const vitamin = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", message: "Is her vitamin D clinically deficient?" }).expect(200);
    expect(JSON.stringify(vitamin.body.answer)).toContain("28 ng/mL");
    expect(JSON.stringify(vitamin.body.answer)).toContain("cannot establish");
  });

  it("routes natural coach phrasing and trims narrow follow-up answers", async () => {
    const today = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", message: "I'm about to hop on with Jordan. What are the two or three things I shouldn't miss?" }).expect(200);
    expect(today.body.topic).toBe("today");
    expect(today.body.answer.narrative).toHaveLength(3);

    const sleep = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", message: "How much sleep has she been getting lately?" }).expect(200);
    const sleepFollowUp = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", conversationId: sleep.body.conversationId, message: "And how many nights did she hit her seven-hour goal?" }).expect(200);
    expect(sleepFollowUp.body.topic).toBe("sleep");
    expect(sleepFollowUp.body.answer.narrative).toHaveLength(1);
    expect(sleepFollowUp.body.answer.narrative[0].text).toContain("Two");

    const latest = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", message: "Remind me what happened in her most recent completed session." }).expect(200);
    expect(latest.body.topic).toBe("workout");
    expect(latest.body.answer.narrative[0].text).toContain("RPE 6");

    const kneeProgramming = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", message: "What should I avoid programming right now because of her knee?" }).expect(200);
    expect(kneeProgramming.body.topic).toBe("injuries");
    expect(kneeProgramming.body.answer.narrative[0].text).toContain("plyometrics");

    const bloodPressure = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", message: "Do we have a blood-pressure reading for Jordan anywhere?" }).expect(200);
    expect(bloodPressure.body.topic).toBe("unavailable");
    expect(bloodPressure.body.answer.narrative[0].text).toContain("not available");
  });

  it("lets the model select graph topics for broad questions and retrieves omitted fields on follow-up", async () => {
    const response = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", message: "How's he doing overall?" }).expect(200);
    expect(response.body).toMatchObject({ mode: "live", modelCallCount: 2, topic: "workout", topics: ["workout", "adherence", "injuries"] });
    expect(response.body.answer.narrative).toHaveLength(3);
    expect(response.body.answer.narrative.map((item: { evidenceIds: string[] }) => item.evidenceIds)).toEqual([["ev-c-1"], ["ev-c-2"], ["ev-c-3"]]);
    expect(response.body.evidence.map((item: { jsonPointer: string }) => item.jsonPointer)).toEqual(["/workout_history/0", "/adherence/weekly_completion_pct", "/injuries/0"]);

    const followUp = await request(app).post("/api/copilot/query").send({ memberId: "mbr_01HX9JORDAN", conversationId: response.body.conversationId, message: "What about her sleep?" }).expect(200);
    expect(followUp.body).toMatchObject({ topic: "sleep", topics: ["sleep"] });
    expect(followUp.body.answer.narrative[0].text).toContain("6.3 hours");
    expect(followUp.body.evidence[0].jsonPointer).toBe("/biomarkers/sleep_hours_last_7_days");
  });

  it("normalizes natural equipment and safety language without false clarification", async () => {
    const limited = await request(app).post("/api/workouts/generate").send({
      memberId: "mbr_01HX9JORDAN",
      prompt: "She's training in her living room with just her dumbbells and mat. Can you build a 25-minute full-body session?",
      durationMinutes: 25,
    }).expect(200);
    expect(limited.body.status).toBe("ready");
    const allowed = new Set(["Dumbbell", "Yoga Mat"]);
    expect(limited.body.plan.sections.flatMap((section: { exercises: Array<{ requiredEquipment: string[] }> }) => section.exercises).every((exercise: { requiredEquipment: string[] }) => exercise.requiredEquipment.every((item) => allowed.has(item)))).toBe(true);

    const gentle = await request(app).post("/api/workouts/generate").send({
      memberId: "mbr_01HX9JORDAN",
      prompt: "Her knee is more sensitive today, but she still wants a lower-body session. Keep the leg work gentle.",
      durationMinutes: 30,
    }).expect(200);
    expect(gentle.body.status).toBe("ready");

    const unknown = await request(app).post("/api/workouts/generate").send({
      memberId: "mbr_01HX9JORDAN",
      prompt: "Can you plan around the zorp joint that's been hurting her?",
      durationMinutes: 30,
    }).expect(200);
    expect(unknown.body.status).toBe("needs_clarification");
    expect(unknown.body.clarification).toContain("zorp joint");

    const noJumping = await request(app).post("/api/workouts/generate").send({
      memberId: "mbr_01HX9JORDAN",
      prompt: "No jumping today, even if it would normally fit.",
      durationMinutes: 30,
    }).expect(200);
    const jumpDecision = noJumping.body.decisions.find((decision: { exerciseName: string }) => decision.exerciseName === "Static Jump");
    expect(jumpDecision.reason).toContain("Plyometrics are removed by the active knee rule");
  });
});
