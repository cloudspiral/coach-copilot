import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  CopilotResponse,
} from "../copilot.js";
import type { MemberContext } from "../data.js";
import type { WorkoutResponse } from "../workout.js";
import type {
  CopilotIntent,
  DecisionTrace,
  EvidenceRecord,
  GraphEdge,
  GraphNode,
  ModelCallTrace,
  WorkoutIntent,
  WorkoutPlan,
} from "../../shared/schemas.js";

const createdAt = timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt,
});

export const coaches = pgTable("coaches", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  createdAt,
}, (table) => [index("coaches_organization_idx").on(table.organizationId)]);

export const members = pgTable("members", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  coachId: text("coach_id").notNull().references(() => coaches.id),
  name: text("name").notNull(),
  age: integer("age").notNull(),
  sex: text("sex").notNull(),
  heightCm: doublePrecision("height_cm").notNull(),
  weightKg: doublePrecision("weight_kg").notNull(),
  timezone: text("timezone").notNull(),
  memberSince: text("member_since").notNull(),
  tier: text("tier").notNull(),
  createdAt,
}, (table) => [
  index("members_organization_idx").on(table.organizationId),
  index("members_coach_idx").on(table.coachId),
]);

export const memberGoals = pgTable("member_goals", {
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  goalId: text("goal_id").notNull(),
  text: text("text").notNull(),
  priority: integer("priority").notNull(),
  targetDate: text("target_date"),
}, (table) => [primaryKey({ columns: [table.memberId, table.goalId] })]);

export const memberPreferences = pgTable("member_preferences", {
  memberId: text("member_id").primaryKey().references(() => members.id, { onDelete: "cascade" }),
  preferredSessionMinutes: integer("preferred_session_minutes").notNull(),
  trainingDaysPerWeek: integer("training_days_per_week").notNull(),
  preferredDays: jsonb("preferred_days").$type<string[]>().notNull(),
  dislikes: jsonb("dislikes").$type<string[]>().notNull(),
  notes: text("notes").notNull(),
});

export const memberEquipment = pgTable("member_equipment", {
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  equipment: text("equipment").notNull(),
  conceptId: text("concept_id").notNull(),
}, (table) => [primaryKey({ columns: [table.memberId, table.conceptId] })]);

export const memberConditions = pgTable("member_conditions", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  region: text("region").notNull(),
  joint: text("joint").notNull(),
  status: text("status").notNull(),
  severity: text("severity").notNull(),
  since: text("since").notNull(),
  notes: text("notes").notNull(),
  ontologyHint: text("ontology_hint").notNull(),
  mappedConceptId: text("mapped_concept_id").notNull(),
}, (table) => [index("member_conditions_member_idx").on(table.memberId)]);

export const workoutSessions = pgTable("workout_sessions", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  sessionDate: text("session_date").notNull(),
  title: text("title").notNull(),
  planned: boolean("planned").notNull(),
  completed: boolean("completed").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  rpe: integer("rpe"),
}, (table) => [index("workout_sessions_member_date_idx").on(table.memberId, table.sessionDate)]);

export const workoutSessionExercises = pgTable("workout_session_exercises", {
  workoutSessionId: text("workout_session_id").notNull().references(() => workoutSessions.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  exerciseName: text("exercise_name").notNull(),
}, (table) => [primaryKey({ columns: [table.workoutSessionId, table.position] })]);

export const adherenceObservations = pgTable("adherence_observations", {
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  weekOf: text("week_of").notNull(),
  completionPct: integer("completion_pct").notNull(),
}, (table) => [primaryKey({ columns: [table.memberId, table.weekOf] })]);

export const biometricObservations = pgTable("biometric_observations", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  metric: text("metric").notNull(),
  observedAt: text("observed_at").notNull(),
  numericValue: doublePrecision("numeric_value").notNull(),
  unit: text("unit").notNull(),
}, (table) => [index("biometric_observations_member_metric_idx").on(table.memberId, table.metric, table.observedAt)]);

export const labReports = pgTable("lab_reports", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  reportType: text("report_type").notNull(),
  observedAt: text("observed_at").notNull(),
}, (table) => [index("lab_reports_member_idx").on(table.memberId, table.observedAt)]);

export const labObservations = pgTable("lab_observations", {
  reportId: text("report_id").notNull().references(() => labReports.id, { onDelete: "cascade" }),
  metric: text("metric").notNull(),
  numericValue: doublePrecision("numeric_value").notNull(),
  unit: text("unit").notNull(),
}, (table) => [primaryKey({ columns: [table.reportId, table.metric] })]);

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [index("conversations_member_idx").on(table.memberId, table.updatedAt)]);

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  sender: text("sender").notNull(),
  body: text("body").notNull(),
  occurredAt: text("occurred_at").notNull(),
  topic: text("topic"),
  topics: jsonb("topics").$type<string[]>(),
  headline: text("headline"),
  answer: text("answer"),
}, (table) => [index("messages_conversation_idx").on(table.conversationId, table.occurredAt)]);

export const messageAttachments = pgTable("message_attachments", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  caption: text("caption").notNull(),
});

