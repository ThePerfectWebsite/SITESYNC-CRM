import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ListChecks } from "lucide-react";
import { ActionButton } from "@/components/forms/action-button";
import { EmptyState, Section } from "@/components/page";
import { ArchivedPill, TaskPriority, TaskStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { appToday, isOverdue } from "@/server/records/dates";
import { listTasks } from "@/server/records/tasks";
import { completeTaskAction, createTaskAction, reopenTaskAction } from "../../work-actions";
import { TaskForm } from "../../work-forms";
import { loadProjectTab, stageOptions } from "../load";

export const metadata: Metadata = { title: "Project tasks" };

export default async function ProjectTasksPage({ params, searchParams }: PageProps<"/projects/[id]/tasks">) {
  const { id, database, archived } = await loadProjectTab(params);
  const query = await searchParams;
  const includeClosed = query.closed === "1";
  const includeArchived = query.archived === "1";
  const [rows, stages, today] = await Promise.all([
    listTasks(database, id, { includeClosed, includeArchived }),
    stageOptions(database, id),
    appToday(database),
  ]);

  return (
    <div className="grid gap-8">
      <Section
        title="Tasks"
        actions={
          <nav aria-label="Task filters" className="flex flex-wrap gap-2 text-sm">
            <Link
              href={`/projects/${id}/tasks`}
              aria-current={!includeClosed && !includeArchived ? "page" : undefined}
              className="rounded-md px-2 py-1 hover:bg-muted aria-[current=page]:bg-accent aria-[current=page]:font-medium"
            >
              Open
            </Link>
            <Link
              href={`/projects/${id}/tasks?closed=1`}
              aria-current={includeClosed && !includeArchived ? "page" : undefined}
              className="rounded-md px-2 py-1 hover:bg-muted aria-[current=page]:bg-accent aria-[current=page]:font-medium"
            >
              All
            </Link>
            <Link
              href={`/projects/${id}/tasks?closed=1&archived=1`}
              aria-current={includeArchived ? "page" : undefined}
              className="rounded-md px-2 py-1 hover:bg-muted aria-[current=page]:bg-accent aria-[current=page]:font-medium"
            >
              Including archived
            </Link>
          </nav>
        }
      >
        {rows.length === 0 ? (
          <EmptyState icon={ListChecks} title={includeClosed ? "No tasks" : "No open tasks"}>
            {archived ? "This project is archived." : "Add one below."}
          </EmptyState>
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader className="bg-card lg:sticky lg:top-14 lg:z-[1]">
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ task, stageName }) => {
                  const overdue = task.status !== "done" && task.status !== "cancelled" && isOverdue(task.dueDate, today);
                  return (
                    <TableRow key={task.id}>
                      <TableCell className="max-w-80 whitespace-normal">
                        <Link href={`/projects/${id}/tasks/${task.id}`} className="font-medium text-primary hover:underline">
                          {task.title}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          <TaskStatus status={task.status} />
                          {task.archivedAt ? <ArchivedPill /> : null}
                        </span>
                      </TableCell>
                      <TableCell>
                        <TaskPriority priority={task.priority} />
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5">
                          {formatDate(task.dueDate)}
                          {overdue ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                              <AlertTriangle className="size-3.5" aria-hidden="true" />
                              Overdue
                            </span>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell>{stageName ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {archived || task.archivedAt ? null : task.status === "done" || task.status === "cancelled" ? (
                          <ActionButton
                            action={reopenTaskAction.bind(null, id, task.id)}
                            label="Reopen"
                            variant="ghost"
                            accessibleLabel={`Reopen “${task.title}”`}
                          />
                        ) : (
                          <ActionButton
                            action={completeTaskAction.bind(null, id, task.id)}
                            label="Complete"
                            variant="outline"
                            accessibleLabel={`Complete “${task.title}”`}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      {archived ? null : (
        <Section title="Add a task">
          <TaskForm action={createTaskAction.bind(null, id)} submitLabel="Add task" stages={stages} idPrefix="new-task" />
        </Section>
      )}

      {includeClosed || includeArchived ? null : (
        <p className="text-sm text-muted-foreground">
          Done and cancelled tasks are hidden.{" "}
          <Button asChild variant="link" className="h-auto p-0">
            <Link href={`/projects/${id}/tasks?closed=1`}>Show all tasks</Link>
          </Button>
        </p>
      )}
    </div>
  );
}
