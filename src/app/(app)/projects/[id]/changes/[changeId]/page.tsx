import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/forms/action-button";
import { Details, Section } from "@/components/page";
import { ArchivedPill, ChangeStatus } from "@/components/status";
import { Card, CardContent } from "@/components/ui/card";
import { CHANGE_CATEGORY_LABELS, formatDateTime } from "@/lib/format";
import { isUuid } from "@/lib/ids";
import { getChange } from "@/server/records/changes";
import { listContacts } from "@/server/records/contacts";
import { listTasks } from "@/server/records/tasks";
import { archiveChangeAction, restoreChangeAction, updateChangeAction } from "../../../work-actions";
import { ChangeForm } from "../../../work-forms";
import { loadProjectTab } from "../../load";

export const metadata: Metadata = { title: "Change" };

export default async function ChangePage({ params }: PageProps<"/projects/[id]/changes/[changeId]">) {
  const { id, database, row, archived: projectArchived } = await loadProjectTab(params);
  const { changeId } = await params;
  if (!isUuid(changeId)) notFound();
  const change = await getChange(database, changeId);
  if (!change || change.projectId !== id) notFound();
  const [contacts, tasks] = await Promise.all([
    listContacts(database, row.project.clientId, true),
    listTasks(database, id, { includeClosed: true, includeArchived: true }),
  ]);
  const readOnly = projectArchived || Boolean(change.archivedAt);

  return (
    <div className="grid gap-8">
      <div className="grid gap-2">
        <Link href={`/projects/${id}/changes`} className="text-sm text-primary hover:underline">
          ← All changes
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">{change.title}</h2>
          <ChangeStatus status={change.status} />
          {change.archivedAt ? <ArchivedPill /> : null}
        </div>
      </div>

      <Card>
        <CardContent>
          <Details
            items={[
              ["Category", CHANGE_CATEGORY_LABELS[change.category]],
              ["Requested by", contacts.find((c) => c.id === change.requestedByContactId)?.name ?? "—"],
              ["Related task", tasks.find(({ task }) => task.id === change.taskId)?.task.title ?? "—"],
              ["Shipped in", change.shippedInDeploymentId ? "A deployment" : "Not yet (deployments arrive later)"],
              ["Logged", formatDateTime(change.createdAt)],
            ]}
          />
        </CardContent>
      </Card>

      {readOnly ? (
        <p className="text-sm text-muted-foreground">
          {projectArchived ? "This project is archived, so its changes are read-only." : "This change is archived."}
        </p>
      ) : (
        <Section title="Edit change">
          <ChangeForm
            action={updateChangeAction.bind(null, id, change.id)}
            submitLabel="Save change"
            contacts={contacts.filter((c) => !c.archivedAt || c.id === change.requestedByContactId).map((c) => ({ value: c.id, label: c.name }))}
            tasks={tasks.map(({ task }) => ({ value: task.id, label: task.title }))}
            initial={{
              title: change.title,
              description: change.description ?? "",
              category: change.category,
              status: change.status,
              requestedByContactId: change.requestedByContactId ?? "",
              taskId: change.taskId ?? "",
            }}
          />
        </Section>
      )}

      {projectArchived ? null : (
        <Section title={change.archivedAt ? "Restore" : "Archive"}>
          {change.archivedAt ? (
            <ActionButton action={restoreChangeAction.bind(null, id, change.id)} label="Restore change" />
          ) : (
            <ActionButton action={archiveChangeAction.bind(null, id, change.id)} label="Archive change" variant="ghost" />
          )}
        </Section>
      )}
    </div>
  );
}
