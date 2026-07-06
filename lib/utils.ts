import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Colour a due-date label by urgency, shared so the Today list and the Promises
// ledger read from one source: red for overdue, amber for today/tomorrow, muted
// otherwise. Only the small date chip is ever tinted, never a whole row.
export function dueTone(label: string | null): string {
  if (label === "overdue") return "text-red-600 dark:text-red-400";
  if (label === "today" || label === "tomorrow") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}
