CREATE TABLE "organizations" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "coaches" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "coaches_organization_idx" ON "coaches" ("organization_id");

CREATE TABLE "members" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "coach_id" text NOT NULL REFERENCES "coaches"("id"),
  "name" text NOT NULL,
  "age" integer NOT NULL,
  "sex" text NOT NULL,
  "height_cm" double precision NOT NULL,
  "weight_kg" double precision NOT NULL,
  "timezone" text NOT NULL,
  "member_since" text NOT NULL,
  "tier" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "members_organization_idx" ON "members" ("organization_id");
CREATE INDEX "members_coach_idx" ON "members" ("coach_id");

CREATE TABLE "member_goals" (
  "member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "goal_id" text NOT NULL,
  "text" text NOT NULL,
  "priority" integer NOT NULL,
  "target_date" text,
  PRIMARY KEY ("member_id", "goal_id")
);

CREATE TABLE "member_preferences" (
  "member_id" text PRIMARY KEY REFERENCES "members"("id") ON DELETE CASCADE,
  "preferred_session_minutes" integer NOT NULL,
  "training_days_per_week" integer NOT NULL,
  "preferred_days" jsonb NOT NULL,
  "dislikes" jsonb NOT NULL,
  "notes" text NOT NULL
);

CREATE TABLE "member_equipment" (
  "member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "equipment" text NOT NULL,
  "concept_id" text NOT NULL,
  PRIMARY KEY ("member_id", "concept_id")
);

CREATE TABLE "member_conditions" (
  "id" text PRIMARY KEY,
  "member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "region" text NOT NULL,
  "joint" text NOT NULL,
  "status" text NOT NULL,
  "severity" text NOT NULL,
  "since" text NOT NULL,
  "notes" text NOT NULL,
  "ontology_hint" text NOT NULL,
  "mapped_concept_id" text NOT NULL
);
CREATE INDEX "member_conditions_member_idx" ON "member_conditions" ("member_id");

CREATE TABLE "workout_sessions" (
  "id" text PRIMARY KEY,
  "member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "session_date" text NOT NULL,
  "title" text NOT NULL,
  "planned" boolean NOT NULL,
  "completed" boolean NOT NULL,
  "duration_minutes" integer NOT NULL,
  "rpe" integer
);
CREATE INDEX "workout_sessions_member_date_idx" ON "workout_sessions" ("member_id", "session_date");

CREATE TABLE "workout_session_exercises" (
  "workout_session_id" text NOT NULL REFERENCES "workout_sessions"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "exercise_name" text NOT NULL,
  PRIMARY KEY ("workout_session_id", "position")
);

CREATE TABLE "adherence_observations" (
  "member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "week_of" text NOT NULL,
  "completion_pct" integer NOT NULL,
  PRIMARY KEY ("member_id", "week_of")
);

CREATE TABLE "biometric_observations" (
  "id" text PRIMARY KEY,
  "member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "metric" text NOT NULL,
  "observed_at" text NOT NULL,
  "numeric_value" double precision NOT NULL,
  "unit" text NOT NULL
);
CREATE INDEX "biometric_observations_member_metric_idx" ON "biometric_observations" ("member_id", "metric", "observed_at");

CREATE TABLE "lab_reports" (
  "id" text PRIMARY KEY,
  "member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "report_type" text NOT NULL,
  "observed_at" text NOT NULL
);
CREATE INDEX "lab_reports_member_idx" ON "lab_reports" ("member_id", "observed_at");

CREATE TABLE "lab_observations" (
  "report_id" text NOT NULL REFERENCES "lab_reports"("id") ON DELETE CASCADE,
  "metric" text NOT NULL,
  "numeric_value" double precision NOT NULL,
  "unit" text NOT NULL,
  PRIMARY KEY ("report_id", "metric")
);

CREATE TABLE "conversations" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "conversations_member_idx" ON "conversations" ("member_id", "updated_at");

CREATE TABLE "messages" (
  "id" text PRIMARY KEY,
  "conversation_id" text NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "sender" text NOT NULL,
  "body" text NOT NULL,
  "occurred_at" text NOT NULL,
  "topic" text,
  "topics" jsonb,
  "headline" text,
  "answer" text
);
CREATE INDEX "messages_conversation_idx" ON "messages" ("conversation_id", "occurred_at");

CREATE TABLE "message_attachments" (
  "id" text PRIMARY KEY,
  "message_id" text NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "caption" text NOT NULL
);

