"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FactRow } from "@/lib/membro/types";
import { SELF_ID } from "@/lib/nightshift/scout";
import { Sparkles, Loader2 } from "lucide-react";

// The diary half of Membro: first-person notes about the owner, routed here by the
// assistant, plus an on-demand reflection over them. This is your own thread, kept
// off the People index and out of Action items.
export function Diary() {
  const [entries, setEntries] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [reflecting, setReflecting] = useState(false);
  const [reflection, setReflection] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      const data = await res.json();
      const facts = (data.facts ?? []) as FactRow[];
      setEntries(facts.filter((f) => f.person_id === SELF_ID).map((f) => f.content));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function reflect() {
    setReflecting(true);
    setNote(null);
    setReflection(null);
    try {
      const res = await fetch("/api/reflect", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "reflect failed");
      if (data.empty) setNote("Capture a note about how you're doing and I'll reflect it back.");
      else setReflection(data.reflection as string);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setReflecting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Your own thread. Speak or type how you&apos;re doing on Today, and it lands here.
        </p>
        <Button
          onClick={reflect}
          disabled={reflecting || entries.length === 0}
          variant="secondary"
          size="sm"
          className="rounded-full"
        >
          {reflecting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
          Reflect
        </Button>
      </div>

      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      {reflection && (
        <div className="whitespace-pre-line rounded-2xl border bg-muted/50 p-4 text-sm leading-relaxed">
          {reflection}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing here yet. A note like &quot;felt good about the pitch today&quot; becomes a diary entry.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-2xl border bg-card">
          {entries.map((e, i) => (
            <li key={i} className="px-4 py-3 text-sm leading-snug">
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
