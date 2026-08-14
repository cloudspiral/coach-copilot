import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { CopilotResponse } from "../copilot.js";
import type { MemberContext } from "../data.js";
import { KnowledgeGraph } from "../graph.js";
import type {
  ActiveDomainGraph,
  ConversationRepository,
  ConversationTurn,
  DataRepository,
  GraphRepository,
  PlanRepository,
  RuntimeRepositories,
  WorkflowRepository,
} from "../repositories.js";
import type { WorkoutResponse } from "../workout.js";
import type {
  EdgeType,
  ExerciseRecord,
  NodeType,
  Provenance,
  WorkoutIntent,
  WorkoutPlan,
} from "../../shared/schemas.js";
import * as schema from "./schema.js";

type Database = NodePgDatabase<typeof schema>;

const labUnits: Record<string, string> = {
  ldl_mg_dl: "mg/dL",
  hdl_mg_dl: "mg/dL",
  triglycerides_mg_dl: "mg/dL",
  hba1c_pct: "%",
  vitamin_d_ng_ml: "ng/mL",
  ferritin_ng_ml: "ng/mL",
  crp_mg_l: "mg/L",
  body_fat_pct: "%",
  lean_mass_kg: "kg",
  fat_mass_kg: "kg",
  bone_density_z_score: "z-score",
  visceral_fat_cm2: "cm2",
};

export class PostgresDataRepository implements DataRepository {
  constructor(private readonly db: Database) {}

  async getExercises(): Promise<ExerciseRecord[]> {
    const rows = await this.db.select().from(schema.exercises).orderBy(asc(schema.exercises.id));
    return rows.map((row) => row.properties as unknown as ExerciseRecord);
  }

