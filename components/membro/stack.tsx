"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/lib/membro/types";
import { Check, X, Pencil, Copy, ChevronDown } from "lucide-react";

const KIND_LABEL: Record<Card["kind"], string> = {
  connector: "Intro",
  nudge: "Reach out",
  brief: "You're on the hook",
};
const KIND_CLASS: Record<Card["kind"], string> = {
  connector: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  nudge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  brief: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

export function Stack({ cards, onChange }: { cards: Card[]; onChange: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [openWhy, setOpenWhy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function setStatus(id: string, status: Card["status"]) {
    await fetch(`/api/cards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    onChange();
  }
  async function saveEdit(id: string) {
    await fetch(`/api/cards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: draft }),
    });
    setEditing(null);
    onChange();
  }
  async function copy(card: Card) {
    try {
      await navigator.clipboard.writeText(card.body);
      setCopied(card.id);
      setTimeout(() => setCopied((c) => (c === card.id ? null : c)), 1500);
    } catch {
      // Clipboard can reject in insecure contexts or on permission denial; the
      // card body is still on screen to copy manually.
    }
  }

  if (cards.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        Your stack is clear. Run the night shift to prepare today&apos;s outreach.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        <div key={card.id} className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${KIND_CLASS[card.kind]}`}>
                {KIND_LABEL[card.kind]}
              </span>
              <h3 className="mt-2 font-medium leading-snug">{card.title}</h3>
            </div>
          </div>

          {editing === card.id ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={5}
              className="mt-3 w-full rounded-lg border bg-background p-2 text-sm outline-none"
            />
          ) : (
            <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{card.body}</p>
          )}

          {card.why && (
            <div className="mt-2">
              <button
                onClick={() => setOpenWhy((w) => (w === card.id ? null : card.id))}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${openWhy === card.id ? "rotate-180" : ""}`} />
                Why this
              </button>
              {openWhy === card.id && <p className="mt-1 text-xs italic text-muted-foreground">{card.why}</p>}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {editing === card.id ? (
              <>
                <Button size="sm" className="rounded-full" onClick={() => saveEdit(card.id)}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" className="rounded-full" onClick={() => setStatus(card.id, "approved")}>
                  <Check className="mr-1 h-4 w-4" /> Approve
                </Button>
                <Button size="sm" variant="outline" className="rounded-full" onClick={() => copy(card)}>
                  <Copy className="mr-1 h-4 w-4" /> {copied === card.id ? "Copied" : "Copy"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="rounded-full"
                  onClick={() => {
                    setEditing(card.id);
                    setDraft(card.body);
                  }}
                >
                  <Pencil className="mr-1 h-4 w-4" /> Edit
                </Button>
                <Button size="sm" variant="ghost" className="ml-auto rounded-full text-muted-foreground" onClick={() => setStatus(card.id, "skipped")}>
                  <X className="mr-1 h-4 w-4" /> Skip
                </Button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
