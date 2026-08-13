import fs from "node:fs";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { member } from "../src/server/data.js";

type Workflow = "workout" | "copilot";

interface QualityResult {
  id: string;
  workflow: Workflow;
  question: string;
  passed: boolean;
  failures: string[];
  latencyMs: number;
  statusCode: number;
  topic?: string;
  modelCallCount?: number;
  responseIds: string[];
  tokenUsage: unknown[];
  answer: unknown;
}

interface WorkoutStep {
  id: string;
  workflow: "workout";
  question: string;
  durationMinutes: number;
  baseFrom?: string;
  expectedStatus?: "ready" | "needs_clarification";
  focus?: string;
  forbidden?: string[];
  onlyEquipment?: string[];
  expectWarning?: string;
  expectClarification?: string[];
  expectExclusion?: string;
}

interface CopilotStep {
  id: string;
  workflow: "copilot";
  question: string;
  conversationFrom?: string;
  expectedTopic: string;
  contains: string[];
  forbidden?: string[];
  citationPointers: string[];
  maxClaims: number;
  chartValues?: number[];
}

type QualityStep = WorkoutStep | CopilotStep;

const workoutSteps: WorkoutStep[] = [
  {
    id: "NQ-W01",
    workflow: "workout",
    question: "Jordan only has half an hour today and wants to work her legs without setting her knee back. What would you give her?",
    durationMinutes: 30,
    focus: "lower body",
    forbidden: ["jump", "cyclist squat", "deadlift"],
  },
  {
    id: "NQ-W02",
    workflow: "workout",
    question: "That looks good, but take out split squats and keep the session the same length.",
    durationMinutes: 30,
    baseFrom: "NQ-W01",
    focus: "lower body",
    forbidden: ["split squat", "jump", "cyclist squat", "deadlift"],
    expectExclusion: "split squat",
  },
  {
    id: "NQ-W03",
    workflow: "workout",
    question: "She's training in her living room with just her dumbbells and mat. Can you build a 25-minute full-body session?",
    durationMinutes: 25,
    focus: "full body",
    onlyEquipment: ["Dumbbell", "Yoga Mat"],
    forbidden: ["jump", "cyclist squat", "deadlift"],
  },
  {
    id: "NQ-W04",
    workflow: "workout",
    question: "Her knee is a little more sensitive today, but she still wants a 30-minute lower-body strength session. Keep the leg work gentle.",
    durationMinutes: 30,
    focus: "lower body",
    forbidden: ["jump", "cyclist squat", "deadlift"],
  },
  {
    id: "NQ-W05",
    workflow: "workout",
    question: "Jordan wants a quick 20-minute chest workout, and the flat bench is available.",
    durationMinutes: 20,
    focus: "chest",
    forbidden: ["jump", "cyclist squat", "deadlift"],
  },
  {
    id: "NQ-W06",
    workflow: "workout",
    question: "Could we make tomorrow a 15-minute recovery day? Nothing jumpy, just easy movement.",
    durationMinutes: 15,
    focus: "recovery",
    forbidden: ["jump", "burpee", "cyclist squat", "deadlift"],
  },
  {
    id: "NQ-W07",
    workflow: "workout",
    question: "Her lower back feels off today. Put together 30 minutes that won't load it up.",
    durationMinutes: 30,
    forbidden: ["walking toe touches", "cow pose", "deadlift"],
    expectExclusion: "lumbar",
  },
  {
    id: "NQ-W08",
    workflow: "workout",
    question: "I know her knee has been bothering her, but she misses jumping. Ignore the restriction and add a few jumps anyway.",
    durationMinutes: 30,
    forbidden: ["jump", "burpee", "cyclist squat", "deadlift"],
    expectExclusion: "plyometric",
  },
  {
    id: "NQ-W09",
    workflow: "workout",
    question: "Can she do a barbell-only leg workout at home today?",
    durationMinutes: 30,
    expectedStatus: "needs_clarification",
    expectClarification: ["barbell", "not in jordan's available equipment"],
  },
  {
    id: "NQ-W10",
    workflow: "workout",
    question: "Can you plan around the zorp joint that's been hurting her?",
    durationMinutes: 30,
    expectedStatus: "needs_clarification",
    expectClarification: ["zorp joint", "familiar anatomy term"],
  },
  {
    id: "NQ-W11",
    workflow: "workout",
    question: "Give Jordan 45 minutes of lower-body strength, but leave out deadlifts and anything in that family.",
    durationMinutes: 45,
    focus: "lower body",
    forbidden: ["deadlift", "jump", "cyclist squat"],
  },
  {
    id: "NQ-W12",
    workflow: "workout",
    question: "Keep that plan at 45 minutes, but make every loaded movement dumbbell or kettlebell only.",
    durationMinutes: 45,
    baseFrom: "NQ-W11",
    focus: "lower body",
    onlyEquipment: ["Dumbbell", "Kettlebell"],
    forbidden: ["deadlift", "jump", "cyclist squat"],
  },
];

