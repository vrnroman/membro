import { Ledger } from "@/components/membro/ledger";

// The Ledger of Owes: both sides of relational debt in one place, what you owe
// and what you are owed. The whole site is gated to one identity at the proxy.
export default function PromisesPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Promises</h1>
      <Ledger />
    </div>
  );
}
