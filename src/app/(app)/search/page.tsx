import type { Metadata } from "next";
import Link from "next/link";
import { Building2, FolderKanban, Globe, ListChecks, SearchX, type LucideIcon } from "lucide-react";
import { EmptyState, PageHeader, Section } from "@/components/page";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { searchRecords, type SearchHit } from "@/server/records/search";

export const metadata: Metadata = { title: "Search" };

const GROUPS: { type: SearchHit["type"]; title: string; icon: LucideIcon }[] = [
  { type: "client", title: "Clients", icon: Building2 },
  { type: "website", title: "Websites", icon: Globe },
  { type: "project", title: "Projects", icon: FolderKanban },
  { type: "task", title: "Tasks", icon: ListChecks },
];

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  await requireSession();
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim().slice(0, 100) : "";
  const hits = query.length >= 2 ? await searchRecords(db(), query) : [];

  return (
    <div className="grid gap-6">
      <PageHeader crumbs={[{ label: "Search" }]} title={query ? `Results for “${query}”` : "Search"} />
      {query.length < 2 ? (
        <p className="text-sm text-muted-foreground">Type at least two characters in the search box (Ctrl K).</p>
      ) : hits.length === 0 ? (
        <EmptyState icon={SearchX} title="Nothing found">
          No live clients, websites, projects or tasks match. Archived records aren&apos;t searched.
        </EmptyState>
      ) : (
        GROUPS.map(({ type, title, icon: Icon }) => {
          const group = hits.filter((hit) => hit.type === type);
          if (!group.length) return null;
          return (
            <Section key={type} title={title}>
              <ul className="grid gap-2">
                {group.map((hit) => (
                  <li key={hit.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-2.5">
                    <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                    <Link href={hit.href} className="font-medium text-primary hover:underline">
                      {hit.title}
                    </Link>
                    {hit.detail ? <span className="text-sm text-muted-foreground">{hit.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </Section>
          );
        })
      )}
    </div>
  );
}
