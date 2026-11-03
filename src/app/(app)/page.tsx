import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, LayoutDashboard } from "lucide-react";
import { EmptyState, PageHeader, Section } from "@/components/page";
import { ActivityFeed, ProjectsTable } from "@/components/records";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { listActivity } from "@/server/records/activity";
import { listProjects, projectCountsByStage } from "@/server/records/projects";

export const metadata: Metadata = { title: "Dashboard" };

// Screen 4, Phase 1 skeleton: projects per stage, overdue projects, recent
// activity. Tasks, deadlines, deployment alerts and approvals join later.
export default async function DashboardPage() {
  const session = await requireSession();
  const database = db();
  const [counts, overdue, activity] = await Promise.all([
    projectCountsByStage(database),
    listProjects(database, { overdue: true }),
    listActivity(database, { excludeAuth: true }, 15),
  ]);
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  const max = Math.max(1, ...counts.map((c) => c.count));

  return (
    <div className="grid gap-8">
      <PageHeader crumbs={[{ label: "Dashboard" }]} title={`Welcome, ${session.user.displayName}`} />

      {total === 0 ? (
        <EmptyState
          icon={LayoutDashboard}
          title="No projects yet"
          action={
            <Button asChild className="h-9">
              <Link href="/clients/new">Add a client</Link>
            </Button>
          }
        >
          Start with a client, add their website, then create a project. The dashboard then shows where work is piling up.
        </EmptyState>
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          <Section title="Projects by stage">
            <Card>
              <CardContent>
                <ul className="grid gap-2" aria-label={`${total} live projects by current stage`}>
                  {counts.map((stage) => (
                    <li key={stage.key} className="grid grid-cols-[8rem_1fr_2rem] items-center gap-3 text-sm">
                      <Link href={`/projects?stage=${stage.key}`} className="truncate hover:underline">
                        {stage.name}
                      </Link>
                      <span className="h-2.5 rounded-full bg-muted" aria-hidden="true">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${(stage.count / max) * 100}%` }}
                        />
                      </span>
                      <span className="text-right tabular-nums">{stage.count}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </Section>

          <Section title="Recent activity">
            <ActivityFeed items={activity} />
          </Section>
        </div>
      )}

      {overdue.length ? (
        <Section
          title="Overdue projects"
          actions={
            <Link href="/projects?overdue=1" className="text-sm text-primary hover:underline">
              View all
            </Link>
          }
        >
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />
            Target launch date passed and not yet Live.
          </p>
          <ProjectsTable rows={overdue.slice(0, 10)} />
        </Section>
      ) : null}
    </div>
  );
}
