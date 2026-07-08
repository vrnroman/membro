"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Keyboard, Mic, Camera, Pencil, Trash2, Loader2, Check, X } from "lucide-react";

// The Notes inbox: every captured note as editable text, whether it came in typed,
// spoken, or as a photo. The whole point is the fix-it loop — a voice note that
// misheard "Joanne" as "John" is right here as text; correct it, save, and the note
// is reprocessed: the wrong facts and the mis-heard contact are replaced with the
// right ones. Nothing is stranded, and nothing silently disappears.

type Filed = { personId: string; personName: string; kind: string; content: string };
type Capture = { id: string; body: string; source_type: string; created_at: string };
type NoteRow = Capture & { filed: Filed[] };

type ReprocessResult = {
  landed: { person: string; created: boolean; facts: number }[];
  ambiguous: { name: string; reason: string }[];
  removedPeople?: string[];
};

const SOURCE: Record<string, { icon: typeof Keyboard; label: string }> = {
  text: { icon: Keyboard, label: "Typed" },
  voice: { icon: Mic, label: "Voice" },
  photo: { icon: Camera, label: "Photo" },
};

const IMAGE_PLACEHOLDER = "(image)";

function ago(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(then).toLocaleDateString();
}

export function Notes() {
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/captures", { cache: "no-store" });
      const data = await res.json();
      setNotes((data.captures ?? []) as NoteRow[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <p className="-mt-2 text-sm text-muted-foreground">
        Everything you captured, as text. Spoken and photographed notes land here too. Edit any of them and save to
        reprocess the note, so a mis-heard name is fixed everywhere it was filed.
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing captured yet. Speak, type, or snap a note on Today and it shows up here to review and edit.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {notes.map((n) => (
            <NoteItem key={n.id} note={n} onChanged={load} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteItem({ note, onChanged }: { note: NoteRow; onChanged: () => void }) {
  const isImageOnly = note.body.trim() === IMAGE_PLACEHOLDER;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(isImageOnly ? "" : note.body);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReprocessResult | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const src = SOURCE[note.source_type] ?? SOURCE.text;
  const Icon = src.icon;

  function startEdit() {
    setDraft(isImageOnly ? "" : note.body);
    setError(null);
    setResult(null);
    setEditing(true);
    setTimeout(() => taRef.current?.focus(), 0);
  }

  async function save() {
    const text = draft.trim();
    if (!text) {
      setError("Add some text, or delete the note.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/captures/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "reprocess failed");
      setResult(data as ReprocessResult);
      setEditing(false);
      onChanged(); // pull the fresh filed-facts + any renamed people from the server
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/captures/${note.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <li className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span>{src.label}</span>
        <span aria-hidden>·</span>
        <span>{ago(note.created_at)}</span>
        {!editing && (
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-full"
              onClick={startEdit}
              disabled={busy}
              aria-label="Edit note"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-full text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              aria-label="Delete note"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(8, Math.max(2, draft.split("\n").length))}
            placeholder={isImageOnly ? "Type what the photo said…" : "Edit the note…"}
            className="w-full resize-y rounded-xl border bg-background p-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={busy} size="sm" className="rounded-full">
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}
              Save &amp; reprocess
            </Button>
            <Button
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={busy}
              variant="ghost"
              size="sm"
              className="rounded-full"
            >
              <X className="mr-1 h-4 w-4" /> Cancel
            </Button>
          </div>
        </div>
      ) : isImageOnly ? (
        <p className="text-sm italic text-muted-foreground">
          Photo note, no text yet. Edit to type what it said and file it.
        </p>
      ) : (
        <p className="whitespace-pre-line text-sm leading-snug">{note.body}</p>
      )}

      {note.filed.length > 0 && !editing && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {note.filed.map((f, i) => (
            <span
              key={i}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
              title={`${f.personName}: ${f.content}`}
            >
              <span className="font-medium text-foreground">{f.personName}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{f.content}</span>
            </span>
          ))}
        </div>
      )}

      {result && !editing && (
        <p className="mt-3 text-xs text-muted-foreground">
          {result.landed.length > 0
            ? `Re-filed ${result.landed.map((l) => `${l.person}${l.created ? " (new)" : ""}`).join(", ")}.`
            : "Reprocessed. Nothing to file from that one."}
          {result.removedPeople && result.removedPeople.length > 0
            ? ` Removed ${result.removedPeople.length} contact${result.removedPeople.length === 1 ? "" : "s"} left with nothing.`
            : ""}
          {result.ambiguous.length > 0
            ? ` Skipped ${result.ambiguous.map((a) => a.name).join(", ")}.`
            : ""}
        </p>
      )}

      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}

      {confirmDelete && (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-muted/60 p-3 text-sm">
          <span>Delete this note and everything it filed?</span>
          <Button
            onClick={remove}
            disabled={busy}
            variant="destructive"
            size="sm"
            className="ml-auto rounded-full"
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Delete
          </Button>
          <Button
            onClick={() => setConfirmDelete(false)}
            disabled={busy}
            variant="ghost"
            size="sm"
            className="rounded-full"
          >
            Keep
          </Button>
        </div>
      )}
    </li>
  );
}
