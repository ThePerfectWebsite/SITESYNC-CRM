import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FormMessage } from "@/components/forms/controls";
import { Section } from "@/components/page";
import { Card, CardContent } from "@/components/ui/card";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { getProject } from "@/server/records/projects";
import { websiteOptions } from "@/server/records/websites";
import { noDeploymentsYet } from "@/server/stages/deployment-facts";
import { loadStageState } from "@/server/stages/service";
import { moveStageAction, updateProjectAction } from "../../actions";
import { ProjectForm } from "../../project-form";
import { MoveStageForm } from "../stage-controls";

export const metadata: Metadata = { title: "Project settings" };

export default async function ProjectSettingsPage({ params, searchParams }: PageProps<"/projects/[id]/settings">) {
  await requireSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const database = db();
  const row = await getProject(database, id);
  if (!row) notFound();
  const { project } = row;
  const { saved } = await searchParams;
  const archived = Boolean(project.archivedAt);
  const [websites, state, hasDeployments] = await Promise.all([
    websiteOptions(database),
    loadStageState(database, project),
    noDeploymentsYet.hasDeployments(database, id),
  ]);
  const current = state.stages.find((s) => s.status === "current")!;

  return (
    <div className="grid gap-8">
      {saved === "1" ? <FormMessage tone="success" message="Project saved." /> : null}
      <Section title="Details">
        {archived ? (
          <p className="text-sm text-muted-foreground">Restore this project from its overview before editing it.</p>
        ) : (
          <ProjectForm
            action={updateProjectAction.bind(null, id)}
            submitLabel="Save changes"
            lockedClientId={project.clientId}
            websites={websites.concat(
              websites.some((w) => w.id === project.websiteId)
                ? []
                : [{ id: project.websiteId, name: row.websiteName, clientId: project.clientId, domain: row.websiteDomain }],
            )}
            websiteLockedReason={hasDeployments ? "This project has deployments, so its website can no longer change." : undefined}
            initial={{
              websiteId: project.websiteId,
              name: project.name,
              code: project.code ?? "",
              description: project.description ?? "",
              startDate: project.startDate ?? "",
              targetLaunchDate: project.targetLaunchDate ?? "",
            }}
          />
        )}
      </Section>

      <Section title="Release checklist">
        <p className="text-sm text-muted-foreground">The project&apos;s release checklist arrives in the next phase.</p>
      </Section>

      {archived ? null : (
        <Section title="Archive">
          <Card>
            <CardContent>
              <MoveStageForm
                idPrefix="archive"
                action={moveStageAction.bind(null, id)}
                currentId={current.id}
                stages={state.stages}
                heldFromId={state.heldFromId}
                onlyArchive
              />
            </CardContent>
          </Card>
        </Section>
      )}
    </div>
  );
}
