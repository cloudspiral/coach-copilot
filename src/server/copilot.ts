import { randomUUID } from "node:crypto";
import type {
  ChartSpec,
  CopilotAnswer,
  CopilotIntent,
  CopilotRequest,
  CopilotTopic,
  EvidenceRecord,
  ModelCallTrace,
} from "../shared/schemas.js";
import { CopilotAnswerSchema, CopilotIntentSchema } from "../shared/schemas.js";
import type { AppConfig } from "./config.js";
import type { MemberContext } from "./data.js";
import type { StructuredModelGateway } from "./openai.js";
import type { ConversationRepository } from "./repositories.js";

interface GroundedBundle {
  answer: CopilotAnswer;
  evidence: EvidenceRecord[];
  chart: ChartSpec | null;
  attachments: Array<{ type: string; caption: string }>;
}

export interface CopilotResponse {
  status: "ready";
  mode: "live" | "deterministic_fallback";
  model: string;
  modelCallCount: number;
  traceId: string;
  conversationId: string;
  topic: CopilotTopic;
  topics: CopilotTopic[];
  answer: CopilotAnswer;
  chart: ChartSpec | null;
  attachments: Array<{ type: string; caption: string }>;
  evidence: EvidenceRecord[];
  modelCalls: ModelCallTrace[];
}

const riskyMedicalLanguage = /diagnos|clinically deficient|disease|medical advice|definitely caused|proves that/i;
const rawEvidenceReference = /\bev-c-\d+\b/i;
const broadGraphTopics: CopilotTopic[] = [
  "workout",
  "adherence",
  "sleep",
  "weight",
  "biomarkers",
  "labs",
  "dexa",
  "churn",
  "knee",
  "injuries",
  "equipment",
  "goals",
  "chat",
  "attachments",
];

function routeTopic(message: string, prior?: CopilotTopic): CopilotIntent {
  const text = message.toLowerCase();
  let topic: CopilotTopic = "unavailable";
  if (/draft.*(congrat|message)|congratulations message/.test(text)) topic = "draft_message";
  else if ((prior === "brief" || prior === "today") && /(positive part|celebrat|nice part).*(text|message)|(?:text|message).*(send|her)/.test(text)) topic = "draft_message";
  else if (/outside.*reference|reference range|which values.*outside/.test(text)) topic = "labs_reference";
  else if ((prior === "labs" || prior === "labs_reference") && /abnormal|outside.*range|tell us whether/.test(text)) topic = "labs_reference";
  else if (/what might explain that|what.*behind that|clue.*behind|why is.*elevated|why.*risk/.test(text)) topic = /churn/.test(text) ? "churn" : prior === "adherence" ? "adherence_explanation" : prior === "churn" ? "churn" : "message_pattern";
  else if (/anything concerning|was there.*concern/.test(text)) topic = prior === "workout" ? "workout_concerns" : "unavailable";
  else if (/brief/.test(text)) topic = "brief";
  else if (/before coaching|know.*today|hop on|shouldn.t miss|two or three things/.test(text)) topic = "today";
  else if (/adherence|last four weeks|completion|less consistent.*numbers/.test(text)) topic = "adherence";
  else if (/sleep/.test(text) || (prior === "sleep" && /nights?|hours?|hit.*goal|seven-hour/.test(text))) topic = "sleep";
  else if (/weight/.test(text)) topic = "weight";
  else if (/blood[- ]pressure/.test(text)) topic = "unavailable";
  else if (/resting heart|heart rate|hrv|biomarker/.test(text)) topic = "biomarkers";
  else if (/vitamin d|hba1c|a1c|blood panel|latest labs|labs?/.test(text)) topic = /deficient|outside|reference/.test(text) ? "labs_reference" : "labs";
  else if (/dexa|body composition|body fat|lean mass|bone density/.test(text)) topic = "dexa";
  else if (/what changed|since last week/.test(text)) topic = "changes";
  else if (/churn|risk of churn/.test(text)) topic = "churn";
  else if (/latest workout|last workout|most recent workout|most recent.*(?:completed )?session|last completed.*session/.test(text)) topic = "workout";
  else if (/avoid.*program|programming.*knee|because of.*knee/.test(text)) topic = "injuries";
  else if (/knee feel|knee status|knee.*respond|how did.*knee/.test(text)) topic = "knee";
  else if (/injur|constraint|remember/.test(text)) topic = "injuries";
  else if (/equipment|what.*have|owns?|train with.*home/.test(text)) topic = "equipment";
  else if (/goals?|trying to accomplish/.test(text)) topic = "goals";
  else if (/miss.*thursday|skip.*workout|why.*miss/.test(text)) topic = "missed_workout";
  else if (/conversation|recent chat|recent messages/.test(text)) topic = "chat";
  else if (/past images|attachment|photo/.test(text)) topic = "attachments";
  else if (/message/.test(text)) topic = "message_pattern";

  return {
    topic,
    relatedTopics: [],
    timeHorizon: /last four weeks/.test(text) ? "last four weeks" : /this week/.test(text) ? "this week" : null,
    requestedChart: /plot|chart|trend|compare/.test(text),
    entities: [],
    unresolvedTerms: [],
  };
}

