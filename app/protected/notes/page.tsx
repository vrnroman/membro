import { Notes } from "@/components/membro/notes";

// The raw inbox: every captured note as editable text. Gated to one identity at
// the proxy like the rest of the app.
export default function NotesPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Notes</h1>
      <Notes />
    </div>
  );
}
