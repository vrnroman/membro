import { Today } from "@/components/membro/today";

// No in-app auth guard: the whole site is gated to one Google identity at the
// proxy (oauth2-proxy), so any request that reaches here is already the owner.
export default function TodayPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Today</h1>
      <Today />
    </div>
  );
}