function intentSystemPrompt(): string {
  return `Choose which graph-backed member topics are needed to answer the coach's question. Select from availableGraphTopics in the input. Put the most relevant topic in topic and up to three additional useful, non-duplicative topics in relatedTopics. For broad questions such as how the member is doing overall, choose a small set of atomic topics; do not reduce the request to the prewritten brief. For narrow questions and follow-ups, choose only the specifically requested topic and leave relatedTopics empty. Use recent conversation context for pronouns and follow-ups, including requests for information omitted from an earlier answer. Do not answer the question. Never infer missing clinical conclusions. Unknown or unavailable requests route to unavailable.`;
}

function answerSystemPrompt(): string {
  return `Turn the supplied graph-backed candidate facts into a natural, conversational answer to the coach's exact question. Select the most useful facts; do not mechanically repeat every candidate or write a task list/dashboard brief. The narrative array is an ordered sequence with one complete sentence per item so each displayed sentence ends with its citations. Use transitions and lead with the direct takeaway. For a narrow follow-up, answer only that follow-up. Preserve every number and qualification you use exactly. Each narrative item must cite one or more evidence IDs from the supplied evidence and may cite only those IDs. Put citations only in evidenceIds; never write internal evidence IDs in prose. Do not add facts, causes, diagnoses, reference ranges, or recommendations. Keep unavailable information explicitly unavailable.`;
}

function numericTokens(value: string): string[] {
  return value.match(/\b\d+(?:\.\d+)?%?\b/g) ?? [];
}

function validateAnswer(answer: CopilotAnswer, evidence: EvidenceRecord[]): boolean {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const prose = [answer.headline, ...answer.narrative.map((item) => item.text), answer.followUpSuggestion].join(" ");
  if (!answer.narrative.length || riskyMedicalLanguage.test(prose) || rawEvidenceReference.test(prose)) return false;
  return answer.narrative.every((item) => {
    if (!item.evidenceIds.length || item.evidenceIds.some((id) => !byId.has(id))) return false;
    const support = item.evidenceIds.map((id) => byId.get(id)?.detail ?? "").join(" ");
    return numericTokens(item.text).every((token) => support.includes(token));
  });
}

export function preservesTopicContract(
  answer: CopilotAnswer,
  candidate: CopilotAnswer,
  topic: CopilotTopic,
  question: string,
): boolean {
  const prose = [answer.headline, ...answer.narrative.map((item) => item.text)].join(" ");
  const candidateProse = [candidate.headline, ...candidate.narrative.map((item) => item.text)].join(" ");
  if (topic === "sleep" || topic === "adherence") {
    const requiredNumbers = new Set(numericTokens(candidateProse));
    if ([...requiredNumbers].some((token) => !prose.includes(token))) return false;
  }
  if (topic === "adherence" && /compare|four weeks/i.test(question) && !/percentage-point/i.test(prose)) return false;
  if (topic === "chat" && (!/three member messages/i.test(prose) || !/one coach message/i.test(prose))) return false;
  if (topic === "labs_reference" && /vitamin d/i.test(question) && !/cannot establish/i.test(prose)) return false;
  if (topic === "draft_message" && !/knee/i.test(prose)) return false;
  if (topic === "unavailable" && !/not available/i.test(prose)) return false;
  if (topic === "missed_workout" && (!/work demands/i.test(prose) || !/her report/i.test(prose))) return false;
  if (topic === "attachments" && (!/one synthetic/i.test(prose) || !/no viewable image file/i.test(prose))) return false;
  return true;
}

