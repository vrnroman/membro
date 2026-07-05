import Anthropic from "@anthropic-ai/sdk";
import {
  AiAdapter,
  AssistContextPerson,
  AssistOutput,
  ASSIST_SCHEMA,
  BriefContent,
  BriefInput,
  BRIEF_SCHEMA,
  BuiltCard,
  CARD_SCHEMA,
  EXTRACTION_SCHEMA,
  ExtractionResult,
  Signal,
} from "./types";

// Opus 4.8 is the house default; override with MEMBRO_MODEL if you want to trade
// some quality for cost (e.g. claude-sonnet-4-6).
const MODEL = process.env.MEMBRO_MODEL || "claude-opus-4-8";

function client() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Pull the first text block (structured-output mode guarantees it is valid JSON).
function firstText(message: Anthropic.Message): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

export class ClaudeAdapter implements AiAdapter {
  readonly label = "claude";

  async extract(input: {
    text: string;
    today: string;
    existingNames: string[];
    imageBase64?: string;
    imageMediaType?: string;
  }): Promise<ExtractionResult> {
    const system = [
      "You are the memory engine for Membro, a personal CRM for one busy professional.",
      "From a raw note (typed, dictated, or read off a screenshot) extract the PEOPLE mentioned and the durable facts about each one.",
      "One note can mention several people — split the note and route each fragment to the right person (this is the core feature).",
      `Today is ${input.today}; resolve relative dates ("next week", "Thursday") to absolute ISO datetimes in due_at.`,
      "Fact kinds: 'commitment' = something the NOTE-TAKER promised to do; 'date' = a one-off dated event; 'preference' = how the person likes things; 'fact' = anything else worth remembering.",
      "Set birthday only when a birthday is explicitly mentioned. Keep blurb to a short who-they-are line.",
      "confidence is 0..1: 1.0 when the person is unambiguous, lower (~0.5) when the name could collide with someone already known.",
      input.existingNames.length
        ? `People already on file (reuse the exact name when it is the same person): ${input.existingNames.join(", ")}.`
        : "No people are on file yet.",
      "Return only people actually described. If the note has no people, return an empty entities array.",
    ].join("\n");

    const userContent: Anthropic.ContentBlockParam[] = [];
    if (input.imageBase64) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: (input.imageMediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif") || "image/png",
          data: input.imageBase64,
        },
      });
    }
    userContent.push({
      type: "text",
      text: input.text || "Read the people and facts out of the attached image.",
    });

    const message = await client().messages.create({
      model: MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: userContent }],
      output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);

    return JSON.parse(firstText(message)) as ExtractionResult;
  }

  async buildCard(signal: Signal, today: string): Promise<BuiltCard> {
    const system = [
      "You are the night-shift chief of staff for Membro. You turn a 'ripe' relationship signal into ONE finished card the owner can approve in seconds.",
      "Write in the owner's voice: warm, direct, plain English, no em-dashes, no corporate filler. The body must be a ready-to-send message or a tight brief, not advice about what to write.",
      "Never invent facts not given. 'why' is one sentence explaining what triggered this card.",
      `Today is ${today}.`,
    ].join("\n");

    const message = await client().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: describeSignal(signal) }],
      output_config: { format: { type: "json_schema", schema: CARD_SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);

    return JSON.parse(firstText(message)) as BuiltCard;
  }

  async brief(input: BriefInput): Promise<BriefContent> {
    const { person, facts, newFacts, cadenceDays, today } = input;
    const system = [
      "You are Membro's Pre-Read engine. Before the owner talks to this person, hand them a decision aid they can read in one glance, not a summary of everything on file.",
      "Return three parts:",
      "- read: two short lines. Who this person is to the owner, and where things were left (the last real thread, the mood).",
      "- insights: 2 to 4 short bullets. What CHANGED since last time, and the tension or the opportunity that matters NOW. Draw only from the facts given.",
      "- recommendations: 2 to 4 short, concrete moves. What to open with (grounded in a real fact), anything the owner owes this person or is owed, and only a REAL thing to avoid. Never invent a landmine that is not in the facts; if there is nothing to avoid, leave it out.",
      "Write in the owner's voice: warm, direct, plain English, no em-dashes, no filler, no therapy-speak. Never invent specifics not in the facts.",
      `Today is ${today}.`,
    ].join("\n");

    const rhythm = cadenceDays ? `They usually talk about every ${cadenceDays} day(s).` : "";
    const userContent = [
      `Person: ${person.name}${person.role ? `, ${person.role}` : ""}${person.company ? ` at ${person.company}` : ""}.`,
      rhythm,
      newFacts.length ? `New since the owner's last prep:\n- ${newFacts.join("\n- ")}` : "Nothing new since the last prep.",
      `Everything on file (newest first):\n- ${facts.join("\n- ") || "(nothing yet)"}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const message = await client().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userContent }],
      output_config: { format: { type: "json_schema", schema: BRIEF_SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);

    return JSON.parse(firstText(message)) as BriefContent;
  }

  async assist(input: { note: string; today: string; people: AssistContextPerson[] }): Promise<AssistOutput> {
    const system = [
      "You are Membro's assistant. The owner just captured a note. Classify it and, when it warrants, START the work so the owner only has to review.",
      "Choose ONE kind:",
      "- 'draft': the note is a task the owner must produce something for (send an email, reply, write a doc, prep a deck). body = the ready-to-send draft in the owner's voice. For slides, write a tight markdown outline. Ground it in the known facts; never invent specifics.",
      "- 'advisory': the note is a situation or a 'what do I say back'. body = two short parts: a one-paragraph read of what is going on and what to watch, then a drafted reply the owner can send.",
      "- 'diary': the note is a first-person reflection about the OWNER themselves (a feeling, a personal event), not about another person. body = \"\".",
      "- 'none': nothing to start; it is pure information already saved. body = \"\".",
      "Only pick 'draft' or 'advisory' when there is real work to start. When unsure between none and the others, pick 'none'. Plain English, no em-dashes. title is a short label. why is one sentence.",
      `Today is ${input.today}.`,
    ].join("\n");

    const context = input.people.length
      ? input.people.map((p) => `- ${p.name}: ${p.facts.slice(0, 6).join("; ") || "(no facts yet)"}`).join("\n")
      : "(no specific people)";

    const message = await client().messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: `NOTE:\n${input.note}\n\nPEOPLE THE NOTE IS ABOUT:\n${context}` }],
      output_config: { format: { type: "json_schema", schema: ASSIST_SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);

    return JSON.parse(firstText(message)) as AssistOutput;
  }

  async reflect(entries: string[], today: string): Promise<string> {
    const system = [
      "You are Membro's diary companion. These are the owner's own recent first-person notes about themselves.",
      "Write a short, warm reflection: what stands out, any pattern worth noticing, one gentle prompt for the days ahead. Speak to the owner as 'you'. Plain English, no em-dashes, no therapy-speak, no preamble.",
      `Today is ${today}.`,
    ].join("\n");

    const message = await client().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: `Recent entries:\n- ${entries.join("\n- ") || "(nothing yet)"}` }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    return firstText(message).trim();
  }
}

function describeSignal(signal: Signal): string {
  switch (signal.type) {
    case "birthday":
      return `Signal: BIRTHDAY. ${signal.person.name}'s birthday is in ${signal.daysUntil} day(s). Known facts: ${signal.facts.join("; ") || "none"}. Write a 'nudge' card: a short, personal birthday message ready to send.`;
    case "commitment":
      return `Signal: COMMITMENT. The owner promised ${signal.person.name}: "${signal.commitment}"${signal.dueLabel ? ` (due ${signal.dueLabel})` : ""}. Other facts: ${signal.facts.join("; ") || "none"}. Write a 'brief' card reminding the owner to deliver, with a one-line message they can send if they need more time.`;
    case "meeting":
      return `Signal: MEETING. The owner is meeting ${signal.person.name} ${signal.whenLabel}. Facts: ${signal.facts.join("; ") || "none"}. Write a 'brief' card: a tight prep note with one ice-breaker and the open items to raise.`;
    case "dated":
      return `Signal: DATED EVENT. "${signal.event}" involving ${signal.person.name} is ${signal.whenLabel}. Facts: ${signal.facts.join("; ") || "none"}. Write a 'brief' card reminding the owner what is coming up and anything to prepare.`;
    case "cold": {
      const anchor = signal.facts[0];
      return `Signal: COLD. The owner has not spoken with ${signal.person.name} in ${signal.daysSince} days${signal.cadenceDays ? ` (they usually talk about every ${signal.cadenceDays})` : ""}. Facts, most recent first: ${signal.facts.join("; ") || "none"}. Write a 'nudge' card: a short, warm, low-pressure reconnect opener ready to send. Anchor it to a REAL recent detail${anchor ? ` such as "${anchor}"` : ""} and ask about that specific thing. Never a generic "just checking in" or "it's been a while".`;
    }
    case "connector":
      return `Signal: CONNECTOR. ${signal.personA.name} and ${signal.personB.name} are both connected to "${signal.shared}". Facts: ${signal.facts.join("; ") || "none"}. Write a 'connector' card: a short, ready-to-send intro that explains why these two should meet.`;
  }
}
