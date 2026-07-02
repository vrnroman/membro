import { Diary } from "@/components/membro/diary";

// The owner's own diary thread. Gated to one identity at the proxy like the rest.
export default function DiaryPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Diary</h1>
      <Diary />
    </div>
  );
}
