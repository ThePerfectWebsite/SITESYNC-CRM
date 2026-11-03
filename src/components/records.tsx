// Record tables and feeds shared by several screens.
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { ArchivedPill, StagePill } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/format";

export type ProjectRow = {
  id: string;
  name: string;
  code: string | null;
  targetLaunchDate: string | null;
  archivedAt: Date | null;
  clientId: string;
  clientName: string;
  websiteId: string;
  websiteName: string;
  stageName: string;
  stageKind: "linear" | "on_hold" | "archived";
  stageRole: "ready_to_deploy" | "live" | null;
  overdue: boolean;
};

export function ProjectsTable({ rows, hideClient = false }: { rows: ProjectRow[]; hideClient?: boolean }) {
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader className="bg-card lg:sticky lg:top-14 lg:z-[1]">
          <TableRow>
            <TableHead>Project</TableHead>
            {hideClient ? null : <TableHead>Client</TableHead>}
            <TableHead>Website</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>Target launch</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <Link href={`/projects/${row.id}`} className="font-medium text-primary hover:underline">
                  {row.name}
                </Link>
                {row.code ? <span className="ml-2 text-xs text-muted-foreground">{row.code}</span> : null}
              </TableCell>
              {hideClient ? null : (
                <TableCell>
                  <Link href={`/clients/${row.clientId}`} className="hover:underline">
                    {row.clientName}
                  </Link>
                </TableCell>
              )}
              <TableCell>
                <Link href={`/websites/${row.websiteId}`} className="hover:underline">
                  {row.websiteName}
                </Link>
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap gap-1">
                  <StagePill name={row.stageName} kind={row.stageKind} role={row.stageRole} />
                  {row.archivedAt && row.stageKind !== "archived" ? <ArchivedPill /> : null}
                </span>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5">
                  {formatDate(row.targetLaunchDate)}
                  {row.overdue ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                      <AlertTriangle className="size-3.5" aria-hidden="true" />
                      Overdue
                    </span>
                  ) : null}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export type ActivityItem = {
  id: string;
  createdAt: Date;
  summary: string;
  actorType: string;
  actorName: string | null;
  reason?: string | null;
};

export function ActivityFeed({ items, empty = "No activity yet." }: { items: ActivityItem[]; empty?: string }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ol className="grid gap-0 rounded-lg border bg-card">
      {items.map((item) => (
        <li key={item.id} className="grid gap-0.5 border-b px-4 py-2.5 last:border-b-0">
          <p className="text-sm">{item.summary}</p>
          {item.reason ? <p className="text-sm text-muted-foreground">Reason: {item.reason}</p> : null}
          <p className="text-xs text-muted-foreground">
            <time dateTime={item.createdAt.toISOString()}>{formatDateTime(item.createdAt)}</time>
            {" · "}
            {item.actorType === "user" ? (item.actorName ?? "Operator") : item.actorType === "system" ? "SiteSync" : "Provider"}
          </p>
        </li>
      ))}
    </ol>
  );
}
