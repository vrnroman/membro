import type { PersonRow, FactRow } from "./scout";
import { scout, isActionSignal, type ActionSignal } from "./scout";

// The morning nudge: the one time Membro reaches out to the owner off-app instead
// of waiting for them to open it. Pure and deterministic (no AI, no network) like
// the Scout it builds on: it filters the Scout's *action* signals down to the few
// that are due today or tomorrow, then renders them as one flat message. Overdue
// and further-out items are deliberately left out (Today already shows those).

export type NudgeItem = {
  type: ActionSignal["type"]; // meeting | commitment | dated | birthday
  daysUntil: 0 | 1; // 0 = today, 1 = tomorrow
  text: string; // the finished, flat clause for this item
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
  const signals = scout(people, facts, today, 1000).filter(isActionSignal);

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
    items.push({ type: s.type, daysUntil: d, text: clauseFor(s, d) });
  }

  return items.sort((a, b) => a.daysUntil - b.daysUntil || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
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
// scan than a run-on line), most urgent first, no header or sign-off. With
// nothing due, returns the all-clear line when notifyWhenEmpty is set, otherwise
// null so the caller sends nothing at all.
export function formatNudge(items: NudgeItem[], opts: { notifyWhenEmpty?: boolean } = {}): string | null {
  if (items.length === 0) return opts.notifyWhenEmpty ? ALL_CLEAR : null;

  const bullets = items.map((i) => `• ${i.text}`);
  const kept: string[] = [];
  for (let i = 0; i < bullets.length; i++) {
    const remaining = bullets.length - (i + 1);
    const tail = remaining > 0 ? `\n• (+${remaining} more)` : "";
    const projected = [...kept, bullets[i]].join("\n").length + tail.length;
    if (projected > SAFE_LIMIT && kept.length > 0) {
      kept.push(`• (+${bullets.length - i} more)`);
      return kept.join("\n");
    }
    kept.push(bullets[i]);
  }

  const msg = kept.join("\n");
  // Safety net for a single pathological bullet that alone exceeds the hard limit.
  return msg.length > TELEGRAM_LIMIT ? msg.slice(0, TELEGRAM_LIMIT - 3) + "..." : msg;
}
