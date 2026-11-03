import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CalendarClock, LayoutDashboard } from "lucide-react";
import { EmptyState, PageHeader, Section } from "@/components/page";
import { ActivityFeed } from "@/components/records";
import { DeploymentState, DispatchState } from "@/components/deployments";
import { IntegrationHealth, TaskPriority } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate, formatDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { pendingApprovals, releaseAlerts } from "@/server/deploy/approvals";
import { ACTION_LABELS } from "@/server/deploy/preflight";
import { deploymentAlerts } from "@/server/integrations/hosting-sync";
import { listIntegrations } from "@/server/integrations/service";
import { listActivity } from "@/server/records/activity";
import { addDays, appToday } from "@/server/records/dates";
import { listProjects, projectCountsByStage } from "@/server/records/projects";
import { overdueTasks, tasksDueBetween } from "@/server/records/tasks";

export const metadata: Metadata = { title: "Dashboard" };

const DEADLINE_DAYS = 14;
const LIST_LIMIT = 10;

type Deadline = { key: string; date: string; title: string; href: string; detail: string; kind: "task" | "launch" };

// Screen 4: projects per stage, overdue work, deadlines in the next 14 days and
// recent activity, deployment alerts and sync errors. Pending approvals join in Phase 4.
export default async function DashboardPage() {
  const session = await requireSession();
  const database = db();
  const today = await appToday(database);
  const horizon = addDays(today, DEADLINE_DAYS);
  const [counts, overdueProjects, lateTasks, dueTasks, upcomingLaunches, activity, alerts, integrationRows, approvals, releases] = await Promise.all([
    projectCountsByStage(database),
    listProjects(database, { overdue: true, today }),
    overdueTasks(database, today),
    tasksDueBetween(database, today, horizon),
    listProjects(database, { today }).then((rows) =>
      rows.filter((p) => p.targetLaunchDate && p.targetLaunchDate >= today && p.targetLaunchDate <= horizon && !p.overdue),
    ),
    listActivity(database, { excludeAuth: true }, 15),
    deploymentAlerts(database),
    listIntegrations(database),
    pendingApprovals(database),
    releaseAlerts(database),
  ]);
  const syncErrors = integrationRows.filter((i) => i.health === "error" || i.health === "degraded");
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  const max = Math.max(1, ...counts.map((c) => c.count));

  const deadlines: Deadline[] = [
    ...dueTasks.map((t) => ({
      key: `task-${t.id}`,
      date: t.dueDate!,
      title: t.title,
      href: `/projects/${t.projectId}/tasks/${t.id}`,
      detail: `Task · ${t.projectName}`,
      kind: "task" as const,
    })),
    ...upcomingLaunches.map((p) => ({
      key: `launch-${p.id}`,
      date: p.targetLaunchDate!,
      title: `${p.name} target launch`,
      href: `/projects/${p.id}`,
      detail: `Project · ${p.clientName}`,
      kind: "launch" as const,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));

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

          <Section title="Overdue">
            {lateTasks.length === 0 && overdueProjects.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing overdue.</p>
            ) : (
              <Card>
                <CardContent>
                  <ul className="grid gap-2.5" aria-label="Overdue work">
                    {overdueProjects.slice(0, LIST_LIMIT).map((p) => (
                      <li key={`p-${p.id}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <AlertTriangle className="size-3.5 shrink-0 self-center text-destructive" aria-hidden="true" />
                        <Link href={`/projects/${p.id}`} className="font-medium text-primary hover:underline">
                          {p.name}
                        </Link>
                        <span className="text-muted-foreground">launch was due {formatDate(p.targetLaunchDate)}</span>
                      </li>
                    ))}
                    {lateTasks.slice(0, LIST_LIMIT).map((t) => (
                      <li key={`t-${t.id}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <AlertTriangle className="size-3.5 shrink-0 self-center text-destructive" aria-hidden="true" />
                        <Link href={`/projects/${t.projectId}/tasks/${t.id}`} className="font-medium text-primary hover:underline">
                          {t.title}
                        </Link>
                        <span className="text-muted-foreground">
                          due {formatDate(t.dueDate)} · {t.projectName}
                        </span>
                        {t.priority === "critical" || t.priority === "high" ? <TaskPriority priority={t.priority} /> : null}
                      </li>
                    ))}
                  </ul>
                  {lateTasks.length > LIST_LIMIT || overdueProjects.length > LIST_LIMIT ? (
                    <p className="mt-3 text-xs text-muted-foreground">Showing the first {LIST_LIMIT} of each.</p>
                  ) : null}
                </CardContent>
              </Card>
            )}
          </Section>

          <Section title={`Next ${DEADLINE_DAYS} days`}>
            {deadlines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No deadlines in the next {DEADLINE_DAYS} days.</p>
            ) : (
              <Card>
                <CardContent>
                  <ul className="grid gap-2.5" aria-label={`Deadlines in the next ${DEADLINE_DAYS} days`}>
                    {deadlines.slice(0, 20).map((d) => (
                      <li key={d.key} className="grid grid-cols-[6.5rem_1fr] gap-3 text-sm">
                        <span className="flex items-center gap-1.5 tabular-nums text-muted-foreground">
                          <CalendarClock className="size-3.5" aria-hidden="true" />
                          {d.date === today ? "Today" : formatDate(d.date)}
                        </span>
                        <span className="min-w-0">
                          <Link href={d.href} className="font-medium text-primary hover:underline">
                            {d.title}
                          </Link>
                          <span className="block text-xs text-muted-foreground">{d.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </Section>

          {approvals.length ? (
            <Section title="Approvals waiting">
              <Card>
                <CardContent>
                  <ul className="grid gap-2" aria-label="Production approvals waiting for confirmation">
                    {approvals.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <Link href={`/approvals/${a.id}/confirm`} className="font-medium text-primary hover:underline">
                          {a.projectName}
                        </Link>
                        <span className="text-muted-foreground">
                          {ACTION_LABELS[a.action]} · <code className="font-mono text-xs">{a.targetCommitSha.slice(0, 7)}</code> · expires{" "}
                          {formatDateTime(a.expiresAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </Section>
          ) : null}

          {alerts.length || syncErrors.length || releases.length ? (
            <Section title="Deployments and sync">
              <Card>
                <CardContent className="grid gap-3">
                  {releases.length ? (
                    <ul className="grid gap-2" aria-label="SiteSync releases">
                      {releases.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <DispatchState state={r.dispatchState ?? "unknown"} />
                          <Link href={`/projects/${r.projectId}`} className="font-medium text-primary hover:underline">
                            {r.projectName}
                          </Link>
                          <span className="text-muted-foreground">release · {formatDateTime(r.createdAt)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {alerts.length ? (
                    <ul className="grid gap-2" aria-label="Deployment alerts">
                      {alerts.map((a) => (
                        <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <DeploymentState state={a.state} />
                          <Link href={`/websites/${a.websiteId}`} className="font-medium text-primary hover:underline">
                            {a.websiteName}
                          </Link>
                          <span className="text-muted-foreground">
                            production {a.state === "failed" ? "deploy failed" : "deploy in progress"} · {formatDateTime(a.providerCreatedAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {syncErrors.length ? (
                    <ul className="grid gap-2" aria-label="Sync errors">
                      {syncErrors.map((i) => (
                        <li key={i.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <IntegrationHealth health={i.health} />
                          <Link href="/integrations" className="font-medium text-primary hover:underline">
                            {i.name}
                          </Link>
                          <span className="text-muted-foreground">{i.healthDetail ?? i.lastError ?? ""}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </CardContent>
              </Card>
            </Section>
          ) : null}

          <Section title="Recent activity">
            <ActivityFeed items={activity} />
          </Section>
        </div>
      )}
    </div>
  );
}
