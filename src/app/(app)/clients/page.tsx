import type { Metadata } from "next";
import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page";
import { ArchivedPill, ClientStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CLIENT_STATUS_LABELS } from "@/lib/format";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { CLIENT_STATUSES, type ClientStatus as Status } from "@/server/db/schema";
import { listClients } from "@/server/records/clients";

export const metadata: Metadata = { title: "Clients" };

export default async function ClientsPage({ searchParams }: PageProps<"/clients">) {
  await requireSession();
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.slice(0, 100) : "";
  const status = CLIENT_STATUSES.find((s) => s === params.status) ?? null;
  const includeArchived = params.archived === "1";
  const rows = await listClients(db(), { q, status, includeArchived });
  const filtered = Boolean(q || status || includeArchived);

  return (
    <div className="grid gap-6">
      <PageHeader
        crumbs={[{ label: "Clients" }]}
        title="Clients"
        actions={
          <Button asChild className="h-9">
            <Link href="/clients/new">
              <Plus aria-hidden="true" />
              New client
            </Link>
          </Button>
        }
      />

      <form role="search" aria-label="Filter clients" className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="filter-q">Search</Label>
          <Input id="filter-q" name="q" type="search" defaultValue={q} placeholder="Name or slug" className="h-9 w-64" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="filter-status">Status</Label>
          <select
            id="filter-status"
            name="status"
            defaultValue={status ?? ""}
            className="h-9 rounded-md border border-input bg-card px-2.5 text-sm"
          >
            <option value="">Any status</option>
            {CLIENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CLIENT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
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
            <Link href="/clients">Clear</Link>
          </Button>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={filtered ? "No clients match" : "No clients yet"}
          action={
            filtered ? null : (
              <Button asChild className="h-9">
                <Link href="/clients/new">Add your first client</Link>
              </Button>
            )
          }
        >
          {filtered ? "Try a different search or filter." : "Clients own websites, and websites have projects."}
        </EmptyState>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader className="bg-card lg:sticky lg:top-14 lg:z-[1]">
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Websites</TableHead>
                <TableHead className="text-right">Projects</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/clients/${row.id}`} className="font-medium text-primary hover:underline">
                      {row.name}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">{row.slug}</span>
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      <ClientStatus status={row.status as Status} />
                      {row.archivedAt ? <ArchivedPill /> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.websiteCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.projectCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