  async getMember(memberId: string): Promise<MemberContext | null> {
    const [profile] = await this.db.select().from(schema.members).where(eq(schema.members.id, memberId)).limit(1);
    if (!profile) return null;

    const [
      coachRows,
      goals,
      preferenceRows,
      equipmentRows,
      conditionRows,
      sessionRows,
      adherenceRows,
      biometricRows,
      reportRows,
      briefRows,
      riskRows,
      historyMessages,
    ] = await Promise.all([
      this.db.select().from(schema.coaches).where(eq(schema.coaches.id, profile.coachId)).limit(1),
      this.db.select().from(schema.memberGoals).where(eq(schema.memberGoals.memberId, memberId)).orderBy(asc(schema.memberGoals.priority), asc(schema.memberGoals.goalId)),
      this.db.select().from(schema.memberPreferences).where(eq(schema.memberPreferences.memberId, memberId)).limit(1),
      this.db.select().from(schema.memberEquipment).where(eq(schema.memberEquipment.memberId, memberId)).orderBy(asc(schema.memberEquipment.equipment)),
      this.db.select().from(schema.memberConditions).where(eq(schema.memberConditions.memberId, memberId)).orderBy(asc(schema.memberConditions.since)),
      this.db.select().from(schema.workoutSessions).where(eq(schema.workoutSessions.memberId, memberId)).orderBy(desc(schema.workoutSessions.sessionDate)),
      this.db.select().from(schema.adherenceObservations).where(eq(schema.adherenceObservations.memberId, memberId)).orderBy(asc(schema.adherenceObservations.weekOf)),
      this.db.select().from(schema.biometricObservations).where(eq(schema.biometricObservations.memberId, memberId)).orderBy(asc(schema.biometricObservations.observedAt)),
      this.db.select().from(schema.labReports).where(eq(schema.labReports.memberId, memberId)).orderBy(desc(schema.labReports.observedAt)),
      this.db.select().from(schema.coachBriefs).where(eq(schema.coachBriefs.memberId, memberId)).orderBy(desc(schema.coachBriefs.generatedFor)).limit(1),
      this.db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.memberId, memberId)).orderBy(desc(schema.riskAssessments.assessedFor)).limit(1),
      this.db.select().from(schema.messages).where(and(eq(schema.messages.memberId, memberId), eq(schema.messages.conversationId, `history:${memberId}`))).orderBy(desc(schema.messages.occurredAt)),
    ]);
    const [sessionExerciseRows, labObservationRows, attachmentRows] = await Promise.all([
      sessionRows.length
        ? this.db.select().from(schema.workoutSessionExercises).where(inArray(schema.workoutSessionExercises.workoutSessionId, sessionRows.map((session) => session.id))).orderBy(asc(schema.workoutSessionExercises.position))
        : Promise.resolve([]),
      reportRows.length
        ? this.db.select().from(schema.labObservations).where(inArray(schema.labObservations.reportId, reportRows.map((report) => report.id)))
        : Promise.resolve([]),
      historyMessages.length
        ? this.db.select().from(schema.messageAttachments).where(inArray(schema.messageAttachments.messageId, historyMessages.map((message) => message.id)))
        : Promise.resolve([]),
    ]);
    const historyMessageIds = new Set(historyMessages.map((message) => message.id));
    const attachmentsByMessage = new Map<string, Array<{ type: string; caption: string }>>();
    for (const attachment of attachmentRows) {
      if (!historyMessageIds.has(attachment.messageId)) continue;
      const existing = attachmentsByMessage.get(attachment.messageId) ?? [];
      existing.push({ type: attachment.type, caption: attachment.caption });
      attachmentsByMessage.set(attachment.messageId, existing);
    }

    const preferences = preferenceRows[0];
    const brief = briefRows[0];
    const risk = riskRows[0];
    if (!preferences || !brief || !risk || !coachRows[0]) throw new Error(`Member ${memberId} is missing required context rows`);

    const sessionExercises = new Map<string, string[]>();
    for (const exercise of sessionExerciseRows) {
      const existing = sessionExercises.get(exercise.workoutSessionId) ?? [];
      existing.push(exercise.exerciseName);
      sessionExercises.set(exercise.workoutSessionId, existing);
    }

    const labs: MemberContext["labs"] = { blood_panel: {}, dexa_scan: {} };
    for (const report of reportRows) {
      const target = report.reportType === "blood_panel" ? labs.blood_panel : labs.dexa_scan;
      target.date = report.observedAt;
      for (const observation of labObservationRows.filter((row) => row.reportId === report.id)) target[observation.metric] = observation.numericValue;
    }

    const sleep = biometricRows.filter((row) => row.metric === "sleep_hours").map((row) => row.numericValue);
    const weights = biometricRows.filter((row) => row.metric === "weight_kg").map((row) => ({ date: row.observedAt, kg: row.numericValue }));
    const restingHr = biometricRows.find((row) => row.metric === "resting_hr_bpm")?.numericValue;
    const hrv = biometricRows.find((row) => row.metric === "hrv_ms")?.numericValue;
    if (restingHr === undefined || hrv === undefined) throw new Error(`Member ${memberId} is missing current biometric rows`);

    return {
      _note: "Loaded from PostgreSQL canonical member tables.",
      profile: {
        id: profile.id,
        name: profile.name,
        age: profile.age,
        sex: profile.sex,
        height_cm: profile.heightCm,
        weight_kg: profile.weightKg,
        timezone: profile.timezone,
        member_since: profile.memberSince,
        coach_id: profile.coachId,
        tier: profile.tier,
      },
      goals: goals.map((goal) => ({ id: goal.goalId, text: goal.text, priority: goal.priority, target_date: goal.targetDate })),
      preferences: {
        preferred_session_minutes: preferences.preferredSessionMinutes,
        training_days_per_week: preferences.trainingDaysPerWeek,
        preferred_days: preferences.preferredDays,
        dislikes: preferences.dislikes,
        notes: preferences.notes,
      },
      equipment_available: equipmentRows.map((row) => row.equipment),
      injuries: conditionRows.map((condition) => ({
        id: condition.id,
        region: condition.region,
        joint: condition.joint,
        status: condition.status,
        severity: condition.severity,
        since: condition.since,
        notes: condition.notes,
        snomedct_hint: condition.ontologyHint,
        mapped_concept_id: condition.mappedConceptId,
      })),
      workout_history: sessionRows.map((session) => ({
        date: session.sessionDate,
        title: session.title,
        planned: session.planned,
        completed: session.completed,
        duration_min: session.durationMinutes,
        rpe: session.rpe,
        exercises: sessionExercises.get(session.id) ?? [],
      })),
      adherence: {
        weekly_completion_pct: adherenceRows.map((row) => ({ week_of: row.weekOf, pct: row.completionPct })),
        trend: adherenceRows.length > 1 && adherenceRows.at(-1)!.completionPct < adherenceRows[0].completionPct ? "declining" : "stable",
      },
      biomarkers: {
        resting_hr_bpm: restingHr,
        hrv_ms: hrv,
        sleep_hours_last_7_days: sleep,
        weight_trend_kg: weights,
      },
      labs,
      chat_history: historyMessages.map((message) => ({
        ts: message.occurredAt,
        from: message.sender as "member" | "coach",
        text: message.body,
        ...(attachmentsByMessage.has(message.id) ? { attachments: attachmentsByMessage.get(message.id) } : {}),
      })),
      coach_brief: {
        generated_for: brief.generatedFor,
        morning_tasks: brief.morningTasks,
        churn_risk: { level: risk.level, reasons: risk.reasons },
      },
    };
  }
}

export class PostgresPlanRepository implements PlanRepository {
  private readonly pending = new Map<string, { plan: WorkoutPlan; intent: WorkoutIntent }>();

  constructor(private readonly db: Database) {}

  async get(planId: string): Promise<{ plan: WorkoutPlan; intent: WorkoutIntent } | null> {
    const pending = this.pending.get(planId);
    if (pending) return structuredClone(pending);
    const [row] = await this.db.select({ plan: schema.generatedWorkoutPlans.plan, intent: schema.generatedWorkoutPlans.intent })
      .from(schema.generatedWorkoutPlans)
      .where(eq(schema.generatedWorkoutPlans.id, planId))
      .limit(1);
    return row ?? null;
  }

