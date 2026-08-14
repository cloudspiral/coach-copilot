import fs from "node:fs";
import path from "node:path";
import type { ExerciseRecord } from "../shared/schemas.js";

export interface MemberContext {
  _note: string;
  profile: {
    id: string;
    name: string;
    age: number;
    sex: string;
    height_cm: number;
    weight_kg: number;
    timezone: string;
    member_since: string;
    coach_id: string;
    tier: string;
  };
  goals: Array<{ id: string; text: string; priority: number; target_date: string | null }>;
  preferences: {
    preferred_session_minutes: number;
    training_days_per_week: number;
    preferred_days: string[];
    dislikes: string[];
    notes: string;
  };
  equipment_available: string[];
  injuries: Array<{
    id: string;
    region: string;
    joint: string;
    status: string;
    severity: string;
    since: string;
    notes: string;
    snomedct_hint: string;
    mapped_concept_id?: string;
  }>;
  workout_history: Array<{
    date: string;
    title: string;
    planned: boolean;
    completed: boolean;
    duration_min: number;
    rpe: number | null;
    exercises: string[];
  }>;
  adherence: {
    weekly_completion_pct: Array<{ week_of: string; pct: number }>;
    trend: string;
  };
  biomarkers: {
    resting_hr_bpm: number;
    hrv_ms: number;
    sleep_hours_last_7_days: number[];
    weight_trend_kg: Array<{ date: string; kg: number }>;
  };
  labs: {
    blood_panel: Record<string, string | number>;
    dexa_scan: Record<string, string | number>;
  };
  chat_history: Array<{
    ts: string;
    from: "member" | "coach";
    text: string;
    attachments?: Array<{ type: string; caption: string }>;
  }>;
  coach_brief: {
    generated_for: string;
    morning_tasks: Array<{ type: string; text: string }>;
    churn_risk: { level: string; reasons: string[] };
  };
}

function readJson<T>(relativePath: string): T {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as T;
}

export const exercises = readJson<ExerciseRecord[]>("data/exercises.json");
export const member = readJson<MemberContext>("data/member-context.json");
