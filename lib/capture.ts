import {
  listPeopleIdName,
  insertCapture,
  insertPerson,
  updatePerson,
  insertFact,
  updateCaptureBody,
  deleteFactsForCapture,
  deleteAssistsForCapture,
  deleteDiaryForCapture,
  pruneEmptyPeople,
} from "@/lib/repo";
import { getAdapter } from "@/lib/ai";
import { ExtractedEntity } from "@/lib/ai/types";
import { enqueueAssistJob, type CrewFacts } from "@/lib/assist/queue";
import { localToday } from "@/lib/today";

// The capture core: turn a note (typed, transcribed voice, or a photo) into
// people + facts on file. Lives here — not in the route — so the /api/capture
// handler and the background voice worker file notes through exactly the same
// path. Nothing here touches HTTP.

const CONFIDENCE_GATE = 0.7; // Silent Land: above this, facts land without asking.

export type CaptureResult = {
  landed: { person: string; created: boolean; facts: number }[];
  ambiguous: { name: string; reason: string }[];
  adapter: string;
  // The note this filed under. Returned so the Notes inbox can reconcile a
  // reprocess in place without a refetch.
  captureId: string;
  // People dropped because a reprocess re-filed the note onto a corrected name and
  // left them with nothing (the mis-heard contact). Empty on a first capture.
  removedPeople?: string[];
};

export type CaptureInput = {
  text: string;
  sourceType: "text" | "voice" | "photo";
  imageBase64?: string;
  imageMediaType?: string;
};

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

/**
 * Extract entities from the note and file them. Throws if the AI extraction
 * itself fails (the caller decides whether to retry); individual bad people or
 * facts are skipped without failing the whole note.
 */
export async function fileNote(input: CaptureInput, opts?: { captureId?: string }): Promise<CaptureResult> {
  const { text = "", sourceType = "text", imageBase64, imageMediaType } = input;
  const reprocessId = opts?.captureId;

  const today = localToday();
  const adapter = getAdapter();

  const people: PersonName[] = listPeopleIdName();

  const extraction = await adapter.extract({
    text,
    today,
    existingNames: people.map((p) => p.name),
    imageBase64,
    imageMediaType,
  });

  // First capture: keep the raw input for audit / show-the-work. Reprocess (the
  // Notes inbox saved an edit): reuse the same note so its lineage is stable, point
  // it at the corrected text, and clear what the old text filed — the facts (any
  // orphaned people are pruned once the new ones land), and this note's prior crew
  // output (drafts / diary) — before re-extracting below.
  let captureId: string;
  let reprocessedPeople: string[] = [];
  if (reprocessId) {
    captureId = reprocessId;
    updateCaptureBody(captureId, text || "(image)");
    reprocessedPeople = deleteFactsForCapture(captureId);
    deleteAssistsForCapture(captureId);
    deleteDiaryForCapture(captureId);
  } else {
    captureId = insertCapture(text || "(image)", sourceType);
  }

  const landed: CaptureResult["landed"] = [];
  const ambiguous: CaptureResult["ambiguous"] = [];
  // The facts this note filed, per person, so the crew's Ledger member can check
  // them against what was already on file. Accumulated across the loop, then handed
  // to the queue once at the end.
  const crewByPerson = new Map<string, string[]>();

  for (const entity of extraction.entities) {
    if (entity.confidence < CONFIDENCE_GATE) {
      ambiguous.push({ name: entity.name, reason: "Not sure who this is — confirm to file it." });
      continue;
    }

    let person = matchPerson(entity, people);
    let created = false;

    if (!person) {
      const matches = people.filter(
        (p) => p.name.trim().toLowerCase().split(" ")[0] === entity.name.trim().toLowerCase().split(" ")[0],
      );
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
      // Touch last_contact and fill in any blanks we just learned. Guarded so a
      // transient write error here (e.g. a busy DB) never aborts the whole loop and
      // skips the crew enqueue at the end; the facts still land below.
      try {
        const patch: Record<string, unknown> = { last_contact_at: new Date().toISOString() };
        if (entity.company) patch.company = entity.company;
        if (entity.role) patch.role = entity.role;
        if (entity.blurb) patch.blurb = entity.blurb;
        const birthday = normalizeBirthday(entity.birthday, today);
        if (birthday) patch.birthday = birthday;
        updatePerson(person.id, patch);
      } catch {
        /* keep filing facts + enqueue the crew even if the profile touch fails */
      }
    }

    let factCount = 0;
    for (const f of entity.facts) {
      try {
        const factId = insertFact({
          person_id: person.id,
          kind: f.kind,
          content: f.content,
          due_at: f.due_at ?? null,
          owed_by: f.kind === "commitment" ? f.owed_by ?? "me" : "me",
          confidence: entity.confidence,
          capture_id: captureId,
        });
        factCount++;
        const ids = crewByPerson.get(person.id) ?? [];
        ids.push(factId);
        crewByPerson.set(person.id, ids);
      } catch {
        /* skip a single bad fact, keep the rest */
      }
    }

    landed.push({ person: person.name, created, facts: factCount });
  }

  // Hand the note to the per-note crew once, after the facts have landed. The crew
  // drafts / advises / diaries the text (a note is saved regardless), the Researcher
  // web-searches any new company it names, and the Ledger member checks the facts
  // just filed for contradictions. Enqueued whenever there is text OR facts to
  // check, so a photo-only note still gets the Ledger pass. Best-effort: a queue
  // hiccup never blocks a capture from landing.
  const crewFacts: CrewFacts[] = [...crewByPerson.entries()].map(([personId, factIds]) => ({ personId, factIds }));
  if (text.trim() || crewFacts.length) {
    try {
      enqueueAssistJob({ captureId, note: text.trim(), firstAttemptAt: new Date().toISOString(), crewFacts });
    } catch {
      /* never let the crew queue block a capture from landing */
    }
  }

  // Reprocess only: now that the corrected facts have landed, drop any person the
  // old text created who is left with nothing (the mis-heard name). Anyone re-filed
  // onto still holds facts, so they are spared.
  const removedPeople = reprocessId ? pruneEmptyPeople(reprocessedPeople) : [];

  return { landed, ambiguous, adapter: adapter.label, captureId, removedPeople };
}
