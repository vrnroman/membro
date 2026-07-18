import { NextResponse } from "next/server";
import { fileNote, type CaptureInput } from "@/lib/capture";
import {
  getCapture,
  deleteFactsForCapture,
  deleteAssistsForCapture,
  deleteDiaryForCapture,
  deleteCaptureConnectorsForCapture,
  deleteCapture,
  pruneEmptyPeople,
} from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Edit-and-reprocess a captured note. The Notes inbox sends the corrected text; we
// re-run the exact same capture core on it, reusing this note so the old facts it
// filed are replaced (not duplicated) and a mis-heard name is cleaned up. The whole
// re-extraction is the AI's, so this can 502 like the first capture did.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cap = getCapture(id);
  if (!cap) return NextResponse.json({ error: "no such note" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "note text is required" }, { status: 400 });

  try {
    const result = await fileNote(
      { text, sourceType: cap.source_type as CaptureInput["sourceType"] },
      { captureId: id },
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: `reprocess failed: ${(e as Error).message}` }, { status: 502 });
  }
}

// Delete a note and everything it filed: its facts (and single-source cards), its
// crew output (drafts / diary), any person it created who is then left with nothing,
// and the note row itself.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const affected = deleteFactsForCapture(id);
  deleteAssistsForCapture(id);
  deleteDiaryForCapture(id);
  deleteCaptureConnectorsForCapture(id); // capture connectors are spared the nightly wipe, so clean them here
  deleteCapture(id);
  const removedPeople = pruneEmptyPeople(affected);
  return NextResponse.json({ ok: true, removedPeople });
}