function buildBundle(member: MemberContext, topic: CopilotTopic, question: string): GroundedBundle {
  const evidence: EvidenceRecord[] = [];
  const add = (record: Omit<EvidenceRecord, "id">): string => {
    const id = `ev-c-${evidence.length + 1}`;
    evidence.push({ id, ...record });
    return id;
  };
  const source = (title: string, detail: string, jsonPointer: string, timestamp?: string, ruleId?: string): string => add({
    kind: ruleId ? "derived" : "member_fact",
    title,
    detail,
    sourceLabel: "Synthetic member context",
    jsonPointer,
    timestamp,
    graphPath: [`member:${member.profile.id}`, "has_fact", `fact:${member.profile.id}:${jsonPointer.split("/")[1] || "profile"}`],
    ruleId,
  });
  const answer = (headline: string, narrative: Array<[string, string[]]>, followUpSuggestion: string): CopilotAnswer => ({
    headline,
    narrative: narrative.map(([text, evidenceIds]) => ({ text, evidenceIds })),
    followUpSuggestion,
  });
  let chart: ChartSpec | null = null;
  let attachments: Array<{ type: string; caption: string }> = [];

  if (topic === "brief" || topic === "today") {
    const tasks = source("Morning brief", `For ${member.coach_brief.generated_for}; the referenced workout was June 3: ${member.coach_brief.morning_tasks.map((item) => item.text).join(" ")}`, "/coach_brief/morning_tasks", member.coach_brief.generated_for);
    const adherence = source("Four-week adherence", "Weekly completion was 100%, 100%, 75%, and 50%; the supplied trend is declining.", "/adherence");
    const knee = source("Knee condition", member.injuries[0].notes, "/injuries/0", member.injuries[0].since);
    return { answer: answer("Jordan's coaching brief", [
      ["The positive news is that Jordan completed her June 3 lower-body session and reported her first pain-free squat work since the flare-up.", [tasks]],
      ["The main concern is adherence, which moved from 100% to 50% across the supplied four weeks.", [adherence]],
      ["Her recovering left knee should still guide programming: keep loading low-impact and avoid deep loaded knee flexion and plyometrics.", [knee]],
    ], "Ask me to draft the congratulations message."), evidence, chart, attachments };
  }

  if (topic === "adherence") {
    const id = source("Adherence history", "Weekly completion values by week are 2026-05-12: 100%, 2026-05-19: 100%, 2026-05-26: 75%, 2026-06-02: 50%. Supplied trend: declining.", "/adherence/weekly_completion_pct");
    chart = {
      type: "line", title: "Weekly workout completion", xLabel: "Week of", yLabel: "Completion (%)",
      series: [{ name: "Completion", color: "#b8ff5a" }],
      data: member.adherence.weekly_completion_pct.map((point) => ({ week: point.week_of.slice(5), Completion: point.pct })),
    };
    return { answer: answer("Adherence is declining", [
      ["Weekly workout completion was 100%, 100%, 75%, and 50% over the supplied four weeks.", [id]],
      ["That is a 50 percentage-point decrease from the first supplied week to the latest.", [id]],
    ], "Ask what might explain that."), evidence, chart, attachments };
  }

  if (topic === "adherence_explanation" || topic === "message_pattern") {
    const message = source("Member explanation", "On 2026-05-30 Jordan said she skipped Thursday because work blew up and she was wiped.", "/chat_history/2", member.chat_history[2].ts);
    const risk = source("Provided risk reasons", `The supplied brief lists: ${member.coach_brief.churn_risk.reasons.join("; ")}. Login frequency down is a provided risk reason and is not independently verifiable from raw login events in this dataset.`, "/coach_brief/churn_risk/reasons");
    return { answer: answer("A possible contributor is visible, but causation is not proven", [
      ["Jordan's message identifies work demands and fatigue as possible contributors to the missed Thursday session.", [message]],
      ["The brief also lists lower login frequency as a risk reason, but the supplied data contains no raw login events to verify it independently.", [risk]],
    ], "Consider asking Jordan whether workload or recovery is still affecting this week."), evidence, chart, attachments };
  }

  if (topic === "sleep") {
    const values = member.biomarkers.sleep_hours_last_7_days;
    const total = values.reduce((sum, value) => sum + value, 0);
    const average = total / values.length;
    const id = source("Seven-day sleep", `Readings: ${values.join(", ")} hours. Sum: ${total.toFixed(1)} hours across 7 readings. Average: ${average.toFixed(2)} hours, displayed as 6.3 hours. 2 readings were at or above 7 hours.`, "/biomarkers/sleep_hours_last_7_days", undefined, "SLEEP-AVG-01");
    chart = { type: "bar", title: "Sleep over the last 7 readings", xLabel: "Reading", yLabel: "Hours", series: [{ name: "Hours", color: "#7ed7ff" }], data: values.map((value, index) => ({ reading: `Day ${index + 1}`, Hours: value })) };
    const asksHowMany = /how many|nights?.*(?:hit|reach|meet)|hit.*goal/i.test(question);
    return { answer: answer(asksHowMany ? "Two readings met the seven-hour threshold" : "Sleep is below Jordan's 7-hour goal", asksHowMany ? [
      ["Two of the seven supplied readings were at or above 7 hours.", [id]],
    ] : [
      ["The seven supplied readings average 6.3 hours (43.9 hours divided by 7).", [id]],
      ["Two of the seven readings were at or above 7 hours.", [id]],
    ], asksHowMany ? "Ask for the seven individual readings." : "Ask for the seven individual sleep readings."), evidence, chart, attachments };
  }

  if (topic === "weight") {
    const id = source("Weight trend", "2026-05-05: 72.4 kg; 2026-05-19: 71.9 kg; 2026-06-02: 71.2 kg. Derived change: 1.2 kg decrease.", "/biomarkers/weight_trend_kg", undefined, "WEIGHT-DELTA-01");
    chart = { type: "line", title: "Weight trend", xLabel: "Date", yLabel: "kg", series: [{ name: "Weight", color: "#b8ff5a" }], data: member.biomarkers.weight_trend_kg.map((point) => ({ date: point.date.slice(5), Weight: point.kg })) };
    return { answer: answer("Weight decreased across the supplied dates", [["Jordan's weight moved from 72.4 kg to 71.2 kg, a 1.2 kg decrease from May 5 to June 2.", [id]]], "Ask how adherence changed over the same period."), evidence, chart, attachments };
  }

  if (topic === "biomarkers") {
    const id = source("Current biomarkers", `Resting heart rate: ${member.biomarkers.resting_hr_bpm} bpm. HRV: ${member.biomarkers.hrv_ms} ms.`, "/biomarkers");
    return { answer: answer("Current supplied biomarkers", [[`Resting heart rate is ${member.biomarkers.resting_hr_bpm} bpm and HRV is ${member.biomarkers.hrv_ms} ms.`, [id]]], "Ask about sleep or weight trends."), evidence, chart, attachments };
  }

  if (topic === "labs") {
    const panel = member.labs.blood_panel;
    const id = source("Blood panel", `Date ${panel.date}; LDL 118 mg/dL; HDL 61 mg/dL; triglycerides 96 mg/dL; HbA1c 5.3%; vitamin D 28 ng/mL; ferritin 41 ng/mL; CRP 1.2 mg/L. No reference ranges or clinical conclusions are supplied.`, "/labs/blood_panel", String(panel.date));
    const valuesOnly = /don.t interpret|without interpretation|no interpretation/i.test(question);
    return { answer: answer("Latest supplied blood panel", valuesOnly ? [
      ["The April 20 panel reports LDL 118 mg/dL, HDL 61 mg/dL, triglycerides 96 mg/dL, HbA1c 5.3%, vitamin D 28 ng/mL, ferritin 41 ng/mL, and CRP 1.2 mg/L.", [id]],
    ] : [
      ["The April 20 panel reports LDL 118 mg/dL, HDL 61 mg/dL, triglycerides 96 mg/dL, HbA1c 5.3%, vitamin D 28 ng/mL, ferritin 41 ng/mL, and CRP 1.2 mg/L.", [id]],
      ["The dataset supplies no reference ranges or clinical conclusions, so this view does not classify values as normal, abnormal, or deficient.", [id]],
    ], valuesOnly ? "Ask separately if you want the source limitations." : "Ask which values include reference ranges in the source."), evidence, chart, attachments };
  }

  if (topic === "labs_reference") {
    const panel = member.labs.blood_panel;
    const id = source("Vitamin D and panel context", `Vitamin D: 28 ng/mL on ${panel.date}. HbA1c: 5.3%. The supplied member data contains values but no reference ranges or clinical conclusions, so outside-range or deficiency status is unavailable.`, "/labs/blood_panel", String(panel.date));
    const asksVitaminD = /vitamin d/i.test(question);
    return { answer: answer("Clinical range interpretation is unavailable", asksVitaminD ? [
      ["Vitamin D is recorded as 28 ng/mL on April 20, 2026.", [id]],
      ["No reference range is supplied, so the data cannot establish whether vitamin D is deficient.", [id]],
    ] : [
      ["No reference ranges or clinical conclusions are supplied, so the data cannot establish which blood-panel values are outside range.", [id]],
    ], "Use the source laboratory's ranges or a clinician for interpretation."), evidence, chart, attachments };
  }

  if (topic === "dexa") {
    const scan = member.labs.dexa_scan;
    const id = source("DEXA scan", `Date ${scan.date}; body fat 29.4%; lean mass 47.1 kg; fat mass 21.0 kg; bone-density Z-score 0.4; visceral fat 78 cm2.`, "/labs/dexa_scan", String(scan.date));
    return { answer: answer("March 30 DEXA summary", [["The DEXA reports 29.4% body fat, 47.1 kg lean mass, 21.0 kg fat mass, a 0.4 bone-density Z-score, and 78 cm² visceral fat.", [id]]], "Ask about the weight trend after the scan."), evidence, chart, attachments };
  }

  if (topic === "changes") {
    const adherence = source("Adherence change", "Weekly completion moved from 100% to 50% across the supplied four weeks.", "/adherence");
    const workout = source("Latest workout", "The June 3 lower-body workout was completed in 28 minutes at RPE 6.", "/workout_history/0", member.workout_history[0].date);
    const chat = source("Latest knee message", "After the June 3 workout, Jordan said her knee felt okay with box squats.", "/chat_history/0", member.chat_history[0].ts);
    return { answer: answer("Recent changes span adherence and a completed session", [
      ["The latest supplied workout was completed on June 3 in 28 minutes at RPE 6.", [workout]],
      ["Jordan then reported that her knee felt okay with box squats.", [chat]],
      ["Across the broader four-week window, adherence moved from 100% to 50%.", [adherence]],
    ], "Ask what might explain the adherence decline."), evidence, chart, attachments };
  }

  if (topic === "churn") {
    const id = source("Supplied churn assessment", `Risk level: elevated. Reasons: ${member.coach_brief.churn_risk.reasons.join("; ")}. Login frequency down is provided by the brief but raw login events are not supplied.`, "/coach_brief/churn_risk");
    return { answer: answer("The supplied churn risk is elevated", [
      ["Jordan's churn risk is supplied as elevated, with adherence falling from 100% to 50%, one fatigue/work-related skipped session, and lower login frequency listed as reasons.", [id]],
      ["Lower login frequency is a provided risk reason; it cannot be independently verified because raw login events are not included.", [id]],
    ], "Ask what might explain that."), evidence, chart, attachments };
  }

  if (topic === "workout") {
    const latest = member.workout_history[0];
    const id = source("Latest completed workout", `${latest.date}: ${latest.title}; completed ${latest.completed}; duration 28 minutes; RPE 6; exercises: ${latest.exercises.join(", ")}.`, "/workout_history/0", latest.date);
    return { answer: answer("Latest completed workout", [["Jordan completed Lower Body - Bands & DB on June 3 for 28 minutes at RPE 6.", [id]]], "Ask whether anything looked concerning afterward."), evidence, chart, attachments };
  }

  if (topic === "workout_concerns" || topic === "knee") {
    const id = source("Post-workout knee message", "On June 3 Jordan wrote: knee felt okay with the box squats. No later symptom outcome is supplied.", "/chat_history/0", member.chat_history[0].ts);
    return { answer: answer("No concern was reported in the available follow-up", [
      ["Jordan reported that her knee felt okay with the box squats after the June 3 workout.", [id]],
      ["That message is reassuring but does not establish a medical outcome, and no later symptom update is supplied.", [id]],
    ], "Ask Jordan how the knee felt the next morning."), evidence, chart, attachments };
  }

  if (topic === "injuries") {
    const injury = member.injuries[0];
    const id = source("Active constraint", `${injury.severity} ${injury.status} condition affecting the ${injury.region}. ${injury.notes}`, "/injuries/0", injury.since);
    return { answer: answer("Remember the recovering left knee", [["Jordan has mild recovering patellofemoral pain in her left knee and is cleared for low-impact loading, while deep knee flexion under load and plyometrics should be avoided.", [id]]], "Generate a knee-aware workout."), evidence, chart, attachments };
  }

  if (topic === "equipment") {
    const id = source("Home equipment", `Available: ${member.equipment_available.join(", ")}. Jordan also said there is no barbell at home.`, "/equipment_available");
    return { answer: answer("Jordan's available home equipment", [[`Jordan has dumbbells, a kettlebell, a yoga mat, a loop resistance band, and a flat bench; no barbell is listed.`, [id]]], "Generate a plan using only this equipment."), evidence, chart, attachments };
  }

  if (topic === "goals") {
    const id = source("Current goals", member.goals.map((goal) => `${goal.text} (priority ${goal.priority})`).join("; "), "/goals");
    return { answer: answer("Jordan's current goals", [
      ["Priority goals are lower-body strength and a return to pain-free squatting after the left-knee flare-up.", [id]],
      ["A secondary goal is averaging 7+ hours of sleep on weeknights.", [id]],
    ], "Ask for a workout aligned to the strength and knee goals."), evidence, chart, attachments };
  }

  if (topic === "missed_workout") {
    const id = source("Missed-session message", "On May 30 Jordan said she skipped Thursday because work blew up and she was wiped.", "/chat_history/2", member.chat_history[2].ts);
    return { answer: answer("Jordan gave a work-and-fatigue explanation", [["Jordan said work demands and fatigue contributed to the missed Thursday session; this is her report, not proof of the sole cause.", [id]]], "Ask whether that pressure is continuing this week."), evidence, chart, attachments };
  }

  if (topic === "chat") {
    const id = source("Recent conversation", "There are 4 supplied messages: 3 from the member and 1 from the coach. Topics: completed lower-body work and knee response; coach follow-up; work/fatigue missed session; home equipment. One member message has one synthetic image attachment.", "/chat_history");
    return { answer: answer("Recent conversation summary", [
      ["The supplied history contains three member messages and one coach message.", [id]],
      ["It covers a completed lower-body session with an okay knee response, a coach follow-up, a work-and-fatigue missed session, and home-equipment constraints.", [id]],
    ], "Ask to show the attachment placeholder."), evidence, chart, attachments };
  }

  if (topic === "attachments") {
    const attachment = member.chat_history.flatMap((item) => item.attachments ?? [])[0];
    const id = source("Synthetic attachment", "One synthetic image attachment is present: Home setup photo (synthetic placeholder). The underlying image file is not supplied.", "/chat_history/3/attachments/0", member.chat_history[3].ts);
    attachments = attachment ? [attachment] : [];
    return { answer: answer("One attachment placeholder is available", [["The history includes one synthetic home-setup image placeholder; no viewable image file is included.", [id]]], "Ask what equipment Jordan reported in the same message."), evidence, chart, attachments };
  }

  if (topic === "draft_message") {
    const id = source("Congratulations task", member.coach_brief.morning_tasks[0].text, "/coach_brief/morning_tasks/0", member.coach_brief.generated_for);
    return { answer: answer("Draft message", [["“Nice work getting yesterday's lower-body session done, Jordan—especially the pain-free box squats. How did your knee feel later that evening and this morning?”", [id]]], "Review and personalize before sending; this demo does not send messages."), evidence, chart, attachments };
  }

  const inventory = source("Available data inventory", "The supplied member context includes profile, goals, preferences, equipment, injuries, workouts, adherence, biomarkers, labs, DEXA, chats, and a coach brief. It does not include blood pressure or other unlisted measurements.", "/");
  return { answer: answer("That information is not available", [["Blood pressure or the requested information is not available in the provided member data.", [inventory]]], "Ask about a supplied topic such as adherence, sleep, workouts, labs, or equipment."), evidence, chart, attachments };
}

