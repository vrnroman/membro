import { Suggestions } from "@/components/membro/suggestions";

// Opt-in screen: speculative ideas (intros, reconnects) the owner opens by
// choice. The whole site is already gated to one identity at the proxy.
export default function SuggestionsPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Suggestions</h1>
      <Suggestions />
    </div>
  );
}
