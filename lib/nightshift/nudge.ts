import type { PersonRow, FactRow } from "./scout";
import { scout, isActionSignal, coolingThreshold, type ActionSignal } from "./scout";
import type { Signal } from "@/lib/ai/types";

// The morning nudge: the one time Membro reaches out to the owner off-app instead
// of waiting for them to open it. Pure and deterministic (no AI, no network) like
// the Scout it builds on: it filters the Scout's *action* signals down to the few
// that are due today or tomorrow, then renders them as one flat message. Overdue
// and further-out items are deliberately left out (Today already shows those).

export type NudgeItem = {
  type: ActionSignal["type"]; // meeting | commitment | dated | birthday
  daysUntil: 0 | 1; // 0 = today, 1 = tomorrow
  text: string; // the finished, flat clause for this item
  personId: string; // who it is about, so a warm-keep never double-names them
};

// The Scout labels a date "today"/"tomorrow"/"overdue"/"in N days" through one
// helper (meetingLabel). Reuse that single source of truth rather than forking a
// second date path: a signal is in the nudge window only if its label is exactly
// "today" or "tomorrow".
function labelDays(label: string | null): 0 | 1 | null {
  if (label === "today") return 0;
  if (label === "tomorrow") return 1;
  return null;
}

const whenWord = (d: 0 | 1) => (d === 0 ? "today" : "tomorrow");

// Flatten any interior newline/whitespace and trim, so one item is always one
// line (a fact typed across multiple lines must not break the bulleted layout).
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
// Drop trailing sentence punctuation so appending " today." / " (due today)."
// never doubles a period.
const stripEnd = (s: string) => clean(s).replace(/[.!?]+$/, "").trim();

// Turn one due action signal into its flat clause. The person's name carries the
// warmth (a promise, a birthday read human); deadlines stay purely functional.
// No wrapper, no label prefix, no exclamation: written the way the owner would.
function clauseFor(s: ActionSignal, d: 0 | 1): string {
  const when = whenWord(d);
  switch (s.type) {
    case "birthday":
      return `${clean(s.person.name)}'s birthday ${when}.`;
    case "meeting":
      return `You meet ${clean(s.person.name)} ${when}.`;
    case "dated":
      return `${stripEnd(s.event) || "A dated event"} ${when}.`;
    case "commitment":
      return `You promised ${clean(s.person.name)}: ${stripEnd(s.commitment) || "(unspecified)"} (due ${when}).`;
  }
}

// Rank for ordering the message: today before tomorrow, then most-urgent type
// first within a day (a meeting, a promise, a dated deadline, a birthday).
const TYPE_ORDER: Record<ActionSignal["type"], number> = {
  meeting: 0,
  commitment: 1,
  dated: 2,
  birthday: 3,
};

// The action items due today or tomorrow, most urgent first. `today` is the
// local calendar date the timer fires on (YYYY-MM-DD); the Scout compares by
// calendar date, so this stays in step with what the Today screen shows.
export function dueNudges(people: PersonRow[], facts: FactRow[], today: string): NudgeItem[] {
  // A high limit so the Scout returns every ripe signal, not just its top few;
  // we filter to the nudge window ourselves.
  return dueNudgesFromSignals(scout(people, facts, today, 1000).filter(isActionSignal));
}

