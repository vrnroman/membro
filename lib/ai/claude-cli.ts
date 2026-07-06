import { execFile } from "node:child_process";
import {
  AiAdapter,
  AssistContextPerson,
  AssistOutput,
  BriefContent,
  BriefInput,
  BuiltCard,
  ExtractionResult,
  Signal,
} from "./types";

// Runs Membro's thinking through your Claude Code subscription via `claude -p`
// instead of the Anthropic API. Works wherever the `claude` CLI is installed and
// logged in — i.e. your own machine (npm run dev / a local build), NOT a stock
// Vercel serverless deploy (no binary, no login there). On Vercel this adapter
// is not selected; the mock is used unless an ANTHROPIC_API_KEY is set.

const BIN = process.env.MEMBRO_CLAUDE_BIN || "claude";
const MODEL = process.env.MEMBRO_CLAUDE_MODEL || ""; // empty = your subscription default

// Serialize CLI calls: each `claude -p` is a full agent process, so we run one at
// a time rather than spawning eight at once during a night-shift run.
let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run as Promise<T>;
}

function runClaude(prompt: string): Promise<string> {
  return enqueue(
    () =>
      new Promise<string>((resolve, reject) => {
        const args = ["-p", prompt, "--output-format", "json"];
        if (MODEL) args.push("--model", MODEL);
        execFile(
          BIN,
          args,
          { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
          (err, stdout) => {
            if (err && !stdout) {
              reject(new Error(`claude -p failed: ${err.message} (is the Claude CLI installed and logged in?)`));
              return;
            }
            // `--output-format json` wraps the answer in {type:"result", result:"..."}.
            try {
              const parsed = JSON.parse(stdout);
              resolve(typeof parsed?.result === "string" ? parsed.result : stdout);
            } catch {
              resolve(stdout);
            }
          },
        );
      }),
  );
}

// Pull a JSON object out of the model's text (it may wrap it in a code fence).
function parseJsonObject<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in claude -p output");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

export class ClaudeCliAdapter implements AiAdapter {
  readonly label = "claude-cli";

  async extract(input: { text: string; today: string; existingNames: string[]; imageBase64?: string }): Promise<ExtractionResult> {
    if (!input.text && input.imageBase64) {
      // The CLI path does not handle inline base64 images; skip rather than guess.
      return { entities: [] };
    }
    const prompt = [
      "You are the memory engine for Membro, a personal CRM for one busy professional.",
      "From the NOTE below, extract the PEOPLE mentioned and the durable facts about each. One note can mention several people; split it and route each fragment to the right person.",
      `Today is ${input.today}; resolve relative dates to absolute ISO datetimes in due_at.`,
      "Fact kinds: 'commitment' = a promise in EITHER direction (the note-taker owes someone, or someone owes the note-taker); 'date' = a one-off dated event; 'preference' = how the person likes things; 'fact' = anything else.",
      "For a commitment set owed_by: 'me' when the note-taker owes it (\"I'll send the deck\"), 'them' when the other person owes the note-taker (\"he will send me the contract\", \"waiting on Tom for the review\"). When unsure, use 'me' (never invent a debt owed to the note-taker).",
      "Set birthday only when explicitly mentioned. confidence is 0..1 (lower when a name could collide with someone already known).",
      input.existingNames.length ? `Already on file: ${input.existingNames.join(", ")}.` : "No people on file yet.",
      'Output ONLY a JSON object, no prose, of shape: {"entities":[{"name":string,"company":string|null,"role":string|null,"blurb":string|null,"birthday":string|null,"confidence":number,"facts":[{"kind":"fact"|"date"|"commitment"|"preference","content":string,"due_at":string|null,"owed_by":"me"|"them"}]}]}.',
      "",
      `NOTE:\n${input.text}`,
    ].join("\n");
    return parseJsonObject<ExtractionResult>(await runClaude(prompt));
  }

  async buildCard(signal: Signal, today: string): Promise<BuiltCard> {
    const prompt = [
      "You are the night-shift chief of staff for Membro. Turn this relationship signal into ONE finished card the owner can approve in seconds.",
      "Write in the owner's voice: warm, direct, plain English, no em-dashes. The body must be a ready-to-send message or a tight brief, not advice. Never invent facts. 'why' is one sentence.",
      `Today is ${today}.`,
      describeSignal(signal),
      'Output ONLY a JSON object: {"kind":"connector"|"nudge"|"brief","title":string,"body":string,"why":string}.',
    ].join("\n");
    return parseJsonObject<BuiltCard>(await runClaude(prompt));
  }

  async brief(input: BriefInput): Promise<BriefContent> {
    const { person, facts, newFacts, cadenceDays, today } = input;
    const rhythm = cadenceDays ? `They usually talk about every ${cadenceDays} day(s).` : "";
    const prompt = [
      "You are Membro's Pre-Read engine. Give the owner a decision aid to read in one glance before they talk to this person, not a summary of everything on file.",
      "Return three parts: read (two short lines: who they are, where things were left), insights (2-4 bullets: what changed since last time, the tension or opportunity now), recommendations (2-4 concrete moves: what to open with grounded in a real fact, what the owner owes or is owed, and only a REAL thing to avoid; never invent a landmine, leave it out if there is none).",
      "Owner's voice: warm, direct, plain English, no em-dashes, no filler. Never invent specifics not in the facts.",
      `Today is ${today}.`,
      `Person: ${person.name}${person.role ? `, ${person.role}` : ""}${person.company ? ` at ${person.company}` : ""}.`,
      rhythm,
      newFacts.length ? `New since last prep:\n- ${newFacts.join("\n- ")}` : "Nothing new since last prep.",
      `On file (newest first):\n- ${facts.join("\n- ") || "(nothing yet)"}`,
      'Output ONLY a JSON object: {"read":string,"insights":string[],"recommendations":string[]}.',
    ]
      .filter(Boolean)
      .join("\n");
    return parseJsonObject<BriefContent>(await runClaude(prompt));
  }

  async assist(input: { note: string; today: string; people: AssistContextPerson[] }): Promise<AssistOutput> {
    const context = input.people.length
      ? input.people.map((p) => `- ${p.name}: ${p.facts.slice(0, 6).join("; ") || "(no facts yet)"}`).join("\n")
      : "(no specific people)";
    const prompt = [
      "You are Membro's assistant. The owner just captured a note. Classify it and, when it warrants, START the work so the owner only reviews.",
      "Pick ONE kind:",
      "- 'draft': a task the owner must produce something for (send an email, reply, write a doc, prep a deck). body = the ready-to-send draft in the owner's voice; for slides write a tight markdown outline. Ground it in the known facts; never invent specifics.",
      "- 'advisory': a situation or a 'what do I say back'. body = a one-paragraph read of what is going on and what to watch, then a drafted reply the owner can send.",
      "- 'diary': a first-person reflection about the OWNER themselves (a feeling, a personal event), not about another person. body = empty.",
      "- 'none': nothing to start; pure information already saved. body = empty.",
      "Only pick 'draft' or 'advisory' when there is real work to start; when unsure, pick 'none'. Plain English, no em-dashes. title is a short label; why is one sentence.",
      `Today is ${input.today}.`,
      'Output ONLY a JSON object: {"kind":"draft"|"advisory"|"diary"|"none","title":string,"body":string,"why":string}.',
      "",
      `NOTE:\n${input.note}`,
      "",
      `PEOPLE THE NOTE IS ABOUT:\n${context}`,
    ].join("\n");
    return parseJsonObject<AssistOutput>(await runClaude(prompt));
  }

  async reflect(entries: string[], today: string): Promise<string> {
    const prompt = [
      "You are Membro's diary companion. These are the owner's own recent first-person notes about themselves.",
      "Write a short, warm reflection: what stands out, any pattern worth noticing, one gentle prompt for the days ahead. Speak to the owner as 'you'. Plain English, no em-dashes, no therapy-speak. Output the reflection text only, no preamble.",
      `Today is ${today}.`,
      `Recent entries:\n- ${entries.join("\n- ") || "(nothing yet)"}`,
    ].join("\n");
    return (await runClaude(prompt)).trim();
  }
}

function describeSignal(signal: Signal): string {
  switch (signal.type) {
    case "birthday":
      return `Signal: BIRTHDAY. ${signal.person.name}'s birthday is in ${signal.daysUntil} day(s). Facts: ${signal.facts.join("; ") || "none"}. Write a 'nudge': a short personal birthday message ready to send.`;
    case "commitment":
      return `Signal: COMMITMENT. The owner promised ${signal.person.name}: "${signal.commitment}"${signal.dueLabel ? ` (due ${signal.dueLabel})` : ""}. Facts: ${signal.facts.join("; ") || "none"}. Write a 'brief' reminding the owner to deliver, with a one-line message they can send if they need more time.`;
    case "meeting":
      return `Signal: MEETING. The owner meets ${signal.person.name} ${signal.whenLabel}. Facts: ${signal.facts.join("; ") || "none"}. Write a 'brief': a tight prep note with one ice-breaker and the open items.`;
    case "dated":
      return `Signal: DATED EVENT. "${signal.event}" involving ${signal.person.name} is ${signal.whenLabel}. Facts: ${signal.facts.join("; ") || "none"}. Write a 'brief' reminding the owner what is coming up and anything to prepare.`;
    case "cold": {
      const anchor = signal.facts[0];
      return `Signal: COLD. No contact with ${signal.person.name} in ${signal.daysSince} days${signal.cadenceDays ? ` (usually about every ${signal.cadenceDays})` : ""}. Facts, most recent first: ${signal.facts.join("; ") || "none"}. Write a 'nudge': a short, warm, low-pressure reconnect opener ready to send. Anchor it to a REAL recent detail${anchor ? ` such as "${anchor}"` : ""} and ask about that specific thing. Never a generic "just checking in" or "it's been a while".`;
    }
    case "connector":
      return `Signal: CONNECTOR. ${signal.personA.name} and ${signal.personB.name} are both connected to "${signal.shared}". Facts: ${signal.facts.join("; ") || "none"}. Write a 'connector': a short ready-to-send intro explaining why they should meet.`;
    case "chase":
      return `Signal: CHASE. ${signal.person.name} owes the owner: "${signal.item}". Facts: ${signal.facts.join("; ") || "none"}. Write a 'nudge': a short, warm, low-pressure reminder the owner can send to gently follow up, anchored to that specific thing. Assume the best (probably just in progress). Do NOT mention lateness or timing and never use words like "overdue", "late", "still waiting", or "reminder"; keep it friendly, e.g. "Hey, how's the contract coming along? No rush."`;
  }
}
