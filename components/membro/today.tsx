"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CaptureBox } from "./capture-box";
import { Stack } from "./stack";
import { Agenda } from "./agenda";
import { PersonRow, FactRow, Card } from "@/lib/membro/types";
import { Moon, Loader2 } from "lucide-react";

export function Today() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      const data = await res.json();
      setPeople((data.people ?? []) as PersonRow[]);
      setFacts((data.facts ?? []) as FactRow[]);
      setCards((data.cards ?? []) as Card[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runNightShift() {
    setRunning(true);
    setNote(null);
    try {
      const res = await fetch("/api/nightshift", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "night shift failed");
      setNote(data.built === 0 ? "Nothing ripe enough for a card yet. Capture a few more people." : `Prepared ${data.built} card${data.built === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const pending = cards.filter((c) => c.status === "pending");
  const weekAgo = Date.now() - 7 * 86400000;
  const approvedThisWeek = cards.filter((c) => c.status === "approved" && Date.parse(c.created_at) >= weekAgo).length;
  const draftedThisWeek = cards.filter((c) => Date.parse(c.created_at) >= weekAgo).length;

  return (
    <div className="flex flex-col gap-8">
      <p className="-mt-2 text-sm text-muted-foreground">
        {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
      </p>
      <CaptureBox onCaptured={load} />

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">The Stack</h2>
          <Button onClick={runNightShift} disabled={running} variant="secondary" size="sm" className="rounded-full">
            {running ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Moon className="mr-1 h-4 w-4" />}
            Run the night shift
          </Button>
        </div>
        {note && <p className="mb-2 text-sm text-muted-foreground">{note}</p>}
        {draftedThisWeek > 0 && (
          <p className="mb-3 text-xs text-muted-foreground">
            This week: drafted {draftedThisWeek}, you approved {approvedThisWeek}.
          </p>
        )}
        {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : <Stack cards={pending} onChange={load} />}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">What&apos;s due</h2>
        {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : <Agenda people={people} facts={facts} />}
      </section>
    </div>
  );
}
