import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { ActionButton } from "@/components/forms/action-button";
import { Details, Section } from "@/components/page";
import { ArchivedPill, TaskPriority, TaskStatus } from "@/components/status";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate, formatDateTime } from "@/lib/format";
import { isUuid } from "@/lib/ids";
import { getTask } from "@/server/records/tasks";
import {
  archiveTaskAction,
  completeTaskAction,
  reopenTaskAction,
  restoreTaskAction,
  updateTaskAction,
} from "../../../work-actions";
import { TaskForm } from "../../../work-forms";
import { loadProjectTab, stageOptions } from "../../load";

export const metadata: Metadata = { title: "Task" };

export default async function TaskPage({ params }: PageProps<"/projects/[id]/tasks/[taskId]">) {
  const { id, database, archived: projectArchived } = await loadProjectTab(params);
  const { taskId } = await params;
  if (!isUuid(taskId)) notFound();
  const task = await getTask(database, taskId);
  if (!task || task.projectId !== id) notFound();
  const stages = await stageOptions(database, id);
  const closed = task.status === "done" || task.status === "cancelled";
  const readOnly = projectArchived || Boolean(task.archivedAt);

  return (
    <div className="grid gap-8">
      <div className="grid gap-2">
        <Link href={`/projects/${id}/tasks`} className="text-sm text-primary hover:underline">
          ← All tasks
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">{task.title}</h2>
          <TaskStatus status={task.status} />
          <TaskPriority priority={task.priority} />
          {task.archivedAt ? <ArchivedPill /> : null}
        </div>
      </div>

      <Card>
        <CardContent>
          <Details
            items={[
              ["Due", formatDate(task.dueDate)],
              ["Stage", stages.find((s) => s.value === task.projectStageId)?.label ?? "—"],
              [
                "Reference",
                task.referenceUrl ? (
                  <a
                    key="ref"
                    href={task.referenceUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex items-center gap-1 break-all text-primary hover:underline"
                  >
                    {task.referenceUrl}
                    <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : (
                  "—"
                ),
              ],
              ["Completed", task.completedAt ? formatDateTime(task.completedAt) : "—"],
              ["Created", formatDateTime(task.createdAt)],
            ]}
          />
        </CardContent>
      </Card>

      {readOnly ? (
        <p className="text-sm text-muted-foreground">
          {projectArchived ? "This project is archived, so its tasks are read-only." : "This task is archived."}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {closed ? (
            <ActionButton action={reopenTaskAction.bind(null, id, task.id)} label="Reopen task" />
          ) : (
            <ActionButton action={completeTaskAction.bind(null, id, task.id)} label="Mark as done" variant="default" />
          )}
        </div>
      )}

      {readOnly ? null : (
        <Section title="Edit task">
          <TaskForm
            action={updateTaskAction.bind(null, id, task.id)}
            submitLabel="Save task"
            stages={stages}
            isDone={task.status === "done"}
            initial={{
              title: task.title,
              description: task.description ?? "",
              status: task.status,
              priority: task.priority,
              dueDate: task.dueDate ?? "",
              referenceUrl: task.referenceUrl ?? "",
              projectStageId: task.projectStageId ?? "",
            }}
          />
        </Section>
      )}

      {projectArchived ? null : (
        <Section title={task.archivedAt ? "Restore" : "Archive"}>
          {task.archivedAt ? (
            <ActionButton action={restoreTaskAction.bind(null, id, task.id)} label="Restore task" />
          ) : (
            <ActionButton action={archiveTaskAction.bind(null, id, task.id)} label="Archive task" variant="ghost" />
          )}
        </Section>
      )}
    </div>
  );
}