  async save(plan: WorkoutPlan, intent: WorkoutIntent): Promise<void> {
    this.pending.set(plan.id, structuredClone({ plan, intent }));
  }
}

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database) {}

  async getRecent(conversationId: string, memberId: string, limit: number): Promise<ConversationTurn[]> {
    const rows = await this.db.select().from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.memberId, memberId), eq(schema.messages.sender, "copilot_turn")))
      .orderBy(desc(schema.messages.occurredAt))
      .limit(limit);
    return rows.reverse().map((row) => ({
      message: row.body,
      topic: row.topic as ConversationTurn["topic"],
      topics: (row.topics ?? []) as ConversationTurn["topics"],
      headline: row.headline ?? "",
      answer: row.answer ?? "",
    }));
  }

  async append(conversationId: string, memberId: string, turn: ConversationTurn): Promise<void> {
    const [member] = await this.db.select({ organizationId: schema.members.organizationId }).from(schema.members).where(eq(schema.members.id, memberId)).limit(1);
    if (!member) throw new Error(`Member ${memberId} not found`);
    await this.db.insert(schema.conversations).values({ id: conversationId, memberId, organizationId: member.organizationId })
      .onConflictDoUpdate({ target: schema.conversations.id, set: { updatedAt: new Date().toISOString() } });
    await this.db.insert(schema.messages).values({
      id: `turn_${randomUUID()}`,
      conversationId,
      memberId,
      sender: "copilot_turn",
      body: turn.message,
      answer: turn.answer,
      occurredAt: new Date().toISOString(),
      topic: turn.topic,
      topics: turn.topics,
      headline: turn.headline,
    });
  }
}

export class PostgresGraphRepository implements GraphRepository {
  constructor(private readonly db: Database) {}

  async loadActive(): Promise<ActiveDomainGraph | null> {
    const [version] = await this.db.select().from(schema.graphVersions).where(eq(schema.graphVersions.status, "active")).limit(1);
    if (!version) return null;
    const [nodes, edges] = await Promise.all([
      this.db.select().from(schema.graphNodes).where(eq(schema.graphNodes.graphVersionId, version.id)),
      this.db.select().from(schema.graphEdges).where(eq(schema.graphEdges.graphVersionId, version.id)),
    ]);
    const graph = new KnowledgeGraph();
    for (const node of nodes) graph.addNode({
      id: node.nodeId,
      type: node.nodeType as NodeType,
      label: node.label,
      properties: node.properties,
      provenance: node.provenance as Provenance | undefined,
    });
    for (const edge of edges) graph.addEdge({
      id: edge.edgeId,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      type: edge.relationshipType as EdgeType,
      properties: edge.properties,
      provenance: edge.provenance as Provenance | undefined,
    });
    return { versionId: version.id, graph };
  }
}

export class PostgresWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: Database) {}

  async start(input: {
    id: string;
    kind: "workout" | "copilot";
    memberId: string;
    conversationId?: string;
    graphVersionId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(schema.workflowRuns).values({
      id: input.id,
      kind: input.kind,
      memberId: input.memberId,
      conversationId: input.conversationId,
      graphVersionId: input.graphVersionId,
      status: "running",
      input: input.payload,
    });
  }

  async complete(id: string, output: WorkoutResponse | CopilotResponse): Promise<void> {
    await this.db.update(schema.workflowRuns).set({ status: "completed", output, completedAt: new Date().toISOString() }).where(eq(schema.workflowRuns.id, id));
    if (output.modelCalls.length) {
      await this.db.insert(schema.modelCallTraces).values(output.modelCalls.map((trace, position) => ({ workflowRunId: id, position, trace })));
    }
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db.update(schema.workflowRuns).set({ status: "failed", error, completedAt: new Date().toISOString() }).where(eq(schema.workflowRuns.id, id));
  }

  async saveWorkout(input: {
    workflowRunId: string;
    graphVersionId: string;
    response: WorkoutResponse;
    intent: WorkoutIntent;
  }): Promise<void> {
    if (!input.response.plan) return;
    await this.db.insert(schema.generatedWorkoutPlans).values({
      id: input.response.plan.id,
      memberId: input.response.plan.memberId,
      workflowRunId: input.workflowRunId,
      graphVersionId: input.graphVersionId,
      intent: input.intent,
      plan: input.response.plan,
      decisions: input.response.decisions,
      evidence: input.response.evidence,
    });
  }
}

export function createPostgresRepositories(db: Database): RuntimeRepositories {
  return {
    data: new PostgresDataRepository(db),
    plans: new PostgresPlanRepository(db),
    conversations: new PostgresConversationRepository(db),
    graphs: new PostgresGraphRepository(db),
    workflows: new PostgresWorkflowRepository(db),
  };
}

export { labUnits };
