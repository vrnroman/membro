"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PersonRow } from "@/lib/membro/types";
import { Loader2, Copy, Trash2, Sparkles, X } from "lucide-react";

type Fact = {
  id: string;
  kind: "fact" | "date" | "commitment" | "preference";
  content: string;
  due_at: string | null;
  status: "open" | "done";
  created_at: string;
};

export function PersonProfile({ personId }: { personId: string }) {
  const router = useRouter();
  const [person, setPerson] = useState<PersonRow | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [loading, setLoading] = useState(true);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefing, setBriefing] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [copied, setCopied] = useState(false);

  async function load() {
    const res = await fetch(`/api/people/${personId}`, { cache: "no-store" });
    if (!res.ok) {
      setPerson(null);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setPerson((data.person ?? null) as PersonRow | null);
    setFacts((data.facts ?? []) as Fact[]);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId]);

  async function generateBrief() {
    setBriefing(true);
    setBrief(null);
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "brief failed");
      setBrief(data.brief);
    } catch (e) {
      setBrief(`Could not build a brief: ${(e as Error).message}`);
    } finally {
      setBriefing(false);
    }
  }

  async function setMeeting(value: string) {
    const iso = value ? new Date(`${value}T09:00:00`).toISOString() : null;
    await fetch(`/api/people/${personId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ next_meeting_at: iso }),
    });
    load();
  }
  async function toggleDone(f: Fact) {
    await fetch(`/api/facts/${f.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: f.status === "open" ? "done" : "open" }),
    });
    load();
  }
  async function addNote() {
    if (!newNote.trim()) return;
    await fetch("/api/facts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_id: personId, kind: "fact", content: newNote.trim() }),
    });
    setNewNote("");
    load();
  }
  async function deleteFact(id: string) {
    await fetch(`/api/facts/${id}`, { method: "DELETE" });
    load();
  }
  async function deletePerson() {
    await fetch(`/api/people/${personId}`, { method: "DELETE" });
    router.push("/protected/people");
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!person) return <p className="text-sm text-muted-foreground">Not found.</p>;

  const commitments = facts.filter((f) => f.kind === "commitment");
  const dates = facts.filter((f) => f.kind === "date");
  const notes = facts.filter((f) => f.kind === "fact" || f.kind === "preference");
  const meetingValue = person.next_meeting_at ? person.next_meeting_at.slice(0, 10) : "";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif" }} className="text-3xl">
          {person.name}
        </h1>
        {(person.role || person.company) && (
          <p className="text-muted-foreground">{[person.role, person.company].filter(Boolean).join(" · ")}</p>
        )}
        {person.blurb && <p className="mt-1 text-sm">{person.blurb}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={generateBrief} disabled={briefing} className="rounded-full">
          {briefing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
          Prep brief
        </Button>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Next meeting
          <input
            type="date"
            value={meetingValue}
            onChange={(e) => setMeeting(e.target.value)}
            className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
          />
        </label>
        <Button variant="ghost" size="sm" className="ml-auto rounded-full text-muted-foreground" onClick={deletePerson}>
          <Trash2 className="mr-1 h-4 w-4" /> Delete
        </Button>
      </div>

      {brief && (
        <div className="rounded-2xl border bg-muted/50 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Prep brief</span>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => {
                navigator.clipboard.writeText(brief);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Copy className="mr-1 h-4 w-4" /> {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="whitespace-pre-line text-sm">{brief}</p>
        </div>
      )}

      {commitments.length > 0 && (
        <Section title="Promises">
          {commitments.map((f) => (
            <div key={f.id} className="flex items-start gap-2 py-1 text-sm">
              <input type="checkbox" checked={f.status === "done"} onChange={() => toggleDone(f)} className="mt-1" />
              <span className={f.status === "done" ? "text-muted-foreground line-through" : ""}>
                {f.content}
                {f.due_at && <span className="ml-2 text-xs text-muted-foreground">due {f.due_at.slice(0, 10)}</span>}
              </span>
              <DeleteControl onDelete={() => deleteFact(f.id)} label="Remove promise" />
            </div>
          ))}
        </Section>
      )}

      {(person.birthday || dates.length > 0) && (
        <Section title="Dates">
          {person.birthday && <p className="py-1 text-sm">Birthday: {person.birthday.slice(5)}</p>}
          {dates.map((f) => (
            <div key={f.id} className="flex items-start gap-2 py-1 text-sm">
              <span>
                {f.content}
                {f.due_at && <span className="ml-2 text-xs text-muted-foreground">{f.due_at.slice(0, 10)}</span>}
              </span>
              <DeleteControl onDelete={() => deleteFact(f.id)} label="Remove date" />
            </div>
          ))}
        </Section>
      )}

      <Section title="Notes">
        {notes.length === 0 && <p className="py-1 text-sm text-muted-foreground">Nothing yet.</p>}
        {notes.map((f) => (
          <div key={f.id} className="flex items-start gap-2 py-1 text-sm">
            <span>{f.content}</span>
            <DeleteControl onDelete={() => deleteFact(f.id)} label="Remove note" />
          </div>
        ))}
        <div className="mt-2 flex gap-2">
          <Input
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="Add a note…"
            onKeyDown={(e) => e.key === "Enter" && addNote()}
          />
          <Button onClick={addNote} variant="outline" className="rounded-full">
            Add
          </Button>
        </div>
      </Section>
    </div>
  );
}

// Touch-friendly, always-visible delete with an inline two-step confirm:
// first tap arms ("Confirm"), second tap deletes. Tapping anywhere else
// (blur) disarms it — calm and safe, no modal, hard to trigger by accident.
function DeleteControl({ onDelete, label = "Remove" }: { onDelete: () => void; label?: string }) {
  const [armed, setArmed] = useState(false);
  // Belt-and-suspenders auto-revert: iOS Safari often won't hold focus on a
  // <button>, so onBlur can't be relied on alone — also disarm on a timer.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 2500);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed) {
    return (
      <button
        type="button"
        autoFocus
        onClick={() => {
          setArmed(false);
          onDelete();
        }}
        onBlur={() => setArmed(false)}
        className="ml-auto shrink-0 rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-600 dark:bg-red-950/40 dark:text-red-300"
      >
        Confirm remove
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      aria-label={label}
      title={label}
      className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-red-500"
    >
      <X className="h-4 w-4" />
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border bg-card p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </div>
  );
}
