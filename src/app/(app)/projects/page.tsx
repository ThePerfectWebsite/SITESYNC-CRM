import type { Metadata } from "next";
import Link from "next/link";
import { FolderKanban, Plus } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page";
import { ProjectsTable } from "@/components/records";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { clientOptions } from "@/server/records/clients";
import { listProjects, stageFilterOptions } from "@/server/records/projects";

export const metadata: Metadata = { title: "Projects" };

const selectClass = "h-9 rounded-md border border-input bg-card px-2.5 text-sm";

export default async function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  await requireSession();
  const params = await searchParams;
  const database = db();
  const [clients, stages] = await Promise.all([clientOptions(database), stageFilterOptions(database)]);

  const q = typeof params.q === "string" ? params.q.slice(0, 100) : "";
  const clientId = isUuid(params.client) ? params.client : null;
  const stageKey = stages.find((s) => s.key === params.stage)?.key ?? null;
  const overdue = params.overdue === "1";
  const includeArchived = params.archived === "1";
  const rows = await listProjects(database, { q, clientId, stageKey, overdue, includeArchived });
  const filtered = Boolean(q || clientId || stageKey || overdue || includeArchived);

  return (
    <div className="grid gap-6">
      <PageHeader
        crumbs={[{ label: "Projects" }]}
        title="Projects"
        actions={
          <Button asChild className="h-9">
            <Link href="/projects/new">
              <Plus aria-hidden="true" />
              New project
            </Link>
          </Button>
        }
      />

      <form role="search" aria-label="Filter projects" className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="filter-q">Search</Label>
          <Input id="filter-q" name="q" type="search" defaultValue={q} placeholder="Name or code" className="h-9 w-56" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="filter-stage">Stage</Label>
          <select id="filter-stage" name="stage" defaultValue={stageKey ?? ""} className={selectClass}>
            <option value="">Any stage</option>
            {stages.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="filter-client">Client</Label>
          <select id="filter-client" name="client" defaultValue={clientId ?? ""} className={selectClass}>
            <option value="">Any client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex h-9 items-center gap-2">
          <input id="filter-overdue" name="overdue" value="1" type="checkbox" defaultChecked={overdue} className="size-4 accent-primary" />
          <Label htmlFor="filter-overdue">Overdue only</Label>
        </div>
        <div className="flex h-9 items-center gap-2">
          <input id="filter-archived" name="archived" value="1" type="checkbox" defaultChecked={includeArchived} className="size-4 accent-primary" />
          <Label htmlFor="filter-archived">Show archived</Label>
        </div>
        <Button type="submit" variant="outline" className="h-9">
          Apply
        </Button>
        {filtered ? (
          <Button asChild variant="ghost" className="h-9">
            <Link href="/projects">Clear</Link>
          </Button>
        ) : null}
      </form>

      {rows.length ? (
        <>
          <p className="text-sm text-muted-foreground">
            {rows.length} project{rows.length === 1 ? "" : "s"}, soonest target launch first. Overdue means the target date has
            passed and the project hasn&apos;t reached Live.
          </p>
          <ProjectsTable rows={rows} />
        </>
      ) : (
        <EmptyState
          icon={FolderKanban}
          title={filtered ? "No projects match" : "No projects yet"}
          action={
            filtered ? null : (
              <Button asChild className="h-9">
                <Link href="/projects/new">Start a project</Link>
              </Button>
            )
          }
        >
          {filtered ? "Try a different search or filter." : "A project is a piece of work on one client website."}
        </EmptyState>
      )}
    </div>
  );
}
