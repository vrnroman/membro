// The one definition of "what is this person about" and "do two people share a
// topic," used by BOTH the nightly Scout connector and the capture-time Connector.
// Lifted out of scout.ts so the two passes can never drift on what counts as a
// shared interest. Deliberately crude (capitalized tokens minus a stop list): good
// enough for a first-pass pre-filter, and the real "should these two meet" judgment
// is made downstream by the model, not here.

// Minimal shapes so this module has no dependency on scout's row types (which import
// it), and so a caller can pass either a full person row or the lighter capture-time
// view.
export type TopicPerson = { name: string; company?: string | null; blurb?: string | null };
export type TopicFact = { content: string };

const TOPIC_STOP = new Set([
  "got", "moving", "mentioned", "promised", "started", "wants", "spent", "just", "her", "his",
  "they", "next", "this", "that", "with", "from", "into", "before", "after", "really", "very",
]);

/**
 * The topics a person is "about": capitalized words (4+ letters) from their company,
 * blurb, and facts, minus their own name and a small stop list. Optionally scoped to
 * a subset of facts, which is how the capture-time pass asks "what does THIS new fact
 * bring up" rather than the person's whole history.
 */
export function topicsOf(person: TopicPerson, facts: TopicFact[]): Set<string> {
  const own = new Set(person.name.toLowerCase().split(/\s+/));
  const out = new Set<string>();
  const haystack = [person.company || "", person.blurb || "", ...facts.map((f) => f.content)].join(" ");
  for (const m of haystack.matchAll(/\b([A-Z][A-Za-z]{3,})\b/g)) {
    const tok = m[1];
    const low = tok.toLowerCase();
    if (own.has(low) || TOPIC_STOP.has(low)) continue;
    out.add(tok);
  }
  return out;
}

/** The topics two people share, most-specific-first is not implied — just the set. */
export function sharedTopics(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const t of a) if (b.has(t)) out.push(t);
  return out;
}

/** A stable, order-independent key for a pair of people (for dedup and pair-memory). */
export function pairKey(idA: string, idB: string): string {
  return [idA, idB].sort().join("|");
}
