// Global search (spec §9): clients, websites, projects and tasks by name, code or
// domain. Substring matches rank first, then trigram similarity (pg_trgm),
// which also catches small typos. Archived records (and tasks of archived projects) are left out.
import { and, desc, eq, ilike, isNull, or, sql, type AnyColumn } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { clients, projects, tasks, websites } from "../db/schema";
import { escapeLike } from "./fields";

export type SearchHit = {
  type: "client" | "website" | "project" | "task";
  id: string;
  title: string;
  detail: string | null;
  href: string;
};

const PER_TYPE = 8;

export async function searchRecords(db: DbOrTx, rawQuery: string): Promise<SearchHit[]> {
  const q = rawQuery.trim().slice(0, 100);
  if (q.length < 2) return [];
  const like = `%${escapeLike(q)}%`;
  // `%` is pg_trgm's similarity operator (threshold 0.3); unlike similarity() > x it can use the GIN index.
  const similar = (column: AnyColumn) => sql`${column} % ${q}`;
  const score = (column: AnyColumn) =>
    sql<number>`(CASE WHEN ${column} ILIKE ${like} THEN 1 ELSE 0 END) + similarity(${column}, ${q})`;

  const [clientRows, websiteRows, projectRows, taskRows] = await Promise.all([
    db
      .select({ id: clients.id, name: clients.name, slug: clients.slug })
      .from(clients)
      .where(and(isNull(clients.archivedAt), or(ilike(clients.name, like), ilike(clients.slug, like), similar(clients.name))))
      .orderBy(desc(score(clients.name)))
      .limit(PER_TYPE),
    db
      .select({ id: websites.id, name: websites.name, domain: websites.primaryDomain, clientName: clients.name })
      .from(websites)
      .innerJoin(clients, eq(clients.id, websites.clientId))
      .where(
        and(
          isNull(websites.archivedAt),
          or(ilike(websites.name, like), ilike(websites.primaryDomain, like), similar(websites.name)),
        ),
      )
      .orderBy(desc(score(websites.name)))
      .limit(PER_TYPE),
    db
      .select({ id: projects.id, name: projects.name, code: projects.code, clientName: clients.name })
      .from(projects)
      .innerJoin(clients, eq(clients.id, projects.clientId))
      .where(
        and(isNull(projects.archivedAt), or(ilike(projects.name, like), ilike(projects.code, like), similar(projects.name))),
      )
      .orderBy(desc(score(projects.name)))
      .limit(PER_TYPE),
    db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, projectId: projects.id, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(isNull(tasks.archivedAt), isNull(projects.archivedAt), or(ilike(tasks.title, like), similar(tasks.title))),
      )
      .orderBy(desc(score(tasks.title)))
      .limit(PER_TYPE),
  ]);

  return [
    ...clientRows.map((r) => ({ type: "client" as const, id: r.id, title: r.name, detail: r.slug, href: `/clients/${r.id}` })),
    ...websiteRows.map((r) => ({
      type: "website" as const,
      id: r.id,
      title: r.name,
      detail: [r.domain, r.clientName].filter(Boolean).join(" · "),
      href: `/websites/${r.id}`,
    })),
    ...projectRows.map((r) => ({
      type: "project" as const,
      id: r.id,
      title: r.name,
      detail: [r.code, r.clientName].filter(Boolean).join(" · "),
      href: `/projects/${r.id}`,
    })),
    ...taskRows.map((r) => ({
      type: "task" as const,
      id: r.id,
      title: r.title,
      detail: r.projectName,
      href: `/projects/${r.projectId}/tasks/${r.id}`,
    })),
  ];
}