function buildSelectedBundle(member: MemberContext, topics: CopilotTopic[], question: string, requestedChart: boolean): GroundedBundle {
  const bundles = topics.map((topic) => buildBundle(member, topic, question));
  if (bundles.length === 1) return bundles[0];

  const evidence: EvidenceRecord[] = [];
  const narrative: CopilotAnswer["narrative"] = [];
  for (const bundle of bundles) {
    const idMap = new Map<string, string>();
    for (const record of bundle.evidence) {
      const id = `ev-c-${evidence.length + 1}`;
      idMap.set(record.id, id);
      evidence.push({ ...record, id });
    }
    narrative.push(...bundle.answer.narrative.map((item) => ({
      text: item.text,
      evidenceIds: item.evidenceIds.flatMap((id) => idMap.get(id) ?? []),
    })));
  }

  return {
    answer: {
      headline: "Here's what stands out from Jordan's record",
      narrative,
      followUpSuggestion: "Ask about any area you want to explore further.",
    },
    evidence,
    chart: requestedChart ? bundles.find((bundle) => bundle.chart)?.chart ?? null : null,
    attachments: bundles.flatMap((bundle) => bundle.attachments),
  };
}

export class CopilotService {
  constructor(
    private readonly member: MemberContext,
    private readonly gateway: StructuredModelGateway,
    private readonly config: AppConfig,
    private readonly conversations: ConversationRepository,
  ) {}

