// Server-side voice-to-text for Membro.
//
// This is deliberately a STANDALONE path, not part of the AiAdapter interface:
// Claude still does all of the extraction / cards / briefs (MEMBRO_AI=cli), and
// Gemini does nothing but turn a spoken note into clean text. The browser's
// on-device dictation garbled unusual names badly; Gemini hears the real audio,
// and we prime it with the names already on file so it spells the people in this
// CRM correctly.

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// House / product words that come up in these notes but aren't real people, so
// they never make it into the roster. Priming them stops phonetic guesses (a
// product name heard as a similar-sounding common word). Owner-specific terms
// (e.g. a client's company name) are NOT hard-coded here — set them via the
// MEMBRO_HOUSE_TERMS env var (comma-separated) so private words stay out of the
// codebase.
const DEFAULT_HOUSE_TERMS = ["Membro", "Claude", "Anthropic", "Langfuse", "Supabase", "Vercel"];

function houseTerms(): string[] {
  const extra = (process.env.MEMBRO_HOUSE_TERMS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return [...DEFAULT_HOUSE_TERMS, ...extra];
}

export type TranscribeInput = {
  audioBase64: string;
  mimeType: string;
  /** Names already on file, passed as spelling hints. */
  names?: string[];
};

export type TranscribeResult = {
  text: string;
  model: string;
};

function buildPrompt(names: string[]): string {
  const lines = [
    "Transcribe this voice memo into clean, readable English text.",
    "It is a short spoken note by a busy professional jotting down what just happened with people he works with.",
    "Transcribe what is said verbatim — do not summarize, translate, answer questions, or add any commentary.",
  ];
  if (names.length) {
    lines.push(
      `These people's names may be spoken; when you hear them, spell them exactly this way: ${names.join(", ")}.`,
    );
  }
  lines.push(`These product or company terms may also be spoken; spell them exactly: ${houseTerms().join(", ")}.`);
  lines.push("If the audio contains no speech, output an empty string.");
  lines.push("Output only the transcription text — no quotes, no labels, nothing else.");
  return lines.join(" ");
}

/**
 * Send recorded audio to Gemini and return the transcript.
 * Throws on a missing key or a non-2xx response so the route can surface a clear
 * error and the client can keep the audio for a retry.
 */
export async function transcribeAudio(input: TranscribeInput): Promise<TranscribeResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.MEMBRO_GEMINI_MODEL || "gemini-2.5-flash";

  if (!input.audioBase64) throw new Error("no audio");

  // Gemini wants a bare type ("audio/mp4"), not "audio/webm;codecs=opus".
  const mime = (input.mimeType || "audio/mp4").split(";")[0].trim();

  const names = Array.from(
    new Set((input.names ?? []).map((n) => n.trim()).filter(Boolean)),
  ).slice(0, 200);

  const body = {
    contents: [
      {
        parts: [
          { text: buildPrompt(names) },
          { inline_data: { mime_type: mime, data: input.audioBase64 } },
        ],
      },
    ],
    generationConfig: { temperature: 0 },
  };

  const res = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini transcription failed (HTTP ${res.status})`);
  }

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();

  return { text, model };
}
