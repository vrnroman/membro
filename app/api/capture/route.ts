import { NextResponse } from "next/server";
import {
  listPeopleIdName,
  insertCapture,
  insertPerson,
  updatePerson,
  insertFact,
} from "@/lib/repo";
import { getAdapter } from "@/lib/ai";
import { ExtractedEntity } from "@/lib/ai/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CONFIDENCE_GATE = 0.7; // Silent Land: above this, facts land without asking.

type PersonName = { id: string; name: string };

function matchPerson(entity: ExtractedEntity, people: PersonName[]): PersonName | null {
  const name = entity.name.trim().toLowerCase();
  const exact = people.filter((p) => p.name.trim().toLowerCase() === name);
  if (exact.length === 1) return exact[0];
  // Only fall back to first-name matching for a bare single-token name ("Tom").
  // A name with a surname ("Tom Cruise") must match exactly, or it would be
  // misrouted onto an unrelated existing "Tom".
  if (name.split(/\s+/).length > 1) return null;
  const byFirst = people.filter((p) => p.name.trim().toLowerCase().split(" ")[0] === name);
  if (byFirst.length === 1) return byFirst[0];
  return null; // 0 matches → new person; >1 → genuinely ambiguous
}

function normalizeBirthday(value: string | null | undefined, today: string): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (/^\d{2}-\d{2}$/.test(v)) return `${today.slice(0, 4)}-${v}`;
  return null;
}

export async function POST(req: Request) {
  const { text = "", sourceType = "text", imageBase64, imageMediaType } = await req.json().catch(() => ({}));
  if (!text && !imageBase64) return NextResponse.json({ error: "nothing to capture" }, { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  const adapter = getAdapter();

  const people: PersonName[] = listPeopleIdName();

  let extraction;
  try {
    extraction = await adapter.extract({ text, today, existingNames: people.map((p) => p.name), imageBase64, imageMediaType });
  } catch (e) {
    return NextResponse.json({ error: `extraction failed: ${(e as Error).message}` }, { status: 502 });
  }

  // Keep the raw input for audit / show-the-work.
  insertCapture(text || "(image)", sourceType);

  const landed: { person: string; created: boolean; facts: number }[] = [];
  const ambiguous: { name: string; reason: string }[] = [];

  for (const entity of extraction.entities) {
    if (entity.confidence < CONFIDENCE_GATE) {
      ambiguous.push({ name: entity.name, reason: "Not sure who this is — confirm to file it." });
      continue;
    }

    let person = matchPerson(entity, people);
    let created = false;

    if (!person) {
      const matches = people.filter((p) => p.name.trim().toLowerCase().split(" ")[0] === entity.name.trim().toLowerCase().split(" ")[0]);
      if (matches.length > 1) {
        ambiguous.push({ name: entity.name, reason: `Could be ${matches.map((m) => m.name).join(" or ")}.` });
        continue;
      }
      const birthday = normalizeBirthday(entity.birthday, today);
      try {
        person = insertPerson({
          name: entity.name,
          company: entity.company ?? null,
          role: entity.role ?? null,
          blurb: entity.blurb ?? null,
          birthday,
        });
      } catch {
        ambiguous.push({ name: entity.name, reason: "Could not save." });
        continue;
      }
      people.push(person);
      created = true;
    } else {
      // Touch last_contact and fill in any blanks we just learned.
      const patch: Record<string, unknown> = { last_contact_at: new Date().toISOString() };
      if (entity.company) patch.company = entity.company;
      if (entity.role) patch.role = entity.role;
      if (entity.blurb) patch.blurb = entity.blurb;
      const birthday = normalizeBirthday(entity.birthday, today);
      if (birthday) patch.birthday = birthday;
      updatePerson(person.id, patch);
    }

    let factCount = 0;
    for (const f of entity.facts) {
      try {
        insertFact({
          person_id: person.id,
          kind: f.kind,
          content: f.content,
          due_at: f.due_at ?? null,
          confidence: entity.confidence,
        });
        factCount++;
      } catch {
        /* skip a single bad fact, keep the rest */
      }
    }

    landed.push({ person: person.name, created, facts: factCount });
  }

  return NextResponse.json({ landed, ambiguous, adapter: adapter.label });
}