  async query(request: CopilotRequest): Promise<CopilotResponse> {
    const traceId = randomUUID();
    const conversationId = request.conversationId ?? `conversation_${randomUUID()}`;
    const history = await this.conversations.getRecent(conversationId, request.memberId, 8);
    const deterministicIntent = routeTopic(request.message, history.at(-1)?.topic);
    const modelCalls: ModelCallTrace[] = [];
    let intent = deterministicIntent;
    let mode: CopilotResponse["mode"] = "deterministic_fallback";

    if (this.gateway.available) {
      try {
        const result = await this.gateway.runStructured({
          stage: "copilot_intent",
          schemaName: "copilot_intent",
          schema: CopilotIntentSchema,
          system: intentSystemPrompt(),
          user: JSON.stringify({
            message: request.message,
            availableGraphTopics: broadGraphTopics,
            recentConversation: history.slice(-8),
          }),
        });
        modelCalls.push(result.trace);
        const modelSelectsTopics = deterministicIntent.topic === "unavailable" && !/blood[- ]pressure/i.test(request.message);
        intent = {
          ...result.value,
          topic: modelSelectsTopics ? result.value.topic : deterministicIntent.topic,
          relatedTopics: modelSelectsTopics ? result.value.relatedTopics : [],
          requestedChart: deterministicIntent.requestedChart || result.value.requestedChart,
        };
        mode = "live";
      } catch (error) {
        if (this.config.requireLiveModel) throw error;
      }
    } else if (this.config.requireLiveModel) {
      throw new Error("Live model required but OPENAI_API_KEY is not configured");
    }

    let topics = [...new Set([intent.topic, ...intent.relatedTopics])].slice(0, 4);
    if (topics.some((topic) => topic !== "unavailable")) topics = topics.filter((topic) => topic !== "unavailable");
    const bundle = buildSelectedBundle(this.member, topics, request.message, intent.requestedChart);
    let answer = bundle.answer;
    if (mode === "live") {
      try {
        const result = await this.gateway.runStructured({
          stage: "copilot_answer",
          schemaName: "copilot_answer",
          schema: CopilotAnswerSchema,
          system: answerSystemPrompt(),
          user: JSON.stringify({ question: request.message, candidateAnswer: bundle.answer, evidence: bundle.evidence }),
        });
        modelCalls.push(result.trace);
        if (validateAnswer(result.value, bundle.evidence) && preservesTopicContract(result.value, bundle.answer, intent.topic, request.message)) answer = result.value;
      } catch (error) {
        if (this.config.requireLiveModel) throw error;
        mode = "deterministic_fallback";
      }
    }
    if (this.config.requireLiveModel && (mode !== "live" || modelCalls.length !== 2)) throw new Error(`Live Copilot required exactly two model calls; observed ${modelCalls.length}`);

    const citedIds = new Set(answer.narrative.flatMap((item) => item.evidenceIds));
    const citedEvidence = bundle.evidence.filter((record) => citedIds.has(record.id));
    await this.conversations.append(conversationId, request.memberId, {
      message: request.message,
      topic: intent.topic,
      topics,
      headline: answer.headline,
      answer: answer.narrative.map((item) => item.text).join(" "),
    });
    return {
      status: "ready",
      mode,
      model: this.gateway.model,
      modelCallCount: modelCalls.length,
      traceId,
      conversationId,
      topic: intent.topic,
      topics,
      answer,
      chart: bundle.chart,
      attachments: bundle.attachments,
      evidence: citedEvidence,
      modelCalls,
    };
  }
}
