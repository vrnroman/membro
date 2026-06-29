"use client";

import Link from "next/link";
import { scout, PersonRow, FactRow } from "@/lib/nightshift/scout";
import { Cake, Hand, CalendarClock, Snowflake, Users } from "lucide-react";

const ICON = {
  birthday: Cake,
  commitment: Hand,
  meeting: CalendarClock,
  cold: Snowflake,
  connector: Users,
} as const;

export function Agenda({ people, facts }: { people: PersonRow[]; facts: FactRow[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const signals = scout(people, facts, today, 12);

  if (signals.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing on the radar. Capture a few people to get started.</p>;
  }

  return (
    <ul className="flex flex-col divide-y rounded-2xl border bg-card">
      {signals.map((s, i) => {
        const Icon = ICON[s.type];
        let line = "";
        let href = "/protected/people";
        if (s.type === "birthday") {
          line = `${s.person.name}'s birthday ${s.daysUntil === 0 ? "is today" : `in ${s.daysUntil} day${s.daysUntil === 1 ? "" : "s"}`}`;
          href = `/protected/people/${s.person.id}`;
        } else if (s.type === "commitment") {
          line = `You owe ${s.person.name}: ${s.commitment}`;
          href = `/protected/people/${s.person.id}`;
        } else if (s.type === "meeting") {
          line = `Meeting ${s.person.name} ${s.whenLabel}`;
          href = `/protected/people/${s.person.id}`;
        } else if (s.type === "cold") {
          line = `${s.person.name} has gone quiet (${s.daysSince}d)`;
          href = `/protected/people/${s.person.id}`;
        } else {
          line = `Introduce ${s.personA.name} and ${s.personB.name} (${s.shared})`;
          href = `/protected/people/${s.personA.id}`;
        }
        return (
          <li key={i}>
            <Link href={href} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="leading-snug">{line}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
