import { PeopleIndex } from "@/components/membro/people-index";

export default function PeoplePage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">People</h1>
      <PeopleIndex />
    </div>
  );
}
