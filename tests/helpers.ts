import { ControlledStructuredGateway } from "../src/server/openai.js";
import type { CopilotTopic, WorkoutIntent } from "../src/shared/schemas.js";

function workoutIntent(prompt: string, durationMinutes: number): WorkoutIntent {
  const text = prompt.toLowerCase();
  let focus: WorkoutIntent["focus"] = "full_body";
  if (/recover/.test(text)) focus = "recovery";
  else if (/pec|chest/.test(text)) focus = "chest";
  else if (/upper.*push/.test(text)) focus = "upper_push";
  else if (/upper.*pull/.test(text)) focus = "upper_pull";
  else if (/upper.body/.test(text)) focus = "upper_body";
  else if (/lower.body|leg day|legs|knee-friendly/.test(text)) focus = "lower_body";
  const requestedEquipment: string[] = [];
  if (/dumbbell|\bdb\b/.test(text)) requestedEquipment.push("Dumbbell");
  if (/kettlebell/.test(text)) requestedEquipment.push("Kettlebell");
  if (/barbell/.test(text) && !/no barbell/.test(text)) requestedEquipment.push("Barbell");
  if (/rowing machine/.test(text)) requestedEquipment.push("Rowing Machine");
  if (/flat bench/.test(text)) requestedEquipment.push("Flat Bench");
  const excludedTerms: string[] = [];
  if (/exclude deadlift/.test(text)) excludedTerms.push("deadlift");
  if (/(?:take out|leave out|remove|drop|skip).*split squat/.test(text)) excludedTerms.push("split squat");
  if (/no burpee/.test(text)) excludedTerms.push("burpee");
  if (/no jumping|no high-impact|no high impact/.test(text)) excludedTerms.push("jump");
  if (/no barbell/.test(text)) excludedTerms.push("barbell");
  const unresolvedTerms = /zorp joint/.test(text) ? ["zorp joint"] : [];
  return {
    focus,
    durationMinutes,
    requestedEquipment,
    equipmentMode: /only|barbell-only/.test(text) ? "only" : "available",
    excludedTerms,
    safetyTerms: [/knee/.test(text) ? "knee" : "", /lower back/.test(text) ? "lumbar spine" : ""].filter(Boolean),
    noImpact: /knee|no jumping|no high-impact|no high impact/.test(text),
    recovery: focus === "recovery",
    unresolvedTerms,
  };
}

function copilotTopic(message: string, recentTopic?: CopilotTopic): CopilotTopic {
  const text = message.toLowerCase();
  if (/draft.*congrat/.test(text)) return "draft_message";
  if (/outside.*reference|vitamin d.*deficient/.test(text)) return "labs_reference";
  if (/what might explain/.test(text)) return recentTopic === "adherence" ? "adherence_explanation" : "churn";
  if (/anything concerning/.test(text)) return "workout_concerns";
  if (/brief/.test(text)) return "brief";
  if (/before coaching/.test(text)) return "today";
  if (/adherence|last four weeks/.test(text)) return "adherence";
  if (/sleep/.test(text)) return "sleep";
  if (/weight/.test(text)) return "weight";
  if (/heart rate|hrv/.test(text)) return "biomarkers";
  if (/hba1c|bloodwork|latest labs|labs/.test(text)) return "labs";
  if (/dexa/.test(text)) return "dexa";
  if (/changed/.test(text)) return "changes";
  if (/churn/.test(text)) return "churn";
  if (/latest workout/.test(text)) return "workout";
  if (/knee feel/.test(text)) return "knee";
  if (/injur|constraint/.test(text)) return "injuries";
  if (/equipment/.test(text)) return "equipment";
  if (/goals/.test(text)) return "goals";
  if (/miss.*thursday/.test(text)) return "missed_workout";
  if (/conversation/.test(text)) return "chat";
  if (/images/.test(text)) return "attachments";
  return "unavailable";
}

export function makeControlledGateway() {
  return new ControlledStructuredGateway("gpt-5.6-luna", (stage, user) => {
    const parsed = JSON.parse(user) as Record<string, any>;
    if (stage === "workout_intent") {
      const request = parsed.request as { prompt: string; durationMinutes: number };
      const previous = parsed.previousIntent as WorkoutIntent | null;
      const next = workoutIntent(request.prompt, request.durationMinutes);
      const hasExplicitFocus = /recover|pec|chest|upper|lower|leg|knee-friendly|core|full.body/i.test(request.prompt);
      return {
        ...next,
        focus: hasExplicitFocus || !previous ? next.focus : previous.focus,
        requestedEquipment: next.requestedEquipment.length ? next.requestedEquipment : (previous?.requestedEquipment ?? []),
        equipmentMode: /only|just|nothing but/i.test(request.prompt) ? next.equipmentMode : (previous?.equipmentMode ?? next.equipmentMode),
        excludedTerms: [...new Set([...(previous?.excludedTerms ?? []), ...next.excludedTerms])],
        safetyTerms: [...new Set([...(previous?.safetyTerms ?? []), ...next.safetyTerms])],
        noImpact: Boolean(previous?.noImpact) || next.noImpact,
      };
    }
    if (stage === "workout_narrative") {
      const plan = parsed.plan as { title: string; safetyNotes: string[]; sections: Array<{ exercises: Array<{ exerciseId: string; evidenceIds: string[]; riskLevel: string }> }> };
      return {
        summary: `${plan.title} is assembled from approved exercises.`,
        safetySummary: plan.safetyNotes.join(" "),
        exerciseNotes: plan.sections.flatMap((section) => section.exercises.map((exercise) => ({
          exerciseId: exercise.exerciseId,
          note: exercise.riskLevel === "modified" ? "Use the constrained pain-free range." : "Use controlled repetitions.",
          evidenceIds: exercise.evidenceIds.slice(0, 2),
        }))),
      };
    }
    if (stage === "copilot_intent") {
      const message = String(parsed.message);
      const recentConversation = parsed.recentConversation as Array<{ topic?: CopilotTopic }> | undefined;
      const recentTopic = recentConversation?.at(-1)?.topic;
      const broadQuestion = /\boverall\b|how(?:'s| is) (?:she|he|jordan|the member) doing|big picture|general picture/i.test(message);
      const topic: CopilotTopic = broadQuestion ? "workout" : copilotTopic(message, recentTopic);
      const relatedTopics: CopilotTopic[] = broadQuestion ? ["adherence", "injuries"] : [];
      return { topic, relatedTopics, timeHorizon: null, requestedChart: /plot|trend|compare/i.test(message), entities: [], unresolvedTerms: [] };
    }
    if (stage === "copilot_answer") {
      const candidate = parsed.candidateAnswer as { headline: string; narrative: Array<{ text: string; evidenceIds: string[] }>; followUpSuggestion: string };
      if (/\boverall\b|big picture|general picture/i.test(String(parsed.question))) {
        return {
          headline: "Overall, Jordan is making progress with one clear concern",
          narrative: [candidate.narrative[0], candidate.narrative[1], candidate.narrative.at(-1)],
          followUpSuggestion: "Ask about any area you want to explore further.",
        };
      }
      return candidate;
    }
    throw new Error(`Unexpected controlled stage: ${stage}`);
  });
}
