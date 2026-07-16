import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AiAdapter,
  AssistContextPerson,
  AssistOutput,
  BriefContent,
  BriefInput,
  BuiltCard,
  type CaptureImage,
  ExtractionResult,
  FactConflict,
  FactRef,
  ResearchBrief,
  sanitizeBriefs,
  sanitizeConflicts,
  Signal,
} from "./types";
import {
  AdapterError,
  type ClaudeEnvelope,
  classifyEnvelope,
  isGlobalFaultText,
  QuotaExhaustedError,
  quotaBlock,
  tripQuotaBreaker,
} from "./quota";

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

// Spawn one CLI run. Resolves with whatever came back on stdout plus the exec
// error, if any — deciding what that MEANS is classifyEnvelope's job, not this
// function's. The old code made that judgement here and got it wrong: it treated
// "exited non-zero but printed something" as success, which is exactly how a
// four-day quota outage came out the other end as a JSON parse error.
function spawnClaude(
  prompt: string,
  extraArgs: string[],
): Promise<{ stdout: string; stderr: string; err: Error | null }> {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "json", ...extraArgs];
    if (MODEL) args.push("--model", MODEL);
    // stderr is kept because it is where a logged-out or missing CLI says so, and
    // that is exactly the difference between "park this note" and "destroy it".
    execFile(BIN, args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", err: err ?? null });
    });
  });
}

/**
 * Decide whether a failed spawn is the ENGINE being broken, from the process's own
 * evidence ONLY: its exit code and its stderr.
 *
 * `err.message` is deliberately excluded, and that exclusion is the whole point.
 * Node builds it by echoing the command line back — "Command failed: claude -p
 * <THE ENTIRE PROMPT> --output-format json" — so the owner's note and the person's
 * facts end up inside it. Matching fault words against that string means the NOTE
 * decides how the failure is handled: "Meeting with Sam moved to room 401" matched
 * \b401\b, "Tom is sending the API credentials" matched credentials, a link ending
 * in /login matched too. Each one would park a perfectly ordinary note for ten days
 * and log it as "AI engine unavailable" while the disk and token were fine. Same
 * reason stdout is excluded: it is the model's own text.
 *
 * stderr and the exit code are the CLI talking about itself, and nothing else.
 */
export function isGlobalFault(err: Error, stderr: string): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  // A missing binary reports ENOENT on the code; its message would leak the prompt.
  if (code && /^(ENOENT|EACCES)$/.test(code)) return true;
  return isGlobalFaultText(stderr);
}

function runClaude(prompt: string, extraArgs: string[] = []): Promise<string> {
  return enqueue(async () => {
    // Check the breaker INSIDE the queue slot, not before enqueuing: calls that
    // lined up behind a run that then tripped it must see the trip, or the first
    // wave after a limit still spawns a process each.
    const blocked = quotaBlock();
    if (blocked) {
      // Retry the off-app alert from here too, not only from the trip below. This
      // path is the ONLY one a call takes once the breaker is open, so if the first
      // announce failed (a Telegram blip at the exact moment the limit hit) there is
      // otherwise no second chance until the breaker self-clears — and for the dated
      // wording, which is the common one, that is DAYS away. One blip would buy the
      // same silence this whole run exists to delete. The kv marker makes it a
      // no-op once a message has actually landed.
      void announceQuotaPause(blocked.raw, blocked.resetAt, blocked.resetParsed);
      throw new QuotaExhaustedError(blocked.raw, blocked.resetAt, blocked.resetParsed);
    }

    const { stdout, stderr, err } = await spawnClaude(prompt, extraArgs);

    // Nothing at all came back: the binary is missing, not logged in, or it was
    // killed (the 120s timeout). No envelope to reason about — so read the wording.
    // A logged-out CLI exits 1 with stderr only and no envelope at all, which is the
    // SAME real-world fault as the 401 that does arrive wrapped in one. Getting this
    // wrong destroys notes: the shape with an envelope was parked while this shape
    // burned its eight tries and marked the note permanently failed, so logging back
    // in would not bring it back. A timeout is deliberately NOT global: the model may
    // well have been running, so that stays a per-request failure.
    if (err && !stdout.trim()) {
      throw new AdapterError(
        `${err.message}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""} (is the Claude CLI installed and logged in?)`,
        isGlobalFault(err, stderr),
      );
    }

    // `--output-format json` wraps the answer in {type:"result", result:"...", usage:{...}}.
    let env: ClaudeEnvelope | null = null;
    try {
      env = JSON.parse(stdout) as ClaudeEnvelope;
    } catch {
      env = null; // an older CLI, or a truncated write: classify on the raw text
    }

    // Exited badly AND produced no readable envelope: that is a killed or truncated
    // run (the 120s timeout, a 16MB maxBuffer overflow), not an answer. Say what
    // actually happened. Letting it through would report a dead process as a
    // successful generation and then fail downstream as "no JSON object", which is
    // precisely the misdiagnosis that hid the July outage for four days.
    if (err && !env) {
      throw new AdapterError(
        `${err.message} (partial output: ${stdout.trim().slice(0, 200)})`,
        isGlobalFault(err, stderr),
      );
    }

    const c = classifyEnvelope(env, stdout, Date.now());
    if (c.kind === "quota") {
      // Trip first, THEN notify, and only on the transition: the whole point is
      // that the next 576 calls do not each rediscover this.
      if (tripQuotaBreaker(c.raw, c.resetAt, c.resetParsed)) void announceQuotaPause(c.raw, c.resetAt, c.resetParsed);
      throw new QuotaExhaustedError(c.raw, c.resetAt, c.resetParsed);
    }
    if (c.kind === "error") {
      throw new AdapterError(err ? `${c.raw} (exit: ${err.message})` : c.raw, c.global);
    }
    // A real generation got through. If we told the owner the brain was parked,
    // tell him it is back — keyed off an actual success, not merely the clock
    // passing the reset time, because the reset time is sometimes a guess.
    void announceQuotaResumed();
    return c.text;
  });
}

