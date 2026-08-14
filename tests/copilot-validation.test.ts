import { describe, expect, it } from "vitest";
import { preservesTopicContract } from "../src/server/copilot.js";
import type { CopilotAnswer } from "../src/shared/schemas.js";

const candidate = (text: string): CopilotAnswer => ({
  headline: "Candidate",
  narrative: [{ text, evidenceIds: ["evidence-1"] }],
  followUpSuggestion: "Follow up.",
});

describe("Copilot topic contract validation", () => {
  it("rejects sleep phrasing that omits a required calculated value", () => {
    expect(preservesTopicContract(
      candidate("The average was 6.3 hours across 7 readings, with 2 at or above 7 hours."),
      candidate("The average was 6.3 hours from 43.9 hours across 7 readings, with 2 at or above 7 hours."),
      "sleep",
      "How has sleep been?",
    )).toBe(false);
  });

  it("retains exact comparison and supplied-record qualifiers", () => {
    expect(preservesTopicContract(candidate("Completion fell from 100% to 50%."), candidate("That is a 50 percentage-point decrease from 100% to 50%."), "adherence", "Compare four weeks")).toBe(false);
    expect(preservesTopicContract(candidate("There were three messages from the member and one from the coach."), candidate("There were three member messages and one coach message."), "chat", "Summarize the chat")).toBe(false);
    expect(preservesTopicContract(candidate("Deficiency status is unavailable at 28 ng/mL."), candidate("The supplied data cannot establish deficiency at 28 ng/mL."), "labs_reference", "Is vitamin D deficient?")).toBe(false);
    expect(preservesTopicContract(candidate("Nice work on the pain-free squat work."), candidate("Nice work on the pain-free squat work after the knee flare-up."), "draft_message", "Draft a text")).toBe(false);
    expect(preservesTopicContract(candidate("We do not have that reading."), candidate("That reading is not available."), "unavailable", "Do we have blood pressure?")).toBe(false);
    expect(preservesTopicContract(candidate("She said work blew up and she was wiped."), candidate("Her report says work demands and fatigue contributed."), "missed_workout", "Why did she miss Thursday?")).toBe(false);
    expect(preservesTopicContract(candidate("An attachment exists, but the underlying file is not supplied."), candidate("One synthetic placeholder is present; no viewable image file is included."), "attachments", "Did she send a photo?")).toBe(false);
  });
});
