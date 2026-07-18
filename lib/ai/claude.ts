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
  type CaptureImage,
  CONFLICTS_SCHEMA,
  EXTRACTION_SCHEMA,
  ExtractionResult,
  FactConflict,
  FactRef,
  ResearchBrief,
  ConnectorSuggestion,
  ConnectorCandidate,
  sanitizeConnector,
  sanitizeBriefs,
  sanitizeConflicts,
  Signal,
} from "./types";

// Browser media type -> the four the Anthropic image block accepts. Unknown /
// absent falls back to png (screenshots are usually png).
function imageMedia(t?: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  switch ((t || "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/webp":
      return "image/webp";
    case "image/gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

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

// Concatenate every text block. Used when a tool (web search) ran, so the final
// JSON answer may follow tool blocks rather than being the first block.
function allText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// Pull a JSON object out of free text (the web-search path can't use strict
// json_schema output, so the model returns JSON inside its prose).
function parseJsonLoose<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

export class ClaudeAdapter implements AiAdapter {
  readonly label = "claude";

  async extract(input: {
    text: string;
    today: string;
    existingNames: string[];
    images?: CaptureImage[];
  }): Promise<ExtractionResult> {
    const images = input.images ?? [];
    const system = [
      "You are the memory engine for Membro, a personal CRM for one busy professional.",
      "From a raw note (typed, dictated, or read off a screenshot) extract the PEOPLE mentioned and the durable facts about each one.",
      "One note can mention several people — split the note and route each fragment to the right person (this is the core feature).",
      images.length > 1
        ? "This note is SEVERAL photos of ONE longer item (e.g. a two-page email), attached below possibly out of order. First work out the true reading order from their content — page numbers, a greeting then a sign-off, sentences that continue from one photo into the next — then read them as one continuous document before extracting. Do not treat the photos as separate notes."
        : "",
      `Today is ${input.today}; resolve relative dates ("next week", "Thursday") to absolute ISO datetimes in due_at.`,
      "Fact kinds: 'commitment' = a promise in EITHER direction (the note-taker owes someone, OR someone owes the note-taker); 'date' = a one-off dated event; 'preference' = how the person likes things; 'fact' = anything else worth remembering.",
      "For a commitment set owed_by: 'me' when the NOTE-TAKER promised to do something (\"I'll send the deck\", \"I owe her the doc\"), 'them' when the OTHER person owes the note-taker (\"he will send me the contract\", \"she still owes me the numbers\", \"waiting on Tom for the review\"). When it is unclear, use 'me', and never invent a debt owed to the note-taker.",
      "Set birthday only when a birthday is explicitly mentioned. Keep blurb to a short who-they-are line.",
      "confidence is 0..1: 1.0 when the person is unambiguous, lower (~0.5) when the name could collide with someone already known.",
      input.existingNames.length
        ? `People already on file (reuse the exact name when it is the same person): ${input.existingNames.join(", ")}.`
        : "No people are on file yet.",
      "Return only people actually described. If the note has no people, return an empty entities array.",
    ].join("\n");

    const userContent: Anthropic.ContentBlockParam[] = [];
    // Label each photo so the model can refer to them, but the instructions above
    // tell it the labels are upload order, not necessarily reading order.
    images.forEach((img, i) => {
      if (images.length > 1) userContent.push({ type: "text", text: `Photo ${i + 1} of ${images.length}:` });
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: imageMedia(img.mediaType), data: img.base64 },
      });
    });
    userContent.push({
      type: "text",
      text:
        input.text ||
        (images.length ? "Read the people and facts out of the attached photo(s)." : ""),
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

  async detectConflicts(input: {
    personName: string;
    newFacts: FactRef[];
    existingFacts: FactRef[];
    today: string;
  }): Promise<FactConflict[]> {
    if (!input.newFacts.length || !input.existingFacts.length) return [];
    const system = [
      "You are Membro's Ledger member. The owner just filed new facts about a person. Find ONLY the cases where a NEW fact ACTIVELY contradicts an existing one, so an old note is no longer true.",
      "A contradiction means the new statement negates or replaces the old (\"prefers tea\" then \"can't stand tea now, only coffee\"; \"vegetarian\" then \"back on steak\"). It is NOT a contradiction when the new fact merely ADDS information, covers a DIFFERENT attribute, or when both can be true at once (liking tea AND owning an espresso machine). A plain change over time that is self-explanatory (\"left Acme, now at Globex\") is an update, not a collision. When unsure, do NOT flag it.",
      "Use the exact ids given in brackets. reason is one short, non-accusatory line.",
      `Today is ${input.today}. Person: ${input.personName}.`,
    ].join("\n");
    const user = [
      `NEW facts:\n${input.newFacts.map((f) => `- [${f.id}] ${f.content}`).join("\n")}`,
      `EXISTING facts:\n${input.existingFacts.map((f) => `- [${f.id}] ${f.content}`).join("\n")}`,
    ].join("\n\n");

    const message = await client().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: CONFLICTS_SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);

    const parsed = JSON.parse(firstText(message)) as { conflicts?: FactConflict[] };
    return sanitizeConflicts(parsed.conflicts, input.newFacts, input.existingFacts);
  }

  async research(input: { note: string; today: string; knownSubjects: string[] }): Promise<ResearchBrief[]> {
    if (!input.note.trim()) return [];
    const known = input.knownSubjects.length ? input.knownSubjects.join(", ") : "(nothing on file yet)";
    const system = [
      "You are Membro's Researcher, one of a small crew that reads every note the owner captures. If the note names a company, organization, product, or topic the owner has NEVER logged and that is genuinely worth knowing, web-search it and leave ONE short, current brief.",
      "Each brief must carry one concrete, CURRENT fact (recent funding, a leadership change, a launch, a notable recent event) plus a one-line tie-back to why it matters right now given the note. Never write founding-year filler, mission-statement language, or an About-page paragraph. Keep each body to 2-4 plain sentences, the owner's voice, no em-dashes.",
      "Stay SILENT (empty list) for household names the owner obviously knows, anything already on file, an ambiguous or joking mention, or when the search turns up nothing substantive.",
      `Today is ${input.today}. Already on file, do NOT brief these: ${known}.`,
      'Output ONLY a JSON object: {"briefs":[{"subject":string,"body":string,"why":string}]}. Empty array if nothing is worth briefing.',
    ].join("\n");

    // The web_search server tool can't be combined with strict json_schema output,
    // so we ask for JSON in prose and parse it out. Best-effort: an unparseable
    // answer just yields no briefs rather than failing the note's crew run.
    const message = await client().messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: `NOTE:\n${input.note}` }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    try {
      const parsed = parseJsonLoose<{ briefs?: ResearchBrief[] }>(allText(message));
      return sanitizeBriefs(parsed.briefs, input.knownSubjects);
    } catch {
      return [];
    }
  }

  async connectNote(input: {
    note: string;
    subjectName: string;
    candidates: ConnectorCandidate[];
    today: string;
  }): Promise<ConnectorSuggestion | null> {
    if (!input.candidates.length) return null;
    const candidateBlock = input.candidates
      .map((c) => `- ${c.name} [id: ${c.id}] (shares: ${c.sharedTopics.join(", ")})\n    ${c.facts.slice(0, 6).join("\n    ") || "(no facts)"}`)
      .join("\n");
    const system = [
      "You are Membro's Connector, one of a small crew that reads every note the owner captures. The owner just filed something new about a person; spot when that makes an introduction worth offering, and stay quiet otherwise.",
      "Suggest AT MOST ONE intro, and only when there is a SPECIFIC, two-sided reason the two should meet: one clearly needs or is looking for what the other has or does. A shared word is NOT a reason. Ground it in a REAL fact on each side and state the direction. If none clears that bar, stay silent: a missed intro is fine, a weak one is not.",
      "The intro is a short, warm, ready-to-send double opt-in note in the owner's voice. Plain English, no em-dashes.",
      `Today is ${input.today}. The new note is about ${input.subjectName}.`,
      'Output ONLY a JSON object: {"otherId":string,"why":string,"intro":string} for the one intro worth making, or {"otherId":null} to stay silent.',
    ].join("\n");
    try {
      const message = await client().messages.create({
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: `NOTE:\n${input.note}\n\nCANDIDATES:\n${candidateBlock}` }],
      } as Anthropic.MessageCreateParamsNonStreaming);
      const parsed = parseJsonLoose<Partial<ConnectorSuggestion> & { otherId: unknown }>(allText(message));
      const suggestion = typeof parsed.otherId === "string" ? (parsed as ConnectorSuggestion) : null;
      return sanitizeConnector(suggestion, input.candidates.map((c) => c.id));
    } catch {
      return null; // best-effort: an unparseable answer just means no intro this note
    }
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
    case "chase":
      return `Signal: CHASE. ${signal.person.name} owes the owner: "${signal.item}". Facts: ${signal.facts.join("; ") || "none"}. Write a 'nudge' card: a short, warm, low-pressure reminder the owner can send to gently follow up, anchored to that specific thing. Assume the best (it is probably just in progress). Do NOT mention lateness or timing and never use words like "overdue", "late", "still waiting", or "reminder"; keep it friendly and no-pressure, e.g. "Hey, how's the contract coming along? No rush."`;
  }
}
