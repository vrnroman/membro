"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Stack, CARD_LABELS, CARD_CLASSES, ASSIST_LABELS, ASSIST_CLASSES } from "./stack";
import { scout, isIdeaSignal, PersonRow, FactRow } from "@/lib/nightshift/scout";
import { Card, Assist } from "@/lib/membro/types";
import { Moon, Loader2, Users, Snowflake } from "lucide-react";

// The opt-in screen for anything the owner may or may not act on, kept off Today.
// Two kinds of speculative help live here: per-note drafts the assistant already
// started (a message to send, a read + reply) and the night-shift outreach ideas
// (intros, reconnects). Nothing here is a to-do, and nothing sends itself.

export function Suggestions() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [assists, setAssists] = useState<Assist[]>([]);
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
      setAssists((data.assists ?? []) as Assist[]);
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
          : `Drafted ${data.built} outreach idea${data.built === 1 ? "" : "s"}.`,
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
  const pendingCards = cards.filter((c) => c.status === "pending");
  const pendingAssists = assists.filter((a) => a.status === "pending");

  return (
    <div className="flex flex-col gap-8">
      <p className="-mt-2 text-sm text-muted-foreground">
        Things I started or noticed, for you to review. Nothing here is a to-do, and nothing sends itself.
      </p>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Ready to review</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : pendingAssists.length > 0 ? (
          <Stack
            items={pendingAssists}
            endpoint="/api/assists"
            labels={ASSIST_LABELS}
            classes={ASSIST_CLASSES}
            onChange={load}
          />
        ) : (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            When a note reads like a task or a tricky message, I draft it here so you can send or skip it.
          </p>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Outreach</h2>
          <Button onClick={runNightShift} disabled={running} variant="secondary" size="sm" className="rounded-full">
            {running ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Moon className="mr-1 h-4 w-4" />}
            Run the night shift
          </Button>
        </div>
        {note && <p className="mb-2 text-sm text-muted-foreground">{note}</p>}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            {pendingCards.length > 0 && (
              <Stack
                items={pendingCards}
                endpoint="/api/cards"
                labels={CARD_LABELS}
                classes={CARD_CLASSES}
                onChange={load}
              />
            )}
            {ideas.length > 0 ? (
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
                            <span className="text-muted-foreground">· both linked to {s.shared}</span>
                          </span>
                        </Link>
                      </li>
                    );
                  }
                  return (
                    <li key={i}>
                      <Link
                        href={`/protected/people/${s.person.id}`}
                        className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent"
                      >
                        <Snowflake className="h-5 w-5 shrink-0 text-muted-foreground" />
                        <span className="leading-snug">
                          Reconnect with <span className="font-medium">{s.person.name}</span>{" "}
                          <span className="text-muted-foreground">· quiet for {s.daysSince} days</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              pendingCards.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Nothing to suggest yet. The more people you capture, the more connections show up here.
                </p>
              )
            )}
          </div>
        )}
      </section>
    </div>
  );
}