// The signal-driven core, so callers that already ran the Scout (the route, which
// also needs the cold signals) do not pay for a second pass.
function dueNudgesFromSignals(signals: ActionSignal[]): NudgeItem[] {
  const items: NudgeItem[] = [];
  for (const s of signals) {
    let d: 0 | 1 | null = null;
    switch (s.type) {
      case "meeting":
        d = labelDays(s.whenLabel);
        break;
      case "commitment":
        d = labelDays(s.dueLabel); // undated promises have no dueLabel -> excluded
        break;
      case "dated":
        d = s.daysUntil === 0 || s.daysUntil === 1 ? (s.daysUntil as 0 | 1) : null;
        break;
      case "birthday":
        d = s.daysUntil === 0 || s.daysUntil === 1 ? (s.daysUntil as 0 | 1) : null;
        break;
    }
    if (d === null) continue;
    items.push({ type: s.type, daysUntil: d, text: clauseFor(s, d), personId: s.person.id });
  }

  return items.sort((a, b) => a.daysUntil - b.daysUntil || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
}

// Warm-Keeper's one line in the morning nudge. The Scout already flags cooling
// relationships against each person's OWN cadence; this picks the SINGLE most
// overdue-relative-to-their-rhythm and renders one warm, no-guilt teaser. Capped
// at one by construction (never a growing list of shame), it reaches out off-app
// the same way the due items do. The specific drafted opener waits in Suggestions;
// this is just the tap on the shoulder, so the nudge stays deterministic and free.
type ColdSignal = Extract<Signal, { type: "cold" }>;

function overdueRatio(c: ColdSignal): number {
  return c.daysSince / coolingThreshold(c.cadenceDays);
}

// A warm, human teaser — no "COOLING"/"AT RISK" label, no guilt, just a name and
// the gap. Names carry the warmth; the cadence, when known, makes it specific.
function warmKeepTeaser(c: ColdSignal): string {
  const name = clean(c.person.name);
  return c.cadenceDays
    ? `Worth a hello: ${name} (usually about every ${c.cadenceDays} days, quiet for ${c.daysSince}).`
    : `Worth a hello: ${name} (quiet for ${c.daysSince} days).`;
}

// The single most-worth-it warm-keep for today, or null when nothing is cooling.
// Deterministic: reuses the Scout (no AI, no cost) and picks the person furthest
// past their own quiet threshold. `excludeIds` drops anyone already named in the
// due items, so the same person is never nagged twice in one message.
export function topWarmKeep(
  people: PersonRow[],
  facts: FactRow[],
  today: string,
  excludeIds: Set<string> = new Set(),
): string | null {
  return topWarmKeepFromSignals(
    scout(people, facts, today, 1000).filter((s): s is ColdSignal => s.type === "cold"),
    excludeIds,
  );
}

function topWarmKeepFromSignals(colds: ColdSignal[], excludeIds: Set<string>): string | null {
  const eligible = colds.filter((c) => !excludeIds.has(c.person.id));
  if (eligible.length === 0) return null;
  let best = eligible[0];
  for (const c of eligible) {
    if (overdueRatio(c) > overdueRatio(best)) best = c;
  }
  return warmKeepTeaser(best);
}

// One Scout pass yields BOTH the due items and the warm-keep, deduped against each
// other, for the morning-nudge route. Kept separate from the granular functions so
// tests can still exercise each in isolation.
export function computeNudge(
  people: PersonRow[],
  facts: FactRow[],
  today: string,
): { items: NudgeItem[]; warmKeep: string | null } {
  const signals = scout(people, facts, today, 1000);
  const items = dueNudgesFromSignals(signals.filter(isActionSignal));
  const dueIds = new Set(items.map((i) => i.personId));
  const colds = signals.filter((s): s is ColdSignal => s.type === "cold");
  return { items, warmKeep: topWarmKeepFromSignals(colds, dueIds) };
}

// The all-clear line sent on a quiet day, so the owner can see the once-a-day
// service is still alive. Sent by default; once the nudge has earned trust, set
// MEMBRO_NUDGE_SILENT_WHEN_EMPTY=1 to go silent on empty days instead.
export const ALL_CLEAR = "Nothing due today or tomorrow.";

// Telegram rejects a sendMessage body over 4096 characters. Stay under that with
// headroom; if a rare busy day overflows, keep the most urgent bullets that fit
// and summarize the rest as one "(+N more)" line rather than failing the whole
// send (which, being recorded only on success, would otherwise recur every day).
const TELEGRAM_LIMIT = 4096;
const SAFE_LIMIT = 3900;

// The one message. Each due item is its own bullet on its own line (easier to
// scan than a run-on line), most urgent first, no header or sign-off, and one
// optional warm-keep line trailing after a blank line. With nothing due, sends
// just the warm-keep if there is one (still worth reaching out), else the
// all-clear when notifyWhenEmpty is set, else null so the caller sends nothing.
export function formatNudge(
  items: NudgeItem[],
  opts: { notifyWhenEmpty?: boolean; warmKeep?: string | null } = {},
): string | null {
  const warm = opts.warmKeep || null;

  if (items.length === 0) {
    // Honor the empty-day opt-out for the warm-keep too: someone who set
    // MEMBRO_NUDGE_SILENT_WHEN_EMPTY=1 asked for silence on quiet days, and a
    // warm-keep would fire on most days once cadence-cooling kicks in. When empty
    // nudges ARE on (the default), a warm-keep beats the bare all-clear line.
    if (!opts.notifyWhenEmpty) return null;
    return warm ? capTelegram(warm) : ALL_CLEAR;
  }

  // Budget the bullets against SAFE_LIMIT minus the warm-keep line, so appending
  // it can never push the total past the hard cap and get sliced mid-teaser.
  const warmCost = warm ? warm.length + 2 : 0; // +2 for the "\n\n" separator
  const bulletBudget = SAFE_LIMIT - warmCost;

  const bullets = items.map((i) => `• ${i.text}`);
  const kept: string[] = [];
  for (let i = 0; i < bullets.length; i++) {
    const remaining = bullets.length - (i + 1);
    const tail = remaining > 0 ? `\n• (+${remaining} more)` : "";
    const projected = [...kept, bullets[i]].join("\n").length + tail.length;
    if (projected > bulletBudget && kept.length > 0) {
      kept.push(`• (+${bullets.length - i} more)`);
      break; // fall through to the hard-limit safety net below, not an early return
    }
    kept.push(bullets[i]);
  }

  const msg = warm ? `${kept.join("\n")}\n\n${warm}` : kept.join("\n");
  return capTelegram(msg);
}

// Hard safety net covering every path (incl. a single pathological bullet that
// alone exceeds the limit): the returned message is never over 4096.
function capTelegram(msg: string): string {
  return msg.length > TELEGRAM_LIMIT ? msg.slice(0, TELEGRAM_LIMIT - 3) + "..." : msg;
}
