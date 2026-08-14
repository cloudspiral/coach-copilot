import { z } from "zod";

export const focusValues = [
  "full_body",
  "lower_body",
  "upper_body",
  "upper_push",
  "upper_pull",
  "chest",
  "core",
  "recovery",
] as const;

export const WorkoutRequestSchema = z.object({
  memberId: z.string().min(1),
  prompt: z.string().min(3).max(1_000),
  durationMinutes: z.number().int().min(15).max(90),
  basePlanId: z.string().min(1).nullable().optional(),
});

export const WorkoutIntentSchema = z.object({
  focus: z.enum(focusValues),
  durationMinutes: z.number().int().min(15).max(90),
  requestedEquipment: z.array(z.string()),
  equipmentMode: z.enum(["available", "only"]),
  excludedTerms: z.array(z.string()),
  safetyTerms: z.array(z.string()),
  noImpact: z.boolean(),
  recovery: z.boolean(),
  unresolvedTerms: z.array(z.string()),
});

export const WorkoutNarrativeSchema = z.object({
  summary: z.string(),
  safetySummary: z.string(),
  exerciseNotes: z.array(
    z.object({
      exerciseId: z.string(),
      note: z.string(),
      evidenceIds: z.array(z.string()),
    }),
  ),
});

export const copilotTopics = [
  "brief",
  "today",
  "adherence",
  "adherence_explanation",
  "sleep",
  "weight",
  "biomarkers",
  "labs",
  "labs_reference",
  "dexa",
  "changes",
  "churn",
  "workout",
  "workout_concerns",
  "knee",
  "injuries",
  "equipment",
  "goals",
  "missed_workout",
  "chat",
  "attachments",
  "draft_message",
  "message_pattern",
  "unavailable",
] as const;

export const CopilotRequestSchema = z.object({
  memberId: z.string().min(1),
  message: z.string().min(2).max(1_000),
  conversationId: z.string().min(1).nullable().optional(),
});

export const CopilotIntentSchema = z.object({
  topic: z.enum(copilotTopics),
  relatedTopics: z.array(z.enum(copilotTopics)).max(3),
  timeHorizon: z.string().nullable(),
  requestedChart: z.boolean(),
  entities: z.array(z.string()),
  unresolvedTerms: z.array(z.string()),
});

export const CopilotAnswerSchema = z.object({
  headline: z.string(),
  narrative: z.array(
    z.object({
      text: z.string(),
      evidenceIds: z.array(z.string()),
    }),
  ),
  followUpSuggestion: z.string(),
});

export type WorkoutRequest = z.infer<typeof WorkoutRequestSchema>;
export type WorkoutIntent = z.infer<typeof WorkoutIntentSchema>;
export type WorkoutNarrative = z.infer<typeof WorkoutNarrativeSchema>;
export type CopilotRequest = z.infer<typeof CopilotRequestSchema>;
export type CopilotIntent = z.infer<typeof CopilotIntentSchema>;
export type CopilotAnswer = z.infer<typeof CopilotAnswerSchema>;
export type CopilotTopic = (typeof copilotTopics)[number];

export type NodeType =
  | "Exercise"
  | "Anatomy"
  | "Equipment"
  | "MovementPattern"
  | "InjuryOrCondition"
  | "Member"
  | "MemberFact";

export type EdgeType =
  | "targets"
  | "stresses"
  | "requires"
  | "uses_movement_pattern"
  | "part_of"
  | "affects"
  | "has_condition"
  | "has_fact"
  | "references"
  | "exact_match"
  | "alias_of"
  | "close_match";

export interface Provenance {
  source: string;
  jsonPointer?: string;
  timestamp?: string;
  ontologyUri?: string;
  derivationRule?: string;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  properties: Record<string, unknown>;
  provenance?: Provenance;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  properties: Record<string, unknown>;
  provenance?: Provenance;
}

export interface ExerciseRecord {
  id: string;
  name: string;
  muscle_groups: string[];
  joints_loaded: string[];
  movement_patterns: string[];
  equipment_required: string[];
  is_bilateral: boolean;
  side: string | null;
  priority_tier: number;
  is_reps: boolean;
  is_duration: boolean;
  supports_weight: boolean;
  estimated_rep_duration: number;
  bilateral_pair_id: string | null;
}

export interface EvidenceRecord {
  id: string;
  kind: "request" | "member_fact" | "domain_edge" | "safety_rule" | "ontology_mapping" | "derived";
  title: string;
  detail: string;
  sourceLabel: string;
  jsonPointer?: string;
  timestamp?: string;
  graphPath?: string[];
  ruleId?: string;
}

export interface ExercisePrescription {
  exerciseId: string;
  name: string;
  phase: "warmup" | "main" | "cooldown";
  sets: number;
  reps: string | null;
  durationSeconds: number | null;
  restSeconds: number;
  estimatedMinutes: number;
  instructions: string;
  requiredEquipment: string[];
  evidenceIds: string[];
  riskLevel: "low" | "modified";
}

export interface WorkoutSection {
  phase: "warmup" | "main" | "cooldown";
  title: string;
  minutes: number;
  exercises: ExercisePrescription[];
}

export interface WorkoutPlan {
  id: string;
  memberId: string;
  title: string;
  requestedMinutes: number;
  totalMinutes: number;
  sections: WorkoutSection[];
  safetyNotes: string[];
}

export interface DecisionTrace {
  exerciseId: string;
  exerciseName: string;
  decision: "included" | "excluded";
  score: number;
  reason: string;
  evidenceIds: string[];
}

export interface ModelCallTrace {
  stage: string;
  responseId: string;
  latencyMs: number;
  tokenUsage: Record<string, unknown>;
}

export interface ChartSpec {
  type: "line" | "bar";
  title: string;
  xLabel: string;
  yLabel: string;
  series: Array<{ name: string; color: string }>;
  data: Array<Record<string, string | number>>;
}

export interface GroundedClaim {
  text: string;
  evidenceIds: string[];
}
