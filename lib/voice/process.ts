import { transcribeAudio, TranscribeError } from "@/lib/ai/transcribe";
import { fileNote } from "@/lib/capture";
import {
  type VoiceJob,
  markTranscribed,
  rescheduleJob,
  markJobDone,
  markJobFailed,
} from "./queue";
import { bgBackoffMs, MAX_BG_ATTEMPTS } from "./policy";

// Drive one parked voice note one step further toward "filed", then either
// finish it, park it again with a longer backoff, or give up. Two stages, and
// each stage is retried independently:
//   1. transcribe (Gemini)  — skipped once we already have the transcript
//   2. file the note (Claude extraction) — the transcript is safe by now
// Anything that isn't a clean, permanent "this can't work" is retried, because
// the owner's expectation is that a note eventually lands.

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Bump attempts + push the next try out, or mark failed once we've tried enough. */
function backOffOrGiveUp(job: VoiceJob, error: string): void {
  const attemptsDone = job.attempts + 1;
  if (attemptsDone >= MAX_BG_ATTEMPTS) {
    markJobFailed(job.id, `gave up after ${attemptsDone} tries: ${error}`);
    console.error(`[voice-worker] job ${job.id} failed permanently: ${error}`);
    return;
  }
  rescheduleJob(job.id, isoIn(bgBackoffMs(attemptsDone)), error);
}

export async function processJob(job: VoiceJob): Promise<void> {
  // ── Stage 1: transcribe, unless we already have the text ──────────────────
  let transcript = job.transcript;
  if (transcript == null) {
    try {
      const out = await transcribeAudio({
        audioBase64: job.audio_base64,
        mimeType: job.mime_type,
        names: job.names,
      });
      transcript = out.text;
    } catch (e) {
      if (e instanceof TranscribeError && !e.retriable) {
        // Bad key / bad audio — retrying won't help. Stop cleanly.
        markJobFailed(job.id, e.message);
        console.error(`[voice-worker] job ${job.id} unrecoverable: ${e.message}`);
        return;
      }
      backOffOrGiveUp(job, (e as Error).message);
      return;
    }

    if (!transcript.trim()) {
      // Gemini heard no speech — nothing to file, and re-trying the same audio
      // won't change that. Close it out.
      markJobFailed(job.id, "no speech detected");
      return;
    }
    markTranscribed(job.id, transcript); // never re-hit Gemini for this note again
  }

  // ── Stage 2: file the note ────────────────────────────────────────────────
  const text = [job.prefix_text, transcript].map((s) => s.trim()).filter(Boolean).join(" ");
  try {
    await fileNote({ text, sourceType: "voice" });
    markJobDone(job.id);
  } catch (e) {
    // Extraction (Claude) hiccuped — the transcript is stored, so this only
    // retries the filing step.
    backOffOrGiveUp(job, (e as Error).message);
  }
}
