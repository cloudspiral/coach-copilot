import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type { MemberContext } from "../data.js";
import { buildDomainGraph, slug } from "../graph.js";
import type { ExerciseRecord } from "../../shared/schemas.js";
import * as schema from "./schema.js";
import { labUnits } from "./postgres-repositories.js";

type Database = NodePgDatabase<typeof schema>;

const ExerciseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  muscle_groups: z.array(z.string()),
  joints_loaded: z.array(z.string()),
  movement_patterns: z.array(z.string()),
  equipment_required: z.array(z.string()),
  is_bilateral: z.boolean(),
  side: z.string().nullable(),
  priority_tier: z.number().int(),
  is_reps: z.boolean(),
  is_duration: z.boolean(),
  supports_weight: z.boolean(),
  estimated_rep_duration: z.number(),
  bilateral_pair_id: z.string().nullable(),
});

const MemberSchema = z.object({
  _note: z.string(),
  profile: z.object({
    id: z.string().min(1), name: z.string().min(1), age: z.number().int(), sex: z.string(), height_cm: z.number(), weight_kg: z.number(),
    timezone: z.string(), member_since: z.string(), coach_id: z.string().min(1), tier: z.string(),
  }),
  goals: z.array(z.object({ id: z.string(), text: z.string(), priority: z.number().int(), target_date: z.string().nullable() })),
  preferences: z.object({
    preferred_session_minutes: z.number().int(), training_days_per_week: z.number().int(), preferred_days: z.array(z.string()), dislikes: z.array(z.string()), notes: z.string(),
  }),
  equipment_available: z.array(z.string()),
  injuries: z.array(z.object({ id: z.string(), region: z.string(), joint: z.string(), status: z.string(), severity: z.string(), since: z.string(), notes: z.string(), snomedct_hint: z.string(), mapped_concept_id: z.string().optional() })),
  workout_history: z.array(z.object({ date: z.string(), title: z.string(), planned: z.boolean(), completed: z.boolean(), duration_min: z.number().int(), rpe: z.number().int().nullable(), exercises: z.array(z.string()) })),
  adherence: z.object({ weekly_completion_pct: z.array(z.object({ week_of: z.string(), pct: z.number().int() })), trend: z.string() }),
  biomarkers: z.object({ resting_hr_bpm: z.number(), hrv_ms: z.number(), sleep_hours_last_7_days: z.array(z.number()), weight_trend_kg: z.array(z.object({ date: z.string(), kg: z.number() })) }),
  labs: z.object({ blood_panel: z.record(z.string(), z.union([z.string(), z.number()])), dexa_scan: z.record(z.string(), z.union([z.string(), z.number()])) }),
  chat_history: z.array(z.object({ ts: z.string(), from: z.enum(["member", "coach"]), text: z.string(), attachments: z.array(z.object({ type: z.string(), caption: z.string() })).optional() })),
  coach_brief: z.object({ generated_for: z.string(), morning_tasks: z.array(z.object({ type: z.string(), text: z.string() })), churn_risk: z.object({ level: z.string(), reasons: z.array(z.string()) }) }),
});

export interface SeedPayload {
  exercises: ExerciseRecord[];
  member: MemberContext;
}