export const coachBriefs = pgTable("coach_briefs", {
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  generatedFor: text("generated_for").notNull(),
  morningTasks: jsonb("morning_tasks").$type<MemberContext["coach_brief"]["morning_tasks"]>().notNull(),
}, (table) => [primaryKey({ columns: [table.memberId, table.generatedFor] })]);

export const riskAssessments = pgTable("risk_assessments", {
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  assessedFor: text("assessed_for").notNull(),
  level: text("level").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull(),
}, (table) => [primaryKey({ columns: [table.memberId, table.assessedFor] })]);

export const exercises = pgTable("exercises", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  properties: jsonb("properties").$type<Record<string, unknown>>().notNull(),
  sourceIngestionId: text("source_ingestion_id"),
});

export const ingestionRuns = pgTable("ingestion_runs", {
  id: text("id").primaryKey(),
  sourceName: text("source_name").notNull(),
  sourceHash: text("source_hash").notNull(),
  schemaVersion: text("schema_version").notNull(),
  rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull(),
  errors: jsonb("errors").$type<string[]>().notNull(),
  createdAt,
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
}, (table) => [uniqueIndex("ingestion_runs_source_hash_unique").on(table.sourceHash)]);

export const graphVersions = pgTable("graph_versions", {
  id: text("id").primaryKey(),
  ingestionRunId: text("ingestion_run_id").notNull().references(() => ingestionRuns.id),
  sourceHash: text("source_hash").notNull().unique(),
  status: text("status").notNull(),
  createdAt,
  activatedAt: timestamp("activated_at", { withTimezone: true, mode: "string" }),
}, (table) => [uniqueIndex("graph_versions_one_active").on(table.status).where(sql`${table.status} = 'active'`)]);

export const graphNodes = pgTable("graph_nodes", {
  graphVersionId: text("graph_version_id").notNull().references(() => graphVersions.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  nodeType: text("node_type").notNull(),
  label: text("label").notNull(),
  properties: jsonb("properties").$type<GraphNode["properties"]>().notNull(),
  provenance: jsonb("provenance").$type<GraphNode["provenance"]>(),
}, (table) => [
  primaryKey({ columns: [table.graphVersionId, table.nodeId] }),
  index("graph_nodes_type_idx").on(table.graphVersionId, table.nodeType),
]);

export const graphEdges = pgTable("graph_edges", {
  graphVersionId: text("graph_version_id").notNull().references(() => graphVersions.id, { onDelete: "cascade" }),
  edgeId: text("edge_id").notNull(),
  sourceNodeId: text("source_node_id").notNull(),
  targetNodeId: text("target_node_id").notNull(),
  relationshipType: text("relationship_type").notNull(),
  properties: jsonb("properties").$type<GraphEdge["properties"]>().notNull(),
  provenance: jsonb("provenance").$type<GraphEdge["provenance"]>(),
}, (table) => [
  primaryKey({ columns: [table.graphVersionId, table.edgeId] }),
  uniqueIndex("graph_edges_unique_relationship").on(table.graphVersionId, table.sourceNodeId, table.relationshipType, table.targetNodeId),
  index("graph_edges_outgoing_idx").on(table.graphVersionId, table.sourceNodeId, table.relationshipType),
  index("graph_edges_incoming_idx").on(table.graphVersionId, table.targetNodeId, table.relationshipType),
  foreignKey({
    columns: [table.graphVersionId, table.sourceNodeId],
    foreignColumns: [graphNodes.graphVersionId, graphNodes.nodeId],
    name: "graph_edges_source_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.graphVersionId, table.targetNodeId],
    foreignColumns: [graphNodes.graphVersionId, graphNodes.nodeId],
    name: "graph_edges_target_fk",
  }).onDelete("cascade"),
]);

export const workflowRuns = pgTable("workflow_runs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  memberId: text("member_id").notNull().references(() => members.id),
  conversationId: text("conversation_id"),
  graphVersionId: text("graph_version_id").notNull().references(() => graphVersions.id),
  status: text("status").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  output: jsonb("output").$type<WorkoutResponse | CopilotResponse>(),
  error: text("error"),
  createdAt,
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
}, (table) => [index("workflow_runs_member_idx").on(table.memberId, table.createdAt)]);

export const generatedWorkoutPlans = pgTable("generated_workout_plans", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id),
  workflowRunId: text("workflow_run_id").notNull().references(() => workflowRuns.id),
  graphVersionId: text("graph_version_id").notNull().references(() => graphVersions.id),
  intent: jsonb("intent").$type<WorkoutIntent>().notNull(),
  plan: jsonb("plan").$type<WorkoutPlan>().notNull(),
  decisions: jsonb("decisions").$type<DecisionTrace[]>().notNull(),
  evidence: jsonb("evidence").$type<EvidenceRecord[]>().notNull(),
  createdAt,
});

export const modelCallTraces = pgTable("model_call_traces", {
  workflowRunId: text("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  trace: jsonb("trace").$type<ModelCallTrace>().notNull(),
}, (table) => [primaryKey({ columns: [table.workflowRunId, table.position] })]);

export type StoredPlan = {
  plan: WorkoutPlan;
  intent: WorkoutIntent;
};

export type StoredConversationTurn = {
  message: string;
  topic: CopilotIntent["topic"];
  topics: CopilotIntent["relatedTopics"];
  headline: string;
  answer: string;
};