// Tell the owner once, off-app, that the engine is parked — the gap this whole
// run exists to close (last time he had no signal for 4.6 days). Imported lazily
// and never awaited: a Telegram outage must not take the AI path down with it,
// and this module is on the import path of every adapter call.
async function announceQuotaPause(raw: string, resetAt: Date, resetParsed: boolean): Promise<void> {
  try {
    const { notifyQuotaPaused } = await import("@/lib/nightshift/quota-alert");
    await notifyQuotaPaused(raw, resetAt, resetParsed);
  } catch (e) {
    console.error(`<3>[quota] could not announce pause: ${(e as Error).message}`);
  }
}

async function announceQuotaResumed(): Promise<void> {
  try {
    const { notifyQuotaResumed } = await import("@/lib/nightshift/quota-alert");
    await notifyQuotaResumed();
  } catch (e) {
    console.error(`<3>[quota] could not announce resume: ${(e as Error).message}`);
  }
}

// Browser media type -> file extension, so the temp file the CLI reads has an
// extension its Read tool recognizes. iOS Safari uploads photos as image/jpeg;
// screenshots are usually image/png. Unknown/absent falls back to png.
function extForMedia(mediaType?: string): string {
  switch ((mediaType || "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
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

  async extract(input: {
    text: string;
    today: string;
    existingNames: string[];
    images?: CaptureImage[];
  }): Promise<ExtractionResult> {
    const images = input.images ?? [];
    // Shared extraction instructions, reused by the text and photo paths.
    const instructions = [
      "You are the memory engine for Membro, a personal CRM for one busy professional.",
      "Extract the PEOPLE mentioned and the durable facts about each. One note can mention several people; split it and route each fragment to the right person.",
      `Today is ${input.today}; resolve relative dates to absolute ISO datetimes in due_at.`,
      "Fact kinds: 'commitment' = a promise in EITHER direction (the note-taker owes someone, or someone owes the note-taker); 'date' = a one-off dated event; 'preference' = how the person likes things; 'fact' = anything else.",
      "For a commitment set owed_by: 'me' when the note-taker owes it (\"I'll send the deck\"), 'them' when the other person owes the note-taker (\"he will send me the contract\", \"waiting on Tom for the review\"). When unsure, use 'me' (never invent a debt owed to the note-taker).",
      "Set birthday only when explicitly mentioned. confidence is 0..1 (lower when a name could collide with someone already known).",
      input.existingNames.length ? `Already on file: ${input.existingNames.join(", ")}.` : "No people on file yet.",
      'Output ONLY a JSON object, no prose, of shape: {"entities":[{"name":string,"company":string|null,"role":string|null,"blurb":string|null,"birthday":string|null,"confidence":number,"facts":[{"kind":"fact"|"date"|"commitment"|"preference","content":string,"due_at":string|null,"owed_by":"me"|"them"}]}]}.',
    ];

    // Photo capture: the CLI can't take an inline base64 image, but it CAN read an
    // image file with its Read tool. Write each photo to a temp file, point the run
    // at them (pre-approving Read and whitelisting the temp dir so there is no
    // permission prompt in -p mode), then clean up. This is what makes snapping a
    // photo of an email actually file people and facts instead of silently nothing.
    // Several photos = one long item shot across pages; the CLI reads them all and
    // reconstructs the order from their content.
    if (images.length) {
      const dir = tmpdir(); // one dir for every page, so a single --add-dir covers them
      const paths: string[] = [];
      try {
        for (const img of images) {
          const path = join(dir, `membro-capture-${randomUUID()}.${extForMedia(img.mediaType)}`);
          await writeFile(path, Buffer.from(img.base64, "base64"));
          paths.push(path);
        }
        const many = paths.length > 1;
        const prompt = [
          ...instructions,
          "",
          many
            ? `The note is ${paths.length} PHOTOS of ONE longer item (e.g. a multi-page email or a long message), listed below possibly OUT OF ORDER. Use your Read tool to open EVERY image, work out the correct reading order from their content (page numbers, a greeting then a sign-off, sentences that carry across pages), then read them as one continuous document and extract the people and facts from the whole thing. Do not treat the photos as separate notes.`
            : "The note is a PHOTO — a screenshot or an email. Use your Read tool to open the image file at the path below, then extract the people and facts from what it shows.",
          input.text.trim() ? `The owner also typed this alongside the photo(s) (use it as context):\n${input.text}` : "",
          "",
          many
            ? `IMAGE PATHS (upload order, may not be the reading order):\n${paths.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
            : `IMAGE PATH: ${paths[0]}`,
        ]
          .filter(Boolean)
          .join("\n");
        return parseJsonObject<ExtractionResult>(
          await runClaude(prompt, ["--allowedTools", "Read", "--add-dir", dir]),
        );
      } finally {
        await Promise.all(paths.map((p) => unlink(p).catch(() => {}))); // never leave photos on disk
      }
    }

    const prompt = [...instructions, "", `NOTE:\n${input.text}`].join("\n");
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

  async detectConflicts(input: {
    personName: string;
    newFacts: FactRef[];
    existingFacts: FactRef[];
    today: string;
  }): Promise<FactConflict[]> {
    if (!input.newFacts.length || !input.existingFacts.length) return [];
    const prompt = [
      "You are Membro's Ledger member. The owner just filed new facts about a person. Find ONLY the cases where a NEW fact ACTIVELY contradicts an existing one, so an old note is no longer true.",
      "A contradiction means the new statement negates or replaces the old (\"prefers tea\" then \"can't stand tea now, only coffee\"; \"vegetarian\" then \"back on steak\"). It is NOT a contradiction when the new fact merely ADDS information, covers a DIFFERENT attribute, or when both can be true at once (liking tea AND owning an espresso machine). A plain change over time that is already self-explanatory (\"left Acme, now at Globex\") is an update, not a collision to raise. When unsure, do NOT flag it: a wrong flag is worse than a missed one.",
      "Compare each NEW fact against the EXISTING facts. Use the exact ids given in brackets.",
      `Today is ${input.today}. Person: ${input.personName}.`,
      `NEW facts:\n${input.newFacts.map((f) => `- [${f.id}] ${f.content}`).join("\n")}`,
      `EXISTING facts:\n${input.existingFacts.map((f) => `- [${f.id}] ${f.content}`).join("\n")}`,
      'Output ONLY a JSON object: {"conflicts":[{"newFactId":string,"oldFactId":string,"reason":string}]}. reason is one short, non-accusatory line. Return an empty array if there are no real contradictions.',
    ].join("\n");
    const parsed = parseJsonObject<{ conflicts?: FactConflict[] }>(await runClaude(prompt));
    return sanitizeConflicts(parsed.conflicts, input.newFacts, input.existingFacts);
  }

  async research(input: { note: string; today: string; knownSubjects: string[] }): Promise<ResearchBrief[]> {
    if (!input.note.trim()) return [];
    const known = input.knownSubjects.length ? input.knownSubjects.join(", ") : "(nothing on file yet)";
    const prompt = [
      "You are Membro's Researcher, one of a small crew that reads every note the owner captures. If the note names a company, organization, product, or topic the owner has NEVER logged and that is genuinely worth knowing, web-search it and leave ONE short, current brief.",
      "Each brief must carry one concrete, CURRENT fact (recent funding, a leadership change, a launch, a notable recent event) plus a one-line tie-back to why it matters right now given what the note says. Never write founding-year filler, mission-statement language, or an About-page paragraph. Keep each body to 2-4 plain sentences, the owner's voice, no em-dashes.",
      "Stay SILENT (empty list) for household names the owner obviously knows, anything already on file, an ambiguous or joking mention, or when the search turns up nothing substantive. A missing brief is fine; a filler brief is not.",
      `Today is ${input.today}. Already on file, do NOT brief these: ${known}.`,
      `NOTE:\n${input.note}`,
      'Output ONLY a JSON object: {"briefs":[{"subject":string,"body":string,"why":string}]}. Empty array if nothing is worth briefing.',
    ].join("\n");
    // WebSearch is what makes the brief current; runClaude still returns the final
    // JSON message, which parseJsonObject pulls out of any surrounding prose.
    const parsed = parseJsonObject<{ briefs?: ResearchBrief[] }>(
      await runClaude(prompt, ["--allowedTools", "WebSearch"]),
    );
    return sanitizeBriefs(parsed.briefs, input.knownSubjects);
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