export interface SeedResult {
  status: "created" | "unchanged";
  sourceHash: string;
  graphVersionId: string;
  nodes: number;
  edges: number;
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

export function sourceHash(payload: SeedPayload): string {
  return createHash("sha256").update(JSON.stringify({ schemaVersion: "coach-copilot-v1", ...payload })).digest("hex");
}

export function validateGraph(graph: ReturnType<typeof buildDomainGraph>): void {
  if (!graph.nodes.size || !graph.edges.size) throw new Error("Graph must contain nodes and edges");
  const relationshipKeys = new Set<string>();
  for (const edge of graph.edges.values()) {
    if (!graph.nodes.has(edge.source) || !graph.nodes.has(edge.target)) throw new Error(`Dangling graph edge ${edge.id}`);
    const key = `${edge.source}:${edge.type}:${edge.target}`;
    if (relationshipKeys.has(key)) throw new Error(`Duplicate graph relationship ${key}`);
    relationshipKeys.add(key);
  }
  if (!graph.ancestors("anatomy:patellofemoral-area").has("anatomy:knee")) throw new Error("Required patellofemoral-to-knee safety path is missing");
}

function numericLabEntries(record: Record<string, string | number>): Array<[string, number]> {
  return Object.entries(record).filter((entry): entry is [string, number] => entry[0] !== "date" && typeof entry[1] === "number");
}

export async function seedDatabase(db: Database, input: SeedPayload): Promise<SeedResult> {
  const exercises = ExerciseSchema.array().parse(input.exercises) as ExerciseRecord[];
  const member = MemberSchema.parse(input.member) as MemberContext;
  const payload = { exercises, member };
  const hash = sourceHash(payload);
  const existing = await db.select().from(schema.ingestionRuns)
    .where(and(eq(schema.ingestionRuns.sourceHash, hash), eq(schema.ingestionRuns.status, "succeeded")))
    .limit(1);
  if (existing[0]) {
    const [version] = await db.select().from(schema.graphVersions).where(eq(schema.graphVersions.sourceHash, hash)).limit(1);
    if (!version) throw new Error(`Successful ingestion ${existing[0].id} has no graph version`);
    const graph = buildDomainGraph(exercises);
    return { status: "unchanged", sourceHash: hash, graphVersionId: version.id, nodes: graph.nodes.size, edges: graph.edges.size };
  }

  const graph = buildDomainGraph(exercises);
  validateGraph(graph);
  const ingestionId = `ing_${randomUUID()}`;
  const graphVersionId = `graph_${randomUUID()}`;
  const memberId = member.profile.id;
  const organizationId = "org_future_demo";
  const historyConversationId = `history:${memberId}`;

  await db.transaction(async (tx) => {
    await tx.insert(schema.ingestionRuns).values({
      id: ingestionId,
      sourceName: "data/exercises.json + data/member-context.json",
      sourceHash: hash,
      schemaVersion: "coach-copilot-v1",
      rawPayload: payload as unknown as Record<string, unknown>,
      status: "processing",
      errors: [],
    });
    await tx.insert(schema.organizations).values({ id: organizationId, name: "Future Demo" }).onConflictDoNothing();
    await tx.insert(schema.coaches).values({ id: member.profile.coach_id, organizationId, name: "Sam" })
      .onConflictDoUpdate({ target: schema.coaches.id, set: { organizationId, name: "Sam" } });
    await tx.insert(schema.members).values({
      id: memberId,
      organizationId,
      coachId: member.profile.coach_id,
      name: member.profile.name,
      age: member.profile.age,
      sex: member.profile.sex,
      heightCm: member.profile.height_cm,
      weightKg: member.profile.weight_kg,
      timezone: member.profile.timezone,
      memberSince: member.profile.member_since,
      tier: member.profile.tier,
    }).onConflictDoUpdate({
      target: schema.members.id,
      set: {
        organizationId, coachId: member.profile.coach_id, name: member.profile.name, age: member.profile.age, sex: member.profile.sex,
        heightCm: member.profile.height_cm, weightKg: member.profile.weight_kg, timezone: member.profile.timezone, memberSince: member.profile.member_since, tier: member.profile.tier,
      },
    });

    await tx.delete(schema.memberGoals).where(eq(schema.memberGoals.memberId, memberId));
    await tx.delete(schema.memberPreferences).where(eq(schema.memberPreferences.memberId, memberId));
    await tx.delete(schema.memberEquipment).where(eq(schema.memberEquipment.memberId, memberId));
    await tx.delete(schema.memberConditions).where(eq(schema.memberConditions.memberId, memberId));
    await tx.delete(schema.workoutSessions).where(eq(schema.workoutSessions.memberId, memberId));
    await tx.delete(schema.adherenceObservations).where(eq(schema.adherenceObservations.memberId, memberId));
    await tx.delete(schema.biometricObservations).where(eq(schema.biometricObservations.memberId, memberId));
    await tx.delete(schema.labReports).where(eq(schema.labReports.memberId, memberId));
    await tx.delete(schema.coachBriefs).where(eq(schema.coachBriefs.memberId, memberId));
    await tx.delete(schema.riskAssessments).where(eq(schema.riskAssessments.memberId, memberId));
    await tx.delete(schema.conversations).where(eq(schema.conversations.id, historyConversationId));

    if (member.goals.length) await tx.insert(schema.memberGoals).values(member.goals.map((goal) => ({ memberId, goalId: goal.id, text: goal.text, priority: goal.priority, targetDate: goal.target_date })));
    await tx.insert(schema.memberPreferences).values({
      memberId,
      preferredSessionMinutes: member.preferences.preferred_session_minutes,
      trainingDaysPerWeek: member.preferences.training_days_per_week,
      preferredDays: member.preferences.preferred_days,
      dislikes: member.preferences.dislikes,
      notes: member.preferences.notes,
    });
    if (member.equipment_available.length) await tx.insert(schema.memberEquipment).values(member.equipment_available.map((equipment) => ({ memberId, equipment, conceptId: `equipment:${slug(equipment)}` })));
    if (member.injuries.length) await tx.insert(schema.memberConditions).values(member.injuries.map((injury) => ({
      id: injury.id, memberId, region: injury.region, joint: injury.joint, status: injury.status, severity: injury.severity, since: injury.since,
      notes: injury.notes,
      ontologyHint: injury.snomedct_hint,
      mappedConceptId: injury.mapped_concept_id ?? (/knee|patell/i.test(`${injury.joint} ${injury.region}`) ? "anatomy:patellofemoral-area" : `anatomy:${slug(injury.joint || injury.region)}`),
    })));

    for (const workout of member.workout_history) {
      const workoutId = stableId("session", `${memberId}:${workout.date}:${workout.title}`);
      await tx.insert(schema.workoutSessions).values({ id: workoutId, memberId, sessionDate: workout.date, title: workout.title, planned: workout.planned, completed: workout.completed, durationMinutes: workout.duration_min, rpe: workout.rpe });
      if (workout.exercises.length) await tx.insert(schema.workoutSessionExercises).values(workout.exercises.map((exerciseName, exercisePosition) => ({ workoutSessionId: workoutId, position: exercisePosition, exerciseName })));
    }
    if (member.adherence.weekly_completion_pct.length) await tx.insert(schema.adherenceObservations).values(member.adherence.weekly_completion_pct.map((point) => ({ memberId, weekOf: point.week_of, completionPct: point.pct })));

    const biometrics = [
      { id: stableId("bio", `${memberId}:resting_hr_bpm`), memberId, metric: "resting_hr_bpm", observedAt: "2026-06-04", numericValue: member.biomarkers.resting_hr_bpm, unit: "bpm" },
      { id: stableId("bio", `${memberId}:hrv_ms`), memberId, metric: "hrv_ms", observedAt: "2026-06-04", numericValue: member.biomarkers.hrv_ms, unit: "ms" },
      ...member.biomarkers.sleep_hours_last_7_days.map((numericValue, index) => ({
        id: stableId("bio", `${memberId}:sleep:${index}`),
        memberId,
        metric: "sleep_hours",
        observedAt: ["2026-05-29", "2026-05-30", "2026-05-31", "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"][index],
        numericValue,
        unit: "hours",
      })),
      ...member.biomarkers.weight_trend_kg.map((point) => ({ id: stableId("bio", `${memberId}:weight:${point.date}`), memberId, metric: "weight_kg", observedAt: point.date, numericValue: point.kg, unit: "kg" })),
    ];
    await tx.insert(schema.biometricObservations).values(biometrics);

    for (const [reportType, values] of Object.entries(member.labs) as Array<[keyof MemberContext["labs"], Record<string, string | number>]>) {
      const observedAt = String(values.date);
      const reportId = stableId("lab", `${memberId}:${reportType}:${observedAt}`);
      await tx.insert(schema.labReports).values({ id: reportId, memberId, reportType, observedAt });
      const observations = numericLabEntries(values).map(([metric, numericValue]) => ({ reportId, metric, numericValue, unit: labUnits[metric] ?? "value" }));
      if (observations.length) await tx.insert(schema.labObservations).values(observations);
    }

    await tx.insert(schema.conversations).values({ id: historyConversationId, organizationId, memberId });
    for (const [index, message] of member.chat_history.entries()) {
      const messageId = stableId("message", `${memberId}:${message.ts}:${index}`);
      await tx.insert(schema.messages).values({ id: messageId, conversationId: historyConversationId, memberId, sender: message.from, body: message.text, occurredAt: message.ts });
      if (message.attachments?.length) await tx.insert(schema.messageAttachments).values(message.attachments.map((attachment, attachmentIndex) => ({ id: stableId("attachment", `${messageId}:${attachmentIndex}`), messageId, type: attachment.type, caption: attachment.caption })));
    }
    await tx.insert(schema.coachBriefs).values({ memberId, generatedFor: member.coach_brief.generated_for, morningTasks: member.coach_brief.morning_tasks });
    await tx.insert(schema.riskAssessments).values({ memberId, assessedFor: member.coach_brief.generated_for, level: member.coach_brief.churn_risk.level, reasons: member.coach_brief.churn_risk.reasons });

    for (const exercise of exercises) await tx.insert(schema.exercises).values({ id: exercise.id, name: exercise.name, properties: exercise as unknown as Record<string, unknown>, sourceIngestionId: ingestionId })
      .onConflictDoUpdate({ target: schema.exercises.id, set: { name: exercise.name, properties: exercise as unknown as Record<string, unknown>, sourceIngestionId: ingestionId } });

    await tx.insert(schema.graphVersions).values({ id: graphVersionId, ingestionRunId: ingestionId, sourceHash: hash, status: "staged" });
    await tx.insert(schema.graphNodes).values([...graph.nodes.values()].map((node) => ({ graphVersionId, nodeId: node.id, nodeType: node.type, label: node.label, properties: node.properties, provenance: node.provenance })));
    await tx.insert(schema.graphEdges).values([...graph.edges.values()].map((edge) => ({ graphVersionId, edgeId: edge.id, sourceNodeId: edge.source, targetNodeId: edge.target, relationshipType: edge.type, properties: edge.properties, provenance: edge.provenance })));

    await tx.update(schema.graphVersions).set({ status: "retired" }).where(eq(schema.graphVersions.status, "active"));
    await tx.update(schema.graphVersions).set({ status: "active", activatedAt: new Date().toISOString() }).where(eq(schema.graphVersions.id, graphVersionId));
    await tx.update(schema.ingestionRuns).set({ status: "succeeded", completedAt: new Date().toISOString() }).where(eq(schema.ingestionRuns.id, ingestionId));
  });

  return { status: "created", sourceHash: hash, graphVersionId, nodes: graph.nodes.size, edges: graph.edges.size };
}
