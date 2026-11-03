import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page";
import { StagePill } from "@/components/status";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { getProject } from "@/server/records/projects";
import { loadStages } from "@/server/stages/service";
import { ProjectTabs } from "./project-tabs";

export default async function ProjectLayout({ children, params }: LayoutProps<"/projects/[id]">) {
  await requireSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const database = db();
  const row = await getProject(database, id);
  if (!row) notFound();
  const current = (await loadStages(database, id)).find((s) => s.status === "current");

  return (
    <div className="grid gap-6">
      <PageHeader
        crumbs={[
          { label: "Projects", href: "/projects" },
          { label: row.clientName, href: `/clients/${row.project.clientId}` },
          { label: row.project.name },
        ]}
        title={row.project.name}
        meta={
          <>
            {row.project.code ? <span className="text-sm text-muted-foreground">{row.project.code}</span> : null}
            {current ? <StagePill name={current.name} kind={current.kind} role={current.role} /> : null}
          </>
        }
      />
      <ProjectTabs projectId={id} />
      {children}
    </div>
  );
}
