import { redirect } from "next/navigation";

// Single-user app gated at the proxy; the marketing landing has no purpose.
// Send everyone straight to the app.
export default function Home() {
  redirect("/protected");
}
