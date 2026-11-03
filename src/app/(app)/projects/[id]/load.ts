import "server-only";
import { notFound } from "next/navigation";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { getProject } from "@/server/records/projects";
import { loadStages } from "@/server/stages/service";

/** Shared start of every project tab: session, id check, the project or a 404. */
export async function loadProjectTab(params: Promise<{ id: string }>) {
  await requireSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const database = db();
  const row = await getProject(database, id);
  if (!row) notFound();
  return { id, database, row, archived: Boolean(row.project.archivedAt) };
}

/** The project's linear stages as select options (for "belongs to stage"). */
export async function stageOptions(database: ReturnType<typeof db>, projectId: string) {
  const stages = await loadStages(database, projectId);
  return stages.filter((s) => s.kind === "linear").map((s) => ({ value: s.id, label: s.name }));
}
