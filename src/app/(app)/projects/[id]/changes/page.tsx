import type { Metadata } from "next";
import Link from "next/link";
import { GitPullRequestArrow } from "lucide-react";
import { EmptyState, Section } from "@/components/page";
import { ArchivedPill, ChangeStatus } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CHANGE_CATEGORY_LABELS, formatDateTime } from "@/lib/format";
import { listChanges } from "@/server/records/changes";
import { listContacts } from "@/server/records/contacts";
import { listTasks } from "@/server/records/tasks";
import { createChangeAction } from "../../work-actions";
import { ChangeForm } from "../../work-forms";
import { loadProjectTab } from "../load";

export const metadata: Metadata = { title: "Project changes" };

export default async function ProjectChangesPage({ params, searchParams }: PageProps<"/projects/[id]/changes">) {
  const { id, database, row, archived } = await loadProjectTab(params);
  const includeArchived = (await searchParams).archived === "1";
  const [rows, contacts, tasks] = await Promise.all([
    listChanges(database, id, includeArchived),
    listContacts(database, row.project.clientId),
    listTasks(database, id, { includeClosed: true }),
  ]);

  return (
    <div className="grid gap-8">
      <Section
        title="Changes"
        actions={
          <Link
            href={includeArchived ? `/projects/${id}/changes` : `/projects/${id}/changes?archived=1`}
            className="text-sm text-primary hover:underline"
          >
            {includeArchived ? "Hide archived" : "Show archived"}
          </Link>
        }
      >
        <p className="text-sm text-muted-foreground">What was asked for and what shipped, one entry per scoped change.</p>
        {rows.length === 0 ? (
          <EmptyState icon={GitPullRequestArrow} title="No changes logged" />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader className="bg-card lg:sticky lg:top-14 lg:z-[1]">
                <TableRow>
                  <TableHead>Change</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Requested by</TableHead>
                  <TableHead>Logged</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ change, contactName }) => (
                  <TableRow key={change.id}>
                    <TableCell className="max-w-80 whitespace-normal">
                      <Link href={`/projects/${id}/changes/${change.id}`} className="font-medium text-primary hover:underline">
                        {change.title}
                      </Link>
                    </TableCell>
                    <TableCell>{CHANGE_CATEGORY_LABELS[change.category]}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        <ChangeStatus status={change.status} />
                        {change.archivedAt ? <ArchivedPill /> : null}
                      </span>
                    </TableCell>
                    <TableCell>{contactName ?? "—"}</TableCell>
                    <TableCell>{formatDateTime(change.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      {archived ? null : (
        <Section title="Log a change">
          <ChangeForm
            action={createChangeAction.bind(null, id)}
            submitLabel="Log change"
            idPrefix="new-change"
            contacts={contacts.map((c) => ({ value: c.id, label: c.name }))}
            tasks={tasks.map(({ task }) => ({ value: task.id, label: task.title }))}
          />
        </Section>
      )}
    </div>
  );
}
