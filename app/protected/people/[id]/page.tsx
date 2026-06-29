import { Suspense } from "react";
import Link from "next/link";
import { PersonProfile } from "@/components/membro/person-profile";

// Reading params makes this segment dynamic; with Cache Components that access
// must sit inside a Suspense boundary.
async function Profile({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PersonProfile personId={id} />;
}

export default function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <div className="flex-1 w-full flex flex-col gap-6">
      <Link href="/protected/people" className="text-sm text-muted-foreground hover:text-foreground">
        ← All people
      </Link>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <Profile params={params} />
      </Suspense>
    </div>
  );
}
