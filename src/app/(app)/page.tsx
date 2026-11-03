import type { Metadata } from "next";
import { LayoutDashboard } from "lucide-react";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { Card, CardContent } from "@/components/ui/card";
import { requireSession } from "@/server/auth/next";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await requireSession();
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <Breadcrumbs items={[{ label: "Dashboard" }]} />
        <h1 className="text-2xl font-semibold">Welcome, {session.user.displayName}</h1>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <LayoutDashboard className="size-8 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-base font-semibold">Nothing to show yet</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Clients, websites and projects arrive next. The dashboard will then show where work is
            piling up, upcoming deadlines and recent activity.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
