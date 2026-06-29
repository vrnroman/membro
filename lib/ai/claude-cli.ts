import { execFile } from "node:child_process";
import {
  AiAdapter,
  BuiltCard,
  ExtractionResult,
  PersonLite,
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
      "Fact kinds: 'commitment' = something the note-taker promised to do; 'date' = a one-off dated event; 'preference' = how the person likes things; 'fact' = anything else.",
      "Set birthday only when explicitly mentioned. confidence is 0..1 (lower when a name could collide with someone already known).",
      input.existingNames.length ? `Already on file: ${input.existingNames.join(", ")}.` : "No people on file yet.",
      'Output ONLY a JSON object, no prose, of shape: {"entities":[{"name":string,"company":string|null,"role":string|null,"blurb":string|null,"birthday":string|null,"confidence":number,"facts":[{"kind":"fact"|"date"|"commitment"|"preference","content":string,"due_at":string|null}]}]}.',
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

  async brief(person: PersonLite, facts: string[], today: string): Promise<string> {
    const prompt = [
      "You are Membro's meeting-prep engine. Write a short, scannable brief to get the owner ready to talk to this person.",
      "Lead with one ice-breaker grounded in a real fact, then 2-4 bullets of what to remember and any open follow-ups. Plain English, no em-dashes. Output the brief text only, no preamble.",
      `Today is ${today}.`,
      `Person: ${person.name}${person.role ? `, ${person.role}` : ""}${person.company ? ` at ${person.company}` : ""}.`,
      `What we know:\n- ${facts.join("\n- ") || "(nothing yet)"}`,
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
    case "cold":
      return `Signal: COLD. No contact with ${signal.person.name} in ${signal.daysSince} days. Facts: ${signal.facts.join("; ") || "none"}. Write a 'nudge': a warm low-pressure reconnect message ready to send.`;
    case "connector":
      return `Signal: CONNECTOR. ${signal.personA.name} and ${signal.personB.name} are both connected to "${signal.shared}". Facts: ${signal.facts.join("; ") || "none"}. Write a 'connector': a short ready-to-send intro explaining why they should meet.`;
  }
}
