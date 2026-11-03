import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FolderKanban } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { listProjects } from "@/server/records/projects";

export const metadata: Metadata = { title: "New change" };

// Quick-create (spec §9): a change's contacts and tasks depend on its project,
// so pick the project here and log the change on its Changes tab.
export default async function NewChangePage({ searchParams }: PageProps<"/changes/new">) {
  await requireSession();
  const { project } = await searchParams;
  const projects = await listProjects(db());
  if (isUuid(project) && projects.some((p) => p.id === project)) redirect(`/projects/${project}/changes`);

  return (
    <div className="grid gap-6">
      <PageHeader crumbs={[{ label: "New change" }]} title="New change" />
      {projects.length ? (
        <form className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="change-project">Project</Label>
            <select
              id="change-project"
              name="project"
              required
              defaultValue=""
              className="h-9 w-80 max-w-full rounded-md border border-input bg-card px-2.5 text-sm"
            >
              <option value="" disabled>
                Choose a project
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.clientName})
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" className="h-9">
            Continue
          </Button>
        </form>
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
          Changes belong to a project.
        </EmptyState>
      )}
    </div>
  );
}
