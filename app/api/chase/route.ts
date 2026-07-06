import { NextResponse } from "next/server";
import { getFact, getPerson, listFactContents, replaceChaseCard } from "@/lib/repo";
import { getAdapter } from "@/lib/ai";
import type { Signal } from "@/lib/ai/types";
import { localToday } from "@/lib/today";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Draft a friendly reminder for a "they owe me" item (the Ledger's chase). Builds
// one card via the Builder, persists it review-only (rerun-safe: a re-tap replaces
// the prior draft), and returns the drafted text so the Ledger can show it inline.
// Nothing is ever sent; the owner approves, copies, or edits it themselves.
export async function POST(req: Request) {
  const { factId } = await req.json().catch(() => ({}));
  if (!factId) return NextResponse.json({ error: "factId required" }, { status: 400 });

  const fact = getFact(factId);
  if (!fact) return NextResponse.json({ error: "fact not found" }, { status: 404 });
  if (fact.kind !== "commitment" || fact.owed_by !== "them") {
    return NextResponse.json({ error: "chase only applies to a they-owe-me commitment" }, { status: 400 });
  }
  const person = getPerson(fact.person_id);
  if (!person) return NextResponse.json({ error: "person not found" }, { status: 404 });

  const today = localToday();
  const signal: Signal = {
    type: "chase",
    person: { id: person.id, name: person.name, company: person.company, role: person.role, blurb: person.blurb },
    item: fact.content,
    dueLabel: null, // timing stays out of the prompt so the draft never reads as chasing
    facts: listFactContents(person.id).slice(0, 4),
    factId,
  };

  const adapter = getAdapter();
  try {
    const card = await adapter.buildCard(signal, today);
    const id = replaceChaseCard({ person_id: person.id, factId, title: card.title, body: card.body, why: card.why });
    // Return the persisted card so the Ledger can review it inline with the same
    // approve / copy / edit / skip affordances as Suggestions (where it also lives).
    return NextResponse.json({
      card: { id, kind: "nudge", title: card.title, body: card.body, why: card.why, status: "pending" },
      adapter: adapter.label,
    });
  } catch (e) {
    return NextResponse.json({ error: `chase failed: ${(e as Error).message}` }, { status: 502 });
  }
}
