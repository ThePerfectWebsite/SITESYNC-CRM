// Global search (spec §9): clients, websites and projects by name, code or
// domain. Substring matches rank first, then trigram similarity (pg_trgm),
// which also catches small typos. Tasks join in Phase 2.
import { and, desc, eq, ilike, isNull, or, sql, type AnyColumn } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { clients, projects, websites } from "../db/schema";
import { escapeLike } from "./fields";

export type SearchHit = {
  type: "client" | "website" | "project";
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

  const [clientRows, websiteRows, projectRows] = await Promise.all([
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
  ];
}