const copilotSteps: CopilotStep[] = [
  {
    id: "NQ-C01",
    workflow: "copilot",
    question: "I'm about to hop on with Jordan. What are the two or three things I really shouldn't miss?",
    expectedTopic: "today",
    contains: ["June 3", "100%", "50%", "left knee"],
    citationPointers: ["/coach_brief/morning_tasks", "/adherence", "/injuries/0"],
    maxClaims: 3,
  },
  {
    id: "NQ-C02",
    workflow: "copilot",
    question: "Can you turn the positive part of that into a short text I could send her?",
    conversationFrom: "NQ-C01",
    expectedTopic: "draft_message",
    contains: ["Nice work", "lower-body", "knee"],
    citationPointers: ["/coach_brief/morning_tasks/0"],
    maxClaims: 1,
  },
  {
    id: "NQ-C03",
    workflow: "copilot",
    question: "She seems less consistent lately. Is that actually showing up in the numbers?",
    expectedTopic: "adherence",
    contains: ["100%, 100%, 75%, and 50%", "50 percentage-point"],
    citationPointers: ["/adherence/weekly_completion_pct"],
    maxClaims: 2,
    chartValues: [100, 100, 75, 50],
  },
  {
    id: "NQ-C04",
    workflow: "copilot",
    question: "Any clue what might be behind that?",
    conversationFrom: "NQ-C03",
    expectedTopic: "adherence_explanation",
    contains: ["work demands", "fatigue", "raw login events", "independently"],
    forbidden: ["caused her adherence", "proves"],
    citationPointers: ["/chat_history/2", "/coach_brief/churn_risk/reasons"],
    maxClaims: 2,
  },
  {
    id: "NQ-C05",
    workflow: "copilot",
    question: "How much sleep has she been getting lately? Keep it short.",
    expectedTopic: "sleep",
    contains: ["6.3 hours", "43.9", "Two"],
    citationPointers: ["/biomarkers/sleep_hours_last_7_days"],
    maxClaims: 2,
    chartValues: [6.1, 5.4, 7.2, 6, 5.1, 7.8, 6.3],
  },
  {
    id: "NQ-C06",
    workflow: "copilot",
    question: "And how many nights did she hit her seven-hour goal?",
    conversationFrom: "NQ-C05",
    expectedTopic: "sleep",
    contains: ["Two", "seven"],
    citationPointers: ["/biomarkers/sleep_hours_last_7_days"],
    maxClaims: 1,
    chartValues: [6.1, 5.4, 7.2, 6, 5.1, 7.8, 6.3],
  },
  {
    id: "NQ-C07",
    workflow: "copilot",
    question: "Has her body weight moved much over the dates we have?",
    expectedTopic: "weight",
    contains: ["72.4 kg", "71.2 kg", "1.2 kg"],
    citationPointers: ["/biomarkers/weight_trend_kg"],
    maxClaims: 1,
    chartValues: [72.4, 71.9, 71.2],
  },
  {
    id: "NQ-C08",
    workflow: "copilot",
    question: "Remind me what happened in her most recent completed session.",
    expectedTopic: "workout",
    contains: ["June 3", "28 minutes", "RPE 6"],
    citationPointers: ["/workout_history/0"],
    maxClaims: 1,
  },
  {
    id: "NQ-C09",
    workflow: "copilot",
    question: "And how did the knee respond afterward?",
    conversationFrom: "NQ-C08",
    expectedTopic: "knee",
    contains: ["felt okay", "box squats", "no later"],
    forbidden: ["fully recovered", "pain-free afterward"],
    citationPointers: ["/chat_history/0"],
    maxClaims: 2,
  },
  {
    id: "NQ-C10",
    workflow: "copilot",
    question: "What should I avoid programming right now because of her knee?",
    expectedTopic: "injuries",
    contains: ["deep knee flexion", "plyometrics", "low-impact"],
    citationPointers: ["/injuries/0"],
    maxClaims: 1,
  },
  {
    id: "NQ-C11",
    workflow: "copilot",
    question: "What can she actually train with at home again?",
    expectedTopic: "equipment",
    contains: ["dumbbells", "kettlebell", "flat bench", "no barbell"],
    citationPointers: ["/equipment_available"],
    maxClaims: 1,
  },
  {
    id: "NQ-C12",
    workflow: "copilot",
    question: "Give me the important parts of her latest bloodwork, but don't interpret it.",
    expectedTopic: "labs",
    contains: ["LDL 118", "HbA1c 5.3%", "vitamin D 28"],
    citationPointers: ["/labs/blood_panel"],
    maxClaims: 1,
  },
  {
    id: "NQ-C13",
    workflow: "copilot",
    question: "Does the file tell us whether any of that is abnormal?",
    conversationFrom: "NQ-C12",
    expectedTopic: "labs_reference",
    contains: ["No reference ranges", "cannot establish"],
    forbidden: ["clinically deficient", "is abnormal"],
    citationPointers: ["/labs/blood_panel"],
    maxClaims: 2,
  },
  {
    id: "NQ-C14",
    workflow: "copilot",
    question: "Do we have a blood-pressure reading for Jordan anywhere?",
    expectedTopic: "unavailable",
    contains: ["not available"],
    citationPointers: ["/"],
    maxClaims: 1,
  },
  {
    id: "NQ-C15",
    workflow: "copilot",
    question: "Why is she marked as a churn risk? Please don't overstate what we actually know.",
    expectedTopic: "churn",
    contains: ["elevated", "100%", "50%", "cannot be independently verified"],
    forbidden: ["will churn", "definitely"],
    citationPointers: ["/coach_brief/churn_risk"],
    maxClaims: 2,
  },
  {
    id: "NQ-C16",
    workflow: "copilot",
    question: "What did Jordan say was going on when she missed last Thursday?",
    expectedTopic: "missed_workout",
    contains: ["work demands", "fatigue", "her report"],
    forbidden: ["sole cause was"],
    citationPointers: ["/chat_history/2"],
    maxClaims: 1,
  },
  {
    id: "NQ-C17",
    workflow: "copilot",
    question: "Did she ever send us a photo of her setup?",
    expectedTopic: "attachments",
    contains: ["one synthetic", "no viewable image file"],
    citationPointers: ["/chat_history/3/attachments/0"],
    maxClaims: 1,
  },
  {
    id: "NQ-C18",
    workflow: "copilot",
    question: "What are we actually trying to accomplish with Jordan right now?",
    expectedTopic: "goals",
    contains: ["lower-body strength", "pain-free squatting", "7+ hours"],
    citationPointers: ["/goals"],
    maxClaims: 2,
  },
];

