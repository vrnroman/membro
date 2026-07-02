import { NextResponse } from "next/server";
import { listPeopleIdName } from "@/lib/repo";
import { transcribeAudio, TranscribeError } from "@/lib/ai/transcribe";
import { fileNote } from "@/lib/capture";
import { enqueueVoiceJob } from "@/lib/voice/queue";
import { INLINE_ATTEMPTS, inlineBackoffMs, BG_FIRST_DELAY_MS, sleep } from "@/lib/voice/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One action: transcribe the voice note AND file it, no read-and-confirm step.
//
// Gemini gets rate-limited ("too many requests") under load. So we try a few
// times right here (a couple of seconds — clears a momentary blip), and if it's
// still throttling we park the audio in the durable queue and let the
// background worker keep trying every ~10 min until it lands. Either way the
// caller gets a clear answer and never loses the note.

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export async function POST(req: Request) {
  let body: { audioBase64?: string; mimeType?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const audioBase64 = body.audioBase64;
  if (!audioBase64) return NextResponse.json({ error: "no audio" }, { status: 400 });

  const mimeType = body.mimeType || "audio/mp4";
  const prefixText = (body.text || "").trim(); // anything typed alongside the recording
  const names = listPeopleIdName().map((p) => p.name);

  // ── Recognition: transcribe, retrying briefly through a passing rate-limit ──
  let transcript: string | null = null;
  for (let attempt = 1; attempt <= INLINE_ATTEMPTS; attempt++) {
    try {
      const out = await transcribeAudio({ audioBase64, mimeType, names });
      transcript = out.text;
      break;
    } catch (e) {
      const retriable = e instanceof TranscribeError ? e.retriable : true;
      if (!retriable) {
        // Bad key / bad audio — the client keeps the audio for a manual retry.
        return NextResponse.json({ error: (e as Error).message }, { status: 502 });
      }
      if (attempt < INLINE_ATTEMPTS) {
        await sleep(inlineBackoffMs(attempt));
        continue;
      }
      // Still throttled after the quick tries — hand it to the background worker.
      enqueueVoiceJob({
        audioBase64,
        mimeType,
        prefixText,
        names,
        transcript: null,
        firstAttemptAt: isoIn(BG_FIRST_DELAY_MS),
      });
      return NextResponse.json({ queued: true, stage: "transcribe" });
    }
  }

  if (transcript === null || !transcript.trim()) {
    // Heard nothing — let the client offer a re-record, nothing is filed.
    return NextResponse.json({ empty: true, transcript: transcript ?? "" });
  }

  // ── Remembering: file the note through the shared capture core ─────────────
  const text = [prefixText, transcript].map((s) => s.trim()).filter(Boolean).join(" ");
  try {
    const result = await fileNote({ text, sourceType: "voice" });
    return NextResponse.json({ ...result, transcript });
  } catch {
    // Transcript is good; only filing failed. Park it with the transcript stored
    // so the worker retries filing only (never re-hits Gemini).
    enqueueVoiceJob({
      audioBase64,
      mimeType,
      prefixText,
      names,
      transcript,
      firstAttemptAt: isoIn(BG_FIRST_DELAY_MS),
    });
    return NextResponse.json({ queued: true, stage: "file", transcript });
  }
}
