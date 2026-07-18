import { NextResponse } from "next/server";
import { listPeople, listFacts, deletePendingCards, insertCards, connectorCoversPair } from "@/lib/repo";
import { getAdapter } from "@/lib/ai";
import { scout, isIdeaSignal } from "@/lib/nightshift/scout";
import { Signal } from "@/lib/ai/types";
import { localToday } from "@/lib/today";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function personIdForSignal(signal: Signal): string {
  return signal.type === "connector" ? signal.personA.id : signal.person.id;
}
function metaForSignal(signal: Signal): Record<string, unknown> {
  if (signal.type === "connector")
    return {
      personIds: [signal.personA.id, signal.personB.id],
      shared: signal.shared,
      // pairKey + topics let the capture-time Connector and this pass dedup against
      // each other (a spared capture card must not get a duplicate here). topics is an
      // array for the same membership test the capture side uses, even though the
      // nightly signal carries a single shared topic.
      pairKey: [signal.personA.id, signal.personB.id].sort().join("|"),
      topics: [signal.shared],
      topic: signal.shared,
    };
  // A commitment card is caused by one specific fact — record it so deleting
  // that fact also removes this card (see deleteFact in lib/repo).
  if (signal.type === "commitment" && signal.factId) return { signal: signal.type, source_fact_id: signal.factId };
  return { signal: signal.type };
}

export async function POST() {
  const people = listPeople();
  const facts = listFacts();

  const today = localToday();
  // The night shift only drafts the speculative outreach (intros, reconnects).
  // Certain items (commitments, meetings, birthdays, dated events) are handled
  // as Action items on Today, so drafting them here would just duplicate them.
  const signals = scout(people, facts, today, 100).filter(isIdeaSignal);

  const adapter = getAdapter();

  // Builder: turn each ripe signal into a finished card (concurrently).
  const cards = await Promise.all(
    signals.map(async (signal) => {
      // Skip a connector pair only when a card the wipe will KEEP already covers this
      // topic: a capture-time card (any status), or a card the owner already acted on
      // (approved / skipped). Crucially do NOT skip on this pass's OWN pending nightly
      // cards — those get wiped and rebuilt every run, so matching them would skip the
      // rebuild and then delete the card, making a stable intro flicker out on
      // alternate nights.
      if (signal.type === "connector") {
        const a = signal.personA.id;
        const b = signal.personB.id;
        const covered =
          connectorCoversPair(a, b, { topic: signal.shared, sources: ["capture"] }) ||
          connectorCoversPair(a, b, { topic: signal.shared, statuses: ["approved", "skipped"] });
        if (covered) return null;
      }
      try {
        const card = await adapter.buildCard(signal, today);
        return {
          person_id: personIdForSignal(signal),
          kind: card.kind,
          title: card.title,
          body: card.body,
          why: card.why,
          meta: metaForSignal(signal),
        };
      } catch {
        return null;
      }
    }),
  );
  const fresh = cards.filter(Boolean) as NonNullable<(typeof cards)[number]>[];

  // The Stack shows the latest run: clear old pending cards, then file the new
  // ones. Only replace when we actually have cards to show, OR when nothing is
  // ripe (a legitimate empty result) — so a run where every Builder call failed
  // doesn't silently wipe the existing stack.
  if (fresh.length > 0 || signals.length === 0) {
    deletePendingCards();
    if (fresh.length > 0) {
      try {
        insertCards(fresh);
      } catch (e) {
        return NextResponse.json({ error: `could not save cards: ${(e as Error).message}` }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ built: fresh.length, signals: signals.length, adapter: adapter.label });
}
