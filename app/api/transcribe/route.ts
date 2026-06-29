import { NextResponse } from "next/server";
import { listPeopleIdName } from "@/lib/repo";
import { transcribeAudio } from "@/lib/ai/transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Voice note -> clean text. Gemini transcribes (primed with the names already on
// file); the text then goes back to the capture box for the owner to review
// before it ever reaches Claude / the database. Nothing is written here.
export async function POST(req: Request) {
  let body: { audioBase64?: string; mimeType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const audioBase64 = body.audioBase64;
  if (!audioBase64) {
    return NextResponse.json({ error: "no audio" }, { status: 400 });
  }

  try {
    const names = listPeopleIdName().map((p) => p.name);
    const { text, model } = await transcribeAudio({
      audioBase64,
      mimeType: body.mimeType || "audio/mp4",
      names,
    });
    return NextResponse.json({ text, model });
  } catch (e) {
    const message = (e as Error).message || "transcription failed";
    // 502: the upstream (Gemini) failed; the client keeps the audio for a retry.
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
