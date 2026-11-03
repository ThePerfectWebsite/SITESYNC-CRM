import { LogOut } from "lucide-react";
import { Suspense } from "react";
import { GlobalSearch, QuickCreate } from "./header-tools";
import { SidebarNav } from "./sidebar-nav";

type AppShellProps = {
  user: { displayName: string; email: string };
  children: React.ReactNode;
};

export function AppShell({ user, children }: AppShellProps) {
  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-card px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to main content
      </a>
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-sidebar px-3 py-4 text-sidebar-foreground">
        <div className="mb-6 px-2.5">
          <p className="text-base font-semibold text-white">SiteSync</p>
          <p className="text-xs text-sidebar-foreground/75">Control Centre</p>
        </div>
        <SidebarNav />
        <div className="mt-auto border-t border-sidebar-border px-2.5 pt-3">
          <p className="truncate text-sm font-medium text-white">{user.displayName}</p>
          <p className="truncate text-xs text-sidebar-foreground/75">{user.email}</p>
          <form action="/logout" method="post" className="mt-2">
            <button
              type="submit"
              className="-mx-1 flex items-center gap-2 rounded-md px-1 py-1 text-sm text-sidebar-foreground hover:text-white focus-visible:outline-sidebar-ring"
            >
              <LogOut className="size-4" aria-hidden="true" />
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-card px-6">
          {/* useSearchParams needs a Suspense boundary. */}
          <Suspense fallback={<div className="h-9 w-full max-w-sm" />}>
            <GlobalSearch />
          </Suspense>
          <QuickCreate />
        </header>
        <main id="main" tabIndex={-1} className="flex-1 px-6 py-6 focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
