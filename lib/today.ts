// The owner's local calendar date is the ONE notion of "today" across the app.
// Membro is single-user in a single timezone, so "today"/"tomorrow" everywhere
// (the nudge, the Today screen, capture's relative-date resolution) must mean the
// OWNER's day, not the server's UTC. Before this, the nudge used the owner's zone
// while capture and the UI used UTC, so a note captured around local midnight
// could be filed and nudged on the wrong day.
//
// MEMBRO_TZ overrides the default on the server. The browser cannot read it, so it
// falls back to the same default, which is correct for a fixed single-user zone.

const DEFAULT_TZ = "Asia/Singapore";

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}

let _tz: string | null = null;

// The configured owner timezone, validated once. A missing, blank, or invalid
// MEMBRO_TZ (including a stray trailing space/newline from an env file) degrades
// to the default instead of throwing a RangeError deep in a request.
export function ownerTz(): string {
  if (_tz) return _tz;
  const raw = ((typeof process !== "undefined" && process.env && process.env.MEMBRO_TZ) || DEFAULT_TZ).toString().trim();
  const candidate = raw || DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate });
    _tz = candidate;
  } catch {
    _tz = DEFAULT_TZ;
  }
  return _tz;
}

// The owner-local calendar date (YYYY-MM-DD) for an instant, default now.
export function localToday(tz: string = ownerTz()): string {
  return fmt(tz).format(new Date());
}

// Reduce an ISO datetime to the owner-local calendar date, or null if it cannot
// be parsed. Using the full instant (not a UTC substring) means an evening event
// is bucketed on the day the owner actually experiences it.
export function isoToLocalDate(iso: string, tz: string = ownerTz()): string | null {
  // A bare calendar date ("YYYY-MM-DD") is ALREADY an owner-local day (that is how
  // callers pass "today"). Return it as-is: routing it through Date.parse would
  // read it as UTC midnight and roll it back a day in a west-of-UTC zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return fmt(tz).format(new Date(ms));
}
