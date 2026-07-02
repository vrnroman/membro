import { ThemeSwitcher } from "@/components/theme-switcher";
import { APP_NAME } from "@/lib/app-config";
import Link from "next/link";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen flex flex-col items-center">
      <div className="flex-1 w-full flex flex-col gap-12 items-center">
        <nav className="w-full flex justify-center border-b border-b-foreground/10 h-16">
          <div className="w-full max-w-3xl flex justify-between items-center p-3 px-5 text-sm">
            <div className="flex items-center gap-5">
              <Link href={"/protected"} className="font-semibold">
                {APP_NAME}
              </Link>
              <Link href={"/protected"} className="text-muted-foreground hover:text-foreground">
                Today
              </Link>
              <Link href={"/protected/people"} className="text-muted-foreground hover:text-foreground">
                People
              </Link>
              <Link href={"/protected/suggestions"} className="text-muted-foreground hover:text-foreground">
                Suggestions
              </Link>
              <Link href={"/protected/diary"} className="text-muted-foreground hover:text-foreground">
                Diary
              </Link>
            </div>
            {/* Logout is handled by the auth proxy in front of the app. */}
            <a href="/oauth2/sign_out" className="text-muted-foreground hover:text-foreground">
              Sign out
            </a>
          </div>
        </nav>
        <div className="flex-1 w-full flex flex-col gap-12 max-w-3xl p-5">
          {children}
        </div>

        <footer className="w-full flex items-center justify-center border-t mx-auto text-center text-xs gap-8 py-8">
          <ThemeSwitcher />
        </footer>
      </div>
    </main>
  );
}
