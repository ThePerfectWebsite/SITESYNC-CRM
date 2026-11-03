import { AppShell } from "@/components/shell/app-shell";
import { requireSession } from "@/server/auth/next";

// Every page under (app) requires a valid session. Server Actions and Route
// Handlers call requireSession() themselves as well; layouts don't guard them.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  return (
    <AppShell user={{ displayName: session.user.displayName, email: session.user.email }}>
      {children}
    </AppShell>
  );
}
