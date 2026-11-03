import type { Metadata } from "next";
import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { listProjects } from "@/server/records/projects";
import { createTaskForProjectAction } from "../../projects/work-actions";
import { TaskForm } from "../../projects/work-forms";

export const metadata: Metadata = { title: "New task" };

// Quick-create (spec §9). The stage can be set afterwards on the task's page.
export default async function NewTaskPage() {
  await requireSession();
  const projects = await listProjects(db());
  return (
    <div className="grid gap-6">
      <PageHeader crumbs={[{ label: "New task" }]} title="New task" />
      {projects.length ? (
        <TaskForm
          action={createTaskForProjectAction}
          submitLabel="Add task"
          stages={[]}
          projects={projects.map((p) => ({ value: p.id, label: `${p.name} (${p.clientName})` }))}
        />
      ) : (
        <EmptyState
          icon={FolderKanban}
          title="Start a project first"
          action={
            <Button asChild className="h-9">
              <Link href="/projects/new">New project</Link>
            </Button>
          }
        >
          Tasks belong to a project.
        </EmptyState>
      )}
    </div>
  );
}
