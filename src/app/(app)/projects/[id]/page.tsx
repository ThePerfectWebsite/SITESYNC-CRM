import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Circle, CircleCheck, CircleDot, CirclePause, CircleSlash, Info, type LucideIcon } from "lucide-react";
import { Details, Section } from "@/components/page";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate, formatDateTime } from "@/lib/format";
import { isUuid } from "@/lib/ids";
import { cn } from "@/lib/utils";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { getProject } from "@/server/records/projects";
import { computeReadiness } from "@/server/records/readiness";
import { noDeploymentsYet } from "@/server/stages/deployment-facts";
import { LIVE_EXPLANATION, NO_HOSTING_EXPLANATION, linearStages } from "@/server/stages/machine";
import { loadStageState } from "@/server/stages/service";
import { moveStageAction } from "../actions";
import { ReadinessPanel } from "./readiness-panel";
import { MoveStageForm, QuickMove, RestoreForm } from "./stage-controls";

export const metadata: Metadata = { title: "Project overview" };

const STATUS: Record<string, { icon: LucideIcon; label: string; className: string }> = {
  completed: { icon: CircleCheck, label: "Done", className: "text-success" },
  current: { icon: CircleDot, label: "Current", className: "text-primary" },
  skipped: { icon: CircleSlash, label: "Skipped", className: "text-muted-foreground" },
  upcoming: { icon: Circle, label: "Upcoming", className: "text-muted-foreground" },
};

export default async function ProjectOverviewPage({ params }: PageProps<"/projects/[id]">) {
  await requireSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const database = db();
  const row = await getProject(database, id);
  if (!row) notFound();
  const { project } = row;
  const [state, readiness] = await Promise.all([loadStageState(database, project), computeReadiness(database, id)]);
  const enteredAt = new Map(state.stages.map((s) => [s.id, s.enteredAt]));

  const current = state.stages.find((s) => s.status === "current")!;
  const linear = linearStages(state.stages);
  const index = linear.findIndex((s) => s.id === current.id);
  const next = index >= 0 ? linear[index + 1] : undefined;
  const heldFrom = linear.find((s) => s.id === state.heldFromId);
  const hasHosting = await noDeploymentsYet.hasIntegrationBackedProductionLink(database, project.websiteId);
  const liveStage = linear.find((s) => s.role === "live");
  const liveUnreached = liveStage?.status === "upcoming";
  const move = moveStageAction.bind(null, id);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid content-start gap-8">
        <Section title="Stage">
          <ol aria-label="Workflow stages" className="grid gap-1 rounded-lg border bg-card p-3 sm:grid-cols-2 xl:grid-cols-4">
            {linear.map((stage) => {
              const status = STATUS[stage.status]!;
              const Icon = status.icon;
              return (
                <li
                  key={stage.id}
                  aria-current={stage.status === "current" ? "step" : undefined}
                  className={cn(
                    "flex items-start gap-2 rounded-md px-2 py-1.5",
                    stage.status === "current" && "bg-accent",
                  )}
                >
                  <Icon className={cn("mt-0.5 size-4 shrink-0", status.className)} aria-hidden="true" />
                  <span className="grid">
                    <span className={cn("text-sm", stage.status === "current" && "font-semibold")}>{stage.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {status.label}
                      {stage.role === "live" && stage.status === "upcoming" ? " · automatic" : ""}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>

          {current.kind === "on_hold" ? (
            <Callout icon={CirclePause}>
              On hold since {formatDateTime(enteredAt.get(current.id))}
              {heldFrom ? `, from ${heldFrom.name}` : ""}.
            </Callout>
          ) : null}
          {current.kind === "archived" ? (
            <Callout icon={Info}>This project is archived. It&apos;s hidden from lists until restored.</Callout>
          ) : null}
          {liveUnreached && !hasHosting && current.kind === "linear" && current.role === "ready_to_deploy" ? (
            <Callout icon={Info}>
              {NO_HOSTING_EXPLANATION} You can still skip past Live with a reason; Live is then recorded as skipped.
            </Callout>
          ) : null}

          <Card>
            <CardContent className="grid gap-5">
              {current.kind === "archived" ? (
                <RestoreForm action={move} currentId={current.id} targetId={state.restoreToId ?? linear[0]!.id} />
              ) : (
                <>
                  {current.kind === "on_hold" && heldFrom ? (
                    <QuickMove action={move} currentId={current.id} targetId={heldFrom.id} label={`Resume at ${heldFrom.name}`} />
                  ) : null}
                  {current.kind === "linear" && next && next.role !== "live" ? (
                    <div className="grid gap-2">
                      {next.role === "ready_to_deploy" ? (
                        <p className="text-sm text-muted-foreground">
                          Readiness for {next.name}:{" "}
                          {readiness.ready
                            ? "no open blockers."
                            : `${readiness.blockers.length} open blocker${readiness.blockers.length === 1 ? "" : "s"} (see Readiness below). Moving on isn't blocked.`}
                        </p>
                      ) : null}
                      <QuickMove action={move} currentId={current.id} targetId={next.id} label={`Advance to ${next.name}`} />
                    </div>
                  ) : null}
                  {current.kind === "linear" && next?.role === "live" ? (
                    <p className="text-sm text-muted-foreground">
                      Next is {next.name}. {LIVE_EXPLANATION}
                    </p>
                  ) : null}
                  <details>
                    <summary className="cursor-pointer text-sm font-medium text-primary">Move to another stage</summary>
                    <div className="mt-3">
                      <MoveStageForm action={move} currentId={current.id} stages={state.stages} heldFromId={state.heldFromId} />
                    </div>
                  </details>
                </>
              )}
            </CardContent>
          </Card>
        </Section>

        <Section title="Readiness">
          <ReadinessPanel projectId={id} readiness={readiness} readOnly={Boolean(project.archivedAt)} />
        </Section>

        <Section title="Deployments">
          <p className="text-sm text-muted-foreground">
            No deployments. Current live and latest preview deploys appear here once a hosting provider is connected.
          </p>
        </Section>
      </div>

      <aside aria-label="Project details" className="grid content-start gap-4">
        <Card>
          <CardContent>
            <Details
              items={[
                ["Client", <Link key="c" href={`/clients/${project.clientId}`} className="text-primary hover:underline">{row.clientName}</Link>],
                [
                  "Website",
                  <Link key="w" href={`/websites/${project.websiteId}`} className="text-primary hover:underline">
                    {row.websiteName}
                  </Link>,
                ],
                ["Domain", row.websiteDomain ?? "—"],
                ["Start", formatDate(project.startDate)],
                ["Target launch", formatDate(project.targetLaunchDate)],
                ["In stage since", formatDateTime(enteredAt.get(current.id))],
                ["Workflow", row.templateName],
              ]}
            />
          </CardContent>
        </Card>
        {project.description ? (
          <Card>
            <CardContent>
              <h2 className="mb-2 text-sm font-semibold">Description</h2>
              <p className="text-sm whitespace-pre-wrap">{project.description}</p>
            </CardContent>
          </Card>
        ) : null}
      </aside>
    </div>
  );
}

function Callout({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}