CREATE TABLE "coach_briefs" (
  "member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "generated_for" text NOT NULL,
  "morning_tasks" jsonb NOT NULL,
  PRIMARY KEY ("member_id", "generated_for")
);

CREATE TABLE "risk_assessments" (
  "member_id" text NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "assessed_for" text NOT NULL,
  "level" text NOT NULL,
  "reasons" jsonb NOT NULL,
  PRIMARY KEY ("member_id", "assessed_for")
);

CREATE TABLE "exercises" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "properties" jsonb NOT NULL,
  "source_ingestion_id" text
);

CREATE TABLE "ingestion_runs" (
  "id" text PRIMARY KEY,
  "source_name" text NOT NULL,
  "source_hash" text NOT NULL,
  "schema_version" text NOT NULL,
  "raw_payload" jsonb NOT NULL,
  "status" text NOT NULL,
  "errors" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "ingestion_runs_source_hash_unique" UNIQUE ("source_hash")
);

CREATE TABLE "graph_versions" (
  "id" text PRIMARY KEY,
  "ingestion_run_id" text NOT NULL REFERENCES "ingestion_runs"("id"),
  "source_hash" text NOT NULL UNIQUE,
  "status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "activated_at" timestamptz
);
CREATE UNIQUE INDEX "graph_versions_one_active" ON "graph_versions" ((status)) WHERE status = 'active';

CREATE TABLE "graph_nodes" (
  "graph_version_id" text NOT NULL REFERENCES "graph_versions"("id") ON DELETE CASCADE,
  "node_id" text NOT NULL,
  "node_type" text NOT NULL,
  "label" text NOT NULL,
  "properties" jsonb NOT NULL,
  "provenance" jsonb,
  PRIMARY KEY ("graph_version_id", "node_id")
);
CREATE INDEX "graph_nodes_type_idx" ON "graph_nodes" ("graph_version_id", "node_type");

CREATE TABLE "graph_edges" (
  "graph_version_id" text NOT NULL REFERENCES "graph_versions"("id") ON DELETE CASCADE,
  "edge_id" text NOT NULL,
  "source_node_id" text NOT NULL,
  "target_node_id" text NOT NULL,
  "relationship_type" text NOT NULL,
  "properties" jsonb NOT NULL,
  "provenance" jsonb,
  PRIMARY KEY ("graph_version_id", "edge_id"),
  CONSTRAINT "graph_edges_unique_relationship" UNIQUE ("graph_version_id", "source_node_id", "relationship_type", "target_node_id"),
  CONSTRAINT "graph_edges_source_fk" FOREIGN KEY ("graph_version_id", "source_node_id") REFERENCES "graph_nodes"("graph_version_id", "node_id") ON DELETE CASCADE,
  CONSTRAINT "graph_edges_target_fk" FOREIGN KEY ("graph_version_id", "target_node_id") REFERENCES "graph_nodes"("graph_version_id", "node_id") ON DELETE CASCADE
);
CREATE INDEX "graph_edges_outgoing_idx" ON "graph_edges" ("graph_version_id", "source_node_id", "relationship_type");
CREATE INDEX "graph_edges_incoming_idx" ON "graph_edges" ("graph_version_id", "target_node_id", "relationship_type");

CREATE TABLE "workflow_runs" (
  "id" text PRIMARY KEY,
  "kind" text NOT NULL,
  "member_id" text NOT NULL REFERENCES "members"("id"),
  "conversation_id" text,
  "graph_version_id" text NOT NULL REFERENCES "graph_versions"("id"),
  "status" text NOT NULL,
  "input" jsonb NOT NULL,
  "output" jsonb,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
CREATE INDEX "workflow_runs_member_idx" ON "workflow_runs" ("member_id", "created_at");

CREATE TABLE "generated_workout_plans" (
  "id" text PRIMARY KEY,
  "member_id" text NOT NULL REFERENCES "members"("id"),
  "workflow_run_id" text NOT NULL REFERENCES "workflow_runs"("id"),
  "graph_version_id" text NOT NULL REFERENCES "graph_versions"("id"),
  "intent" jsonb NOT NULL,
  "plan" jsonb NOT NULL,
  "decisions" jsonb NOT NULL,
  "evidence" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "model_call_traces" (
  "workflow_run_id" text NOT NULL REFERENCES "workflow_runs"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "trace" jsonb NOT NULL,
  PRIMARY KEY ("workflow_run_id", "position")
);

ALTER TABLE "exercises" ADD CONSTRAINT "exercises_source_ingestion_fk" FOREIGN KEY ("source_ingestion_id") REFERENCES "ingestion_runs"("id");
