import { transcribeAudio, TranscribeError } from "@/lib/ai/transcribe";
import { fileNote } from "@/lib/capture";
import {
  type VoiceJob,
  markTranscribed,
  rescheduleJob,
  parkVoiceJob,
  markJobDone,
  markJobFailed,
} from "./queue";
import { bgBackoffMs, MAX_BG_ATTEMPTS } from "./policy";
import { QuotaExhaustedError, AdapterError, ENGINE_RETRY_MS, PARK_MAX_AGE_MS } from "@/lib/ai/quota";

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

/**
 * The backstop on parking: a park spends no attempts, so a job held by a fault we
 * wrongly judged global would retry forever, never done and never failed. Past
 * PARK_MAX_AGE_MS (10 days, beyond the 7-day weekly limit parking exists for) it
 * gives up instead, so every fault class terminates.
 */
function parkedTooLong(job: VoiceJob, reason: string): boolean {
  const age = Date.now() - Date.parse(job.created_at);
  if (!Number.isFinite(age) || age <= PARK_MAX_AGE_MS) return false;
  const days = Math.round(age / 86400_000);
  markJobFailed(job.id, `gave up after ${days}d parked: ${reason}`);
  console.error(`<3>[voice-worker] job ${job.id} parked ${days}d without recovering, giving up: ${reason}`);
  return true;
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
    // Out of quota is not a hiccup and not this note's fault. Park it until the
    // engine is back without spending an attempt: MAX_BG_ATTEMPTS buys ~10h on the
    // assumption that "a quota reset lands well inside that", which is false for a
    // WEEKLY limit. Charging it here marks the job failed, and a failed job is
    // never re-claimed, so the transcript survives but is never filed and the
    // person it was about silently loses that history for good.
    if (e instanceof QuotaExhaustedError) {
      if (!parkedTooLong(job, `out of AI quota: ${e.raw}`)) {
        parkVoiceJob(job.id, e.resetAt.toISOString(), `paused, out of AI quota: ${e.raw}`);
        console.error(`<3>[voice-worker] job ${job.id} parked until ${e.resetAt.toISOString()}, out of AI quota`);
      }
      return;
    }
    // Same rule for the engine being broken rather than out of credit: the model was
    // never reached (read-only disk, dead token), so this note did nothing wrong.
    // Both faults are persistent, so they always outlast the ~10h give-up bound, and
    // a failed voice job keeps its transcript but is never filed — the person it was
    // about silently loses that history for good.
    if (e instanceof AdapterError && e.global) {
      if (!parkedTooLong(job, `AI engine unavailable: ${e.raw}`)) {
        const at = new Date(Date.now() + ENGINE_RETRY_MS).toISOString();
        parkVoiceJob(job.id, at, `paused, AI engine unavailable: ${e.raw}`);
        console.error(`<3>[voice-worker] job ${job.id} parked until ${at}, AI engine unavailable: ${e.raw}`);
      }
      return;
    }
    // Extraction (Claude) hiccuped — the transcript is stored, so this only
    // retries the filing step.
    backOffOrGiveUp(job, (e as Error).message);
  }
}
