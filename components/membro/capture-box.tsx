"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Mic, Camera, Sparkles, Loader2, Square, X, RotateCcw } from "lucide-react";

const SAMPLE =
  "Just got out of the team sync. Maya got promoted to product lead, and she spent two years in our Berlin office before this. Her son Leo just started kindergarten. Tom mentioned his birthday is next week, and I promised to send him the Q3 deck before Thursday. Priya is moving to the Berlin office next month and wants to connect with anyone who has worked there.";

type Result = {
  landed: { person: string; created: boolean; facts: number }[];
  ambiguous: { name: string; reason: string }[];
  adapter?: string;
  transcript?: string;
  queued?: boolean; // Gemini was busy; the note is filing itself in the background
};

// Pick a recording format the browser supports AND that Gemini accepts.
// iOS Safari emits audio/mp4; Chrome emits audio/webm;codecs=opus. Both are fine.
function pickMimeType(): string {
  const prefs = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
    for (const c of prefs) if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function CaptureBox({ onCaptured }: { onCaptured: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [filing, setFiling] = useState(false); // voice note: transcribing + filing in one shot
  const [seconds, setSeconds] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Photos staged for the next capture. Several = one long item (e.g. an email that
  // took two shots to cover); they file together as ONE note. dataUrl drives the
  // thumbnail and yields the base64 we send.
  const [photos, setPhotos] = useState<{ dataUrl: string; mediaType: string }[]>([]);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAudioRef = useRef<{ blob: Blob; mime: string } | null>(null);
  const cancelledRef = useRef(false);

  // Stop the mic and timer if the component goes away mid-recording.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function send(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "capture failed");
      setResult(data);
      setText("");
      setPhotos([]);
      onCaptured();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function remember() {
    // Photos staged? File them (plus any typed text as context) as one photo note.
    if (photos.length > 0) {
      send({
        text,
        sourceType: "photo",
        images: photos.map((p) => ({ base64: p.dataUrl.split(",")[1] ?? "", mediaType: p.mediaType })),
      });
      return;
    }
    if (!text.trim()) return;
    send({ text, sourceType: "text" });
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("could not read audio"));
      reader.readAsDataURL(blob);
    });
  }

  // Recognition + remembering in one action: send the audio, it transcribes and
  // files itself. No transcript to read, no second tap. Anything already typed in
  // the box rides along as context and the box is cleared once it's filed.
  async function fileVoice(blob: Blob, mime: string) {
    lastAudioRef.current = { blob, mime }; // kept so one tap can retry if it fails
    setFiling(true);
    setVoiceError(null);
    setError(null);
    setResult(null);
    try {
      const audioBase64 = await blobToBase64(blob);
      const prefix = taRef.current?.value ?? ""; // read live, not a stale closure
      const res = await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64, mimeType: mime, text: prefix }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "voice capture failed");
      if (data.empty) {
        // Nothing heard — keep the audio so a retry is one tap, keep any typed text.
        setVoiceError("Didn't catch any speech. Tap retry or type it in.");
        return;
      }
      lastAudioRef.current = null; // filed, or safely parked in the background — drop the audio
      setText("");
      setResult(data);
      onCaptured();
    } catch (e) {
      // Keep the audio so one tap can retry instead of losing the note.
      setVoiceError((e as Error).message || "Voice capture failed.");
    } finally {
      setFiling(false);
    }
  }

  async function startRecording() {
    setError(null);
    setVoiceError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setVoiceError("This browser can't record audio. Tip: on a phone, tap the keyboard mic instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMimeType();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (cancelledRef.current) return;
        const actualMime = recorder.mimeType || mime || "audio/mp4";
        const blob = new Blob(chunksRef.current, { type: actualMime });
        if (blob.size > 0) fileVoice(blob, actualMime);
      };
      recorder.start();
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      setVoiceError("Microphone access was blocked. Allow the mic, or type the note instead.");
    }
  }

  function endTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRecording(false);
  }

  function stopAndFile() {
    cancelledRef.current = false;
    endTimer();
    recorderRef.current?.stop();
  }

  function cancelRecording() {
    cancelledRef.current = true;
    endTimer();
    recorderRef.current?.stop();
    chunksRef.current = [];
  }

  function retryVoice() {
    const kept = lastAudioRef.current;
    if (kept) fileVoice(kept.blob, kept.mime);
  }

  function readAsDataUrl(file: File): Promise<{ dataUrl: string; mediaType: string }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ dataUrl: reader.result as string, mediaType: file.type });
      reader.onerror = () => reject(new Error("could not read photo"));
      reader.readAsDataURL(file);
    });
  }

  // Add the picked photo(s) to the tray instead of filing right away, so several
  // shots of one long email can ride into a single note. Tapping the camera again
  // appends more; hit Remember to file them all together.
  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    try {
      const added = await Promise.all(files.map(readAsDataUrl));
      setPhotos((prev) => [...prev, ...added]);
      setError(null);
      setResult(null);
    } catch {
      setError("Couldn't read one of those photos. Try again.");
    }
  }

  function removePhoto(index: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="What happened? Who did you talk to?"
        className="w-full resize-none bg-transparent text-base outline-none placeholder:text-muted-foreground"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") remember();
        }}
      />

      {photos.length > 0 && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-2">
            {photos.map((p, i) => (
              <div key={i} className="relative h-16 w-16 overflow-hidden rounded-lg border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.dataUrl} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                <span className="absolute left-0 top-0 rounded-br bg-black/60 px-1 text-[10px] font-medium leading-4 text-white">
                  {i + 1}
                </span>
                <button
                  type="button"
                  onClick={() => removePhoto(i)}
                  aria-label={`Remove photo ${i + 1}`}
                  title="Remove"
                  className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/60 text-white hover:bg-black/80"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {photos.length === 1
              ? "1 photo attached. Add more shots of the same email and I'll stitch them into one note."
              : `${photos.length} photos — I'll read them together as one note and work out the page order.`}
          </p>
        </div>
      )}

      {recording ? (
        // Honest recording surface: you can see it's listening and how to stop.
        <div className="mt-3 flex items-center gap-2">
          <span className="inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" aria-hidden />
          <span className="text-sm tabular-nums text-muted-foreground">Recording {fmt(seconds)}</span>
          <Button onClick={stopAndFile} className="ml-auto rounded-full">
            <Square className="mr-1 h-4 w-4" /> Stop &amp; remember
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-full"
            onClick={cancelRecording}
            aria-label="Discard recording"
            title="Discard"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            onClick={remember}
            disabled={busy || filing || (!text.trim() && photos.length === 0)}
            className="rounded-full"
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Remember
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="rounded-full"
            onClick={startRecording}
            disabled={busy || filing}
            aria-label="Record a voice note"
            title="Record a voice note"
          >
            <Mic className="h-4 w-4" />
          </Button>
          <label className="inline-flex">
            <input type="file" accept="image/*" multiple className="hidden" onChange={onPhoto} />
            <span
              className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border bg-background hover:bg-accent"
              title="Photo of a screen or email — attach several for one long email"
            >
              <Camera className="h-4 w-4" />
            </span>
          </label>
          <button
            type="button"
            onClick={() => setText(SAMPLE)}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Sparkles className="h-3 w-3" /> Try a sample
          </button>
        </div>
      )}

      {filing && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Remembering your note…
        </p>
      )}

      {voiceError && !filing && (
        <div className="mt-3 flex items-center gap-2 text-sm text-amber-600">
          <span>{voiceError}</span>
          {lastAudioRef.current && (
            <Button type="button" variant="outline" size="sm" className="ml-auto rounded-full" onClick={retryVoice}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Retry
            </Button>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      {result &&
        (result.queued ? (
          // Gemini was busy — the note is parked and will file itself. No waiting.
          <div className="mt-3 rounded-xl bg-muted/60 p-3 text-sm">
            <p>Gemini&apos;s busy right now — I&apos;ll keep trying in the background.</p>
            <p className="mt-1 text-muted-foreground">
              This note will file itself automatically. No need to wait or do anything.
            </p>
          </div>
        ) : (
          <div className="mt-3 rounded-xl bg-muted/60 p-3 text-sm">
            {result.landed.length > 0 ? (
              <p>
                Filed{" "}
                <span className="font-medium">
                  {result.landed.map((l) => `${l.person}${l.created ? " (new)" : ""}`).join(", ")}
                </span>
                .
              </p>
            ) : (
              <p className="text-muted-foreground">Nothing to file from that one.</p>
            )}
            {result.transcript && (
              <p className="mt-1 text-xs text-muted-foreground">Heard: “{result.transcript}”</p>
            )}
            {result.ambiguous.length > 0 && (
              <ul className="mt-1 text-muted-foreground">
                {result.ambiguous.map((a, i) => (
                  <li key={i}>
                    Skipped {a.name}: {a.reason}
                  </li>
                ))}
              </ul>
            )}
            {result.adapter === "mock" && (
              <p className="mt-1 text-xs text-muted-foreground">
                Running in offline mode. Add an Anthropic API key for full AI parsing.
              </p>
            )}
          </div>
        ))}
    </div>
  );
}
