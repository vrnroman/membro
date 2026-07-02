"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Stack } from "./stack";
import { scout, isIdeaSignal, PersonRow, FactRow } from "@/lib/nightshift/scout";
import { Card } from "@/lib/membro/types";
import { Moon, Loader2, Users, Snowflake } from "lucide-react";

// The opt-in screen for ideas the owner may or may not act on — never certain,
// so it's kept off the main Today view. "On the radar" is the raw deterministic
// list (introduce two people who share a topic, reconnect with someone gone
// quiet); "Run the night shift" turns those into finished, ready-to-send drafts
// (The Stack). Nothing here is a to-do.

export function Suggestions() {
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
      setNote(
        data.built === 0
          ? "Nothing ripe enough to draft yet. Capture a few more people."
          : `Drafted ${data.built} suggestion${data.built === 1 ? "" : "s"}.`,
      );
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const ideas = scout(people, facts, today, 100).filter(isIdeaSignal);
  const pending = cards.filter((c) => c.status === "pending");
  const weekAgo = Date.now() - 7 * 86400000;
  const approvedThisWeek = cards.filter(
    (c) => c.status === "approved" && Date.parse(c.created_at) >= weekAgo,
  ).length;

  return (
    <div className="flex flex-col gap-8">
      <p className="-mt-2 text-sm text-muted-foreground">
        Ideas you might act on — not to-dos. Reach out when it feels right.
      </p>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Drafts</h2>
          <Button onClick={runNightShift} disabled={running} variant="secondary" size="sm" className="rounded-full">
            {running ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Moon className="mr-1 h-4 w-4" />}
            Run the night shift
          </Button>
        </div>
        {note && <p className="mb-2 text-sm text-muted-foreground">{note}</p>}
        {approvedThisWeek > 0 && (
          <p className="mb-3 text-xs text-muted-foreground">You approved {approvedThisWeek} this week.</p>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : pending.length > 0 ? (
          <Stack cards={pending} onChange={load} />
        ) : (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            No drafts yet. Run the night shift to turn the ideas below into ready-to-send messages.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">On the radar</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : ideas.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing to suggest yet. The more people you capture, the more connections show up here.
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-2xl border bg-card">
            {ideas.map((s, i) => {
              if (s.type === "connector") {
                return (
                  <li key={i}>
                    <Link
                      href={`/protected/people/${s.personA.id}`}
                      className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent"
                    >
                      <Users className="h-5 w-5 shrink-0 text-muted-foreground" />
                      <span className="leading-snug">
                        Introduce <span className="font-medium">{s.personA.name}</span> and{" "}
                        <span className="font-medium">{s.personB.name}</span>{" "}
                        <span className="text-muted-foreground">— both linked to {s.shared}</span>
                      </span>
                    </Link>
                  </li>
                );
              }
              // cold
              return (
                <li key={i}>
                  <Link
                    href={`/protected/people/${s.person.id}`}
                    className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent"
                  >
                    <Snowflake className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <span className="leading-snug">
                      Reconnect with <span className="font-medium">{s.person.name}</span>{" "}
                      <span className="text-muted-foreground">— quiet for {s.daysSince} days</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
