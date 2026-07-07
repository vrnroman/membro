"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, X, Pencil, Copy, ChevronDown } from "lucide-react";

// A reviewable item with the same approve / copy / edit / skip lifecycle. Both
// night-shift cards and per-note assists render through this; only the PATCH
// endpoint and the kind labels differ, passed in by the caller.
export type StackItem = {
  id: string;
  kind: string;
  title: string;
  body: string;
  why: string | null;
  status: "pending" | "approved" | "skipped";
  // Which crew member produced this (e.g. 'researcher'). When present it drives the
  // pill label/color, so a Researcher brief reads as "Background" even though it is
  // stored as an 'advisory'-kind row (zero-migration home).
  meta?: Record<string, unknown>;
};

export function Stack({
  items,
  endpoint,
  labels,
  classes,
  onChange,
}: {
  items: StackItem[];
  endpoint: string; // e.g. "/api/cards" or "/api/assists"
  labels: Record<string, string>;
  classes: Record<string, string>;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [openWhy, setOpenWhy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function setStatus(id: string, status: StackItem["status"]) {
    await fetch(`${endpoint}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    onChange();
  }
  async function saveEdit(id: string) {
    await fetch(`${endpoint}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: draft }),
    });
    setEditing(null);
    onChange();
  }
  async function copy(item: StackItem) {
    try {
      await navigator.clipboard.writeText(item.body);
      setCopied(item.id);
      setTimeout(() => setCopied((c) => (c === item.id ? null : c)), 1500);
    } catch {
      // Clipboard can reject in insecure contexts or on permission denial; the
      // body is still on screen to copy manually.
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => {
        // A crew stamp (meta.crew) wins over the kind for the pill, so a Researcher
        // brief reads as "Background" with its own color; everything else falls back
        // to the kind label/color it always used.
        const crew = typeof item.meta?.crew === "string" ? (item.meta.crew as string) : undefined;
        const pillLabel = (crew && CREW_LABELS[crew]) ?? labels[item.kind] ?? item.kind;
        const pillClass = (crew && CREW_CLASSES[crew]) ?? classes[item.kind] ?? "bg-muted text-muted-foreground";
        return (
        <div key={item.id} className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${pillClass}`}>
                {pillLabel}
              </span>
              <h3 className="mt-2 font-medium leading-snug">{item.title}</h3>
            </div>
          </div>

          {editing === item.id ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="mt-3 w-full rounded-lg border bg-background p-2 text-sm outline-none"
            />
          ) : (
            <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{item.body}</p>
          )}

          {item.why && (
            <div className="mt-2">
              <button
                onClick={() => setOpenWhy((w) => (w === item.id ? null : item.id))}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${openWhy === item.id ? "rotate-180" : ""}`} />
                Why this
              </button>
              {openWhy === item.id && <p className="mt-1 text-xs italic text-muted-foreground">{item.why}</p>}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {editing === item.id ? (
              <>
                <Button size="sm" className="rounded-full" onClick={() => saveEdit(item.id)}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" className="rounded-full" onClick={() => setStatus(item.id, "approved")}>
                  <Check className="mr-1 h-4 w-4" /> Approve
                </Button>
                <Button size="sm" variant="outline" className="rounded-full" onClick={() => copy(item)}>
                  <Copy className="mr-1 h-4 w-4" /> {copied === item.id ? "Copied" : "Copy"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="rounded-full"
                  onClick={() => {
                    setEditing(item.id);
                    setDraft(item.body);
                  }}
                >
                  <Pencil className="mr-1 h-4 w-4" /> Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto rounded-full text-muted-foreground"
                  onClick={() => setStatus(item.id, "skipped")}
                >
                  <X className="mr-1 h-4 w-4" /> Skip
                </Button>
              </>
            )}
          </div>
        </div>
        );
      })}
    </div>
  );
}

export const CARD_LABELS: Record<string, string> = {
  connector: "Intro",
  nudge: "Reach out",
  brief: "You're on the hook",
};
export const CARD_CLASSES: Record<string, string> = {
  connector: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  nudge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  brief: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

export const ASSIST_LABELS: Record<string, string> = {
  draft: "Draft ready",
  advisory: "A read + reply",
};
export const ASSIST_CLASSES: Record<string, string> = {
  draft: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  advisory: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

// Crew-member stamps. Keyed by meta.crew, these override the kind label/color when
// set. Only the Researcher needs one today (its brief is stored as an 'advisory'
// row); the pill names the OUTPUT ("Background"), not the job, per the house taste.
export const CREW_LABELS: Record<string, string> = {
  researcher: "Background",
};
export const CREW_CLASSES: Record<string, string> = {
  researcher: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
};