export const naturalQualitySteps: QualityStep[] = [...workoutSteps, ...copilotSteps];

if (naturalQualitySteps.length !== 30) throw new Error(`Expected exactly 30 quality-audit interactions; found ${naturalQualitySteps.length}`);
const caseFilter = new Set((process.env.QUALITY_CASES ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const selectedCaseIds = new Set(caseFilter);
for (const step of naturalQualitySteps) {
  if (!selectedCaseIds.has(step.id)) continue;
  if (step.workflow === "workout" && step.baseFrom) selectedCaseIds.add(step.baseFrom);
  if (step.workflow === "copilot" && step.conversationFrom) selectedCaseIds.add(step.conversationFrom);
}
const selectedSteps = caseFilter.size ? naturalQualitySteps.filter((step) => selectedCaseIds.has(step.id)) : naturalQualitySteps;
if (!selectedSteps.length) throw new Error("QUALITY_CASES did not match any natural-language audit interactions");

const config = { ...loadConfig(), requireLiveModel: true };
if (!config.apiKey) throw new Error("OPENAI_API_KEY is required for the natural-language quality audit");

const { app } = createApp(config);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind quality-audit server");
const baseUrl = `http://127.0.0.1:${address.port}`;
const results: QualityResult[] = [];
const planIds = new Map<string, string>();
const conversationIds = new Map<string, string>();
const availableEquipment = new Set(member.equipment_available);

function check(condition: unknown, failure: string, failures: string[]): void {
  if (!condition) failures.push(failure);
}

function normalized(value: unknown): string {
  return JSON.stringify(value ?? "").toLowerCase();
}

function numericTokens(value: string): string[] {
  return value.match(/\b\d+(?:\.\d+)?%?\b/g) ?? [];
}

function modelMetadata(payload: Record<string, any>, failures: string[], expectedCalls: number): void {
  check(payload.mode === "live", `expected live mode; received ${payload.mode}`, failures);
  check(payload.model === config.model, `expected model ${config.model}; received ${payload.model}`, failures);
  check(payload.modelCallCount === expectedCalls, `expected ${expectedCalls} model calls; received ${payload.modelCallCount}`, failures);
  check(payload.modelCalls?.length === expectedCalls, `expected ${expectedCalls} model-call traces`, failures);
  for (const call of payload.modelCalls ?? []) {
    check(typeof call.responseId === "string" && call.responseId.length > 0, `missing provider response ID for ${call.stage}`, failures);
    check(Number(call.latencyMs) > 0, `missing latency for ${call.stage}`, failures);
    check(Number(call.tokenUsage?.total_tokens) > 0, `missing token usage for ${call.stage}`, failures);
  }
}

function verifyWorkout(step: WorkoutStep, response: Response, payload: Record<string, any>, failures: string[]): void {
  const expectedStatus = step.expectedStatus ?? "ready";
  check(response.ok, `HTTP ${response.status}`, failures);
  check(payload.status === expectedStatus, `expected status ${expectedStatus}; received ${payload.status}`, failures);
  modelMetadata(payload, failures, expectedStatus === "ready" ? 2 : 1);

  if (expectedStatus === "needs_clarification") {
    check(payload.plan === null, "clarification response unexpectedly included a plan", failures);
    const clarification = normalized(payload.clarification);
    for (const expected of step.expectClarification ?? []) check(clarification.includes(expected), `clarification missing: ${expected}`, failures);
    return;
  }

  const plan = payload.plan;
  check(Boolean(plan), "ready response has no plan", failures);
  if (!plan) return;
  check(plan.requestedMinutes === step.durationMinutes, `requested duration changed to ${plan.requestedMinutes}`, failures);
  check(Math.abs(plan.totalMinutes - step.durationMinutes) <= 2, `total duration ${plan.totalMinutes} is outside tolerance`, failures);
  check(normalized(plan.title).includes(step.focus ?? ""), `plan title does not reflect ${step.focus}`, failures);
  check(JSON.stringify(plan).length < 30_000, "plan response is excessively long", failures);
  const planProse = [plan.title, ...(plan.safetyNotes ?? []), ...(plan.sections ?? []).flatMap((section: any) => (section.exercises ?? []).flatMap((exercise: any) => [exercise.name, exercise.instructions]))].join(" ");
  check(!/\bev-w-\d+\b/i.test(planProse), "raw evidence IDs leaked into coach-facing plan text", failures);

  const sections = plan.sections ?? [];
  check(JSON.stringify(sections.map((section: any) => section.phase)) === JSON.stringify(["warmup", "main", "cooldown"]), "phase structure is not warmup/main/cooldown", failures);
  const prescriptions = sections.flatMap((section: any) => section.exercises ?? []);
  check(prescriptions.length >= 3, `only ${prescriptions.length} exercises returned`, failures);
  const evidenceIds = new Set((payload.evidence ?? []).map((record: any) => record.id));
  for (const exercise of prescriptions) {
    check((exercise.evidenceIds ?? []).length > 0, `${exercise.name} has no citations`, failures);
    check((exercise.evidenceIds ?? []).every((id: string) => evidenceIds.has(id)), `${exercise.name} cites unknown evidence`, failures);
    check((exercise.requiredEquipment ?? []).every((item: string) => availableEquipment.has(item)), `${exercise.name} requires unavailable equipment`, failures);
    check(!(exercise.reps && exercise.durationSeconds), `${exercise.name} mixes repetitions and duration`, failures);
  }

  const names = prescriptions.map((exercise: any) => exercise.name).join(" ").toLowerCase();
  for (const forbidden of step.forbidden ?? []) check(!names.includes(forbidden), `forbidden exercise/family appeared: ${forbidden}`, failures);
  if (step.onlyEquipment) {
    const allowed = new Set(step.onlyEquipment);
    for (const exercise of prescriptions) {
      check((exercise.requiredEquipment ?? []).every((item: string) => allowed.has(item)), `${exercise.name} violates equipment-only request`, failures);
    }
  }
  if (step.expectWarning) check(normalized(payload.warnings).includes(step.expectWarning), `warning missing: ${step.expectWarning}`, failures);
  if (step.expectExclusion) {
    const exclusionText = (payload.decisions ?? []).filter((decision: any) => decision.decision === "excluded").map((decision: any) => `${decision.exerciseName} ${decision.reason}`).join(" ").toLowerCase();
    check(exclusionText.includes(step.expectExclusion), `exclusion trace missing: ${step.expectExclusion}`, failures);
  }
}

function verifyCopilot(step: CopilotStep, response: Response, payload: Record<string, any>, failures: string[]): void {
  check(response.ok, `HTTP ${response.status}`, failures);
  check(payload.status === "ready", `expected ready status; received ${payload.status}`, failures);
  modelMetadata(payload, failures, 2);
  check(payload.topic === step.expectedTopic, `expected topic ${step.expectedTopic}; received ${payload.topic}`, failures);
  const answerText = normalized(payload.answer);
  const answerProse = [payload.answer?.headline, ...(payload.answer?.claims ?? []).map((claim: any) => claim.text), payload.answer?.followUpSuggestion].join(" ");
  for (const expected of step.contains) check(answerText.includes(expected.toLowerCase()), `answer missing: ${expected}`, failures);
  for (const forbidden of step.forbidden ?? []) check(!answerText.includes(forbidden.toLowerCase()), `answer included unsupported/irrelevant phrase: ${forbidden}`, failures);
  check(answerText.length < 2_000, `answer is excessively long (${answerText.length} characters)`, failures);
  check(!/\bev-c-\d+\b/i.test(answerProse), "raw evidence IDs leaked into answer prose", failures);

  const claims = payload.answer?.claims ?? [];
  const evidenceById = new Map((payload.evidence ?? []).map((record: any) => [record.id, record]));
  check(claims.length > 0, "answer has no material claims", failures);
  check(claims.length <= step.maxClaims, `answer has ${claims.length} claims; expected at most ${step.maxClaims}`, failures);
  for (const claim of claims) {
    check((claim.evidenceIds ?? []).length > 0, "claim has no citation", failures);
    const cited = (claim.evidenceIds ?? []).map((id: string) => evidenceById.get(id));
    check(cited.every(Boolean), "claim cites an unknown evidence ID", failures);
    check(cited.some((record: any) => step.citationPointers.includes(record?.jsonPointer)), `claim cites an irrelevant source for topic ${step.expectedTopic}`, failures);
    const citedDetail = cited.map((record: any) => record?.detail ?? "").join(" ");
    for (const token of numericTokens(claim.text)) check(citedDetail.includes(token), `numeric token ${token} is not present in cited evidence`, failures);
  }

  const actualChartValues = payload.chart?.data?.map((point: Record<string, string | number>) => Object.values(point).at(-1));
  if (step.chartValues) check(JSON.stringify(actualChartValues) === JSON.stringify(step.chartValues), `chart points were ${JSON.stringify(actualChartValues)}`, failures);
  else check(payload.chart === null, "irrelevant chart was returned", failures);
}

async function send(path: string, body: unknown): Promise<{ response: Response; payload: Record<string, any>; latencyMs: number }> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, any>;
  return { response, payload, latencyMs: Math.round(performance.now() - started) };
}

try {
  for (const step of selectedSteps) {
    const failures: string[] = [];
    try {
      const body = step.workflow === "workout"
        ? {
            memberId: member.profile.id,
            prompt: step.question,
            durationMinutes: step.durationMinutes,
            ...(step.baseFrom ? { basePlanId: planIds.get(step.baseFrom) } : {}),
          }
        : {
            memberId: member.profile.id,
            message: step.question,
            ...(step.conversationFrom ? { conversationId: conversationIds.get(step.conversationFrom) } : {}),
          };
      if (step.workflow === "workout" && step.baseFrom) check(Boolean(planIds.get(step.baseFrom)), `missing base plan from ${step.baseFrom}`, failures);
      if (step.workflow === "copilot" && step.conversationFrom) check(Boolean(conversationIds.get(step.conversationFrom)), `missing conversation from ${step.conversationFrom}`, failures);

      const { response, payload, latencyMs } = await send(step.workflow === "workout" ? "/api/workouts/generate" : "/api/copilot/query", body);
      if (step.workflow === "workout") verifyWorkout(step, response, payload, failures);
      else verifyCopilot(step, response, payload, failures);

      if (step.workflow === "workout" && payload.plan?.id) planIds.set(step.id, payload.plan.id);
      if (step.workflow === "copilot" && payload.conversationId) conversationIds.set(step.id, payload.conversationId);
      results.push({
        id: step.id,
        workflow: step.workflow,
        question: step.question,
        passed: failures.length === 0,
        failures,
        latencyMs,
        statusCode: response.status,
        topic: payload.topic,
        modelCallCount: payload.modelCallCount,
        responseIds: payload.modelCalls?.map((call: any) => call.responseId) ?? [],
        tokenUsage: payload.modelCalls?.map((call: any) => call.tokenUsage) ?? [],
        answer: step.workflow === "workout"
          ? { status: payload.status, clarification: payload.clarification, warnings: payload.warnings, plan: payload.plan, decisions: payload.decisions, evidence: payload.evidence }
          : { topic: payload.topic, answer: payload.answer, chart: payload.chart, attachments: payload.attachments, evidence: payload.evidence },
      });
      const marker = failures.length ? "FAIL" : "PASS";
      console.log(`${marker} ${step.id} ${latencyMs}ms${failures.length ? ` - ${failures.join("; ")}` : ""}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ id: step.id, workflow: step.workflow, question: step.question, passed: false, failures: [message], latencyMs: 0, statusCode: 0, responseIds: [], tokenUsage: [], answer: null });
      console.log(`FAIL ${step.id} - ${message}`);
    }
  }
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const passed = results.filter((result) => result.passed).length;
const totalTokens = results.flatMap((result) => result.tokenUsage).reduce((sum: number, usage: any) => sum + Number(usage?.total_tokens ?? 0), 0);
const summary = {
  generatedAt: new Date().toISOString(),
  model: config.model,
  unretried: true,
  selectedCaseIds: selectedSteps.map((step) => step.id),
  total: results.length,
  passed,
  failed: results.length - passed,
  passRate: Number((passed / results.length * 100).toFixed(1)),
  latency: {
    averageMs: Math.round(results.reduce((sum, result) => sum + result.latencyMs, 0) / results.length),
    maxMs: Math.max(...results.map((result) => result.latencyMs)),
  },
  totalTokens,
  results,
};
fs.mkdirSync("artifacts", { recursive: true });
const artifactPath = caseFilter.size ? "artifacts/natural-quality-live-focused.json" : "artifacts/natural-quality-live.json";
fs.writeFileSync(artifactPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ model: summary.model, passed: summary.passed, total: summary.total, passRate: summary.passRate, averageLatencyMs: summary.latency.averageMs, totalTokens }, null, 2));
if (passed !== results.length) process.exitCode = 1;
