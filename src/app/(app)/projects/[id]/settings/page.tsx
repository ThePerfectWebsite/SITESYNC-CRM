import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/forms/action-button";
import { FormMessage } from "@/components/forms/controls";
import { Section } from "@/components/page";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { listChecklist } from "@/server/records/checklist";
import { getProject } from "@/server/records/projects";
import { websiteOptions } from "@/server/records/websites";
import { databaseDeploymentFacts } from "@/server/stages/deployment-facts";
import { loadStageState } from "@/server/stages/service";
import { moveStageAction, updateProjectAction } from "../../actions";
import { ProjectForm } from "../../project-form";
import {
  addChecklistFromTemplateAction,
  archiveChecklistItemAction,
  restoreChecklistItemAction,
  setChecklistItemAction,
} from "../../work-actions";
import { MoveStageForm } from "../stage-controls";
import { ChecklistItemForm } from "./checklist-item";

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
  const [websites, state, hasDeployments, checklist] = await Promise.all([
    websiteOptions(database),
    loadStageState(database, project),
    databaseDeploymentFacts.hasDeployments(database, id),
    listChecklist(database, id, true),
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

      <div id="checklist">
        <Section
          title="Release checklist"
          actions={
            archived ? null : (
              <ActionButton
                action={addChecklistFromTemplateAction.bind(null, id)}
                label="Add checklist from template"
                pendingLabel="Adding…"
              />
            )
          }
        >
          <p className="text-sm text-muted-foreground">
            Unchecked required items block release readiness. The template is in Settings; adding from it skips items
            this project already has.
          </p>
          {checklist.length ? (
            <Card>
              <CardContent>
                <ul className="grid gap-3">
                  {checklist
                    .filter((item) => !item.archivedAt)
                    .map((item) => (
                      <li key={item.id} className="grid gap-1 border-b pb-3 last:border-b-0 last:pb-0">
                        <ChecklistItemForm
                          action={setChecklistItemAction.bind(null, id, item.id)}
                          itemId={item.id}
                          label={item.label}
                          required={item.required}
                          checked={Boolean(item.checkedAt)}
                          note={item.note ?? ""}
                          checkedBy={
                            item.checkedAt
                              ? `Checked by ${item.checkedByName ?? "operator"}, ${formatDateTime(item.checkedAt)}`
                              : undefined
                          }
                          disabled={archived}
                        />
                        {archived ? null : (
                          <div>
                            <ActionButton
                              action={archiveChecklistItemAction.bind(null, id, item.id)}
                              label="Remove from this project"
                              variant="ghost"
                              accessibleLabel={`Remove “${item.label}” from this project`}
                            />
                          </div>
                        )}
                      </li>
                    ))}
                </ul>
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-muted-foreground">This project has no checklist items.</p>
          )}
          {checklist.some((item) => item.archivedAt) ? (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">Removed items</summary>
              <ul className="mt-2 grid gap-2">
                {checklist
                  .filter((item) => item.archivedAt)
                  .map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-3 text-sm">
                      {item.label}
                      {archived ? null : (
                        <ActionButton
                          action={restoreChecklistItemAction.bind(null, id, item.id)}
                          label="Restore"
                          variant="ghost"
                          accessibleLabel={`Restore “${item.label}”`}
                        />
                      )}
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}
        </Section>
      </div>

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
