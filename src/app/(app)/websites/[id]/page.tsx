import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PlugZap, Pencil, Plus } from "lucide-react";
import { ActionButton } from "@/components/forms/action-button";
import { FormMessage } from "@/components/forms/controls";
import { Details, PageHeader, Section } from "@/components/page";
import { DeploymentsTable } from "@/components/deployments";
import { ActivityFeed, ProjectsTable } from "@/components/records";
import { ArchivedPill, WebsiteStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { listRepositoryLinks, repositorySummary } from "@/server/integrations/repo-links";
import { listDeploymentsForWebsite, listHostingLinks, liveAndLatestPreview } from "@/server/integrations/hosting-sync";
import { listIntegrations, PROVIDER_LABELS } from "@/server/integrations/service";
import { listActivity } from "@/server/records/activity";
import { listProjects } from "@/server/records/projects";
import { getWebsite } from "@/server/records/websites";
import { createHostingLinkAction, createRepositoryLinkAction } from "../../integrations/actions";
import { archiveWebsiteAction, restoreWebsiteAction } from "../actions";
import { HostingLinkForm } from "./hosting-link-form";
import { HostingPanel } from "./hosting-panel";
import { RepoLinkForm } from "./repo-link-form";
import { RepositoryPanel } from "./repository-panel";

export async function generateMetadata({ params }: PageProps<"/websites/[id]">): Promise<Metadata> {
  const { id } = await params;
  const row = isUuid(id) ? await getWebsite(db(), id) : null;
  return { title: row?.website.name ?? "Website" };
}

const REFRESH_NOTICES: Record<string, string> = {
  queued: "Refresh queued. It runs in the background; reload in a moment to see the results.",
  already_queued: "A refresh for this repository is already queued.",
  ran_inline: "Refreshed from GitHub.",
};

export default async function WebsitePage({ params, searchParams }: PageProps<"/websites/[id]">) {
  await requireSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const database = db();
  const row = await getWebsite(database, id);
  if (!row) notFound();
  const { website, clientName } = row;
  const archived = Boolean(website.archivedAt);
  const refreshNotice = REFRESH_NOTICES[String((await searchParams).refresh)];
  const [hosts, history, { live }, allIntegrations] = await Promise.all([
    listHostingLinks(database, id),
    listDeploymentsForWebsite(database, id, 25),
    liveAndLatestPreview(database, id),
    listIntegrations(database),
  ]);
  const hostingIntegrations = allIntegrations
    .filter((i) => i.provider !== "github")
    .map((i) => ({ id: i.id, name: `${i.name} (${PROVIDER_LABELS[i.provider]})`, provider: i.provider }));
  const [links, githubIntegrations] = await Promise.all([
    listRepositoryLinks(database, id),
    listIntegrations(database).then((all) => all.filter((i) => i.provider === "github")),
  ]);
  const repos = await Promise.all(links.map(async (row) => ({ row, summary: await repositorySummary(database, row.link) })));
  const [projects, activity] = await Promise.all([
    listProjects(database, { websiteId: id, includeArchived: true }),
    listActivity(database, { websiteId: id }, 20),
  ]);

  return (
    <div className="grid gap-8">
      <PageHeader
        crumbs={[
          { label: "Clients", href: "/clients" },
          { label: clientName, href: `/clients/${website.clientId}` },
          { label: website.name },
        ]}
        title={website.name}
        meta={
          <>
            <WebsiteStatus status={website.status} />
            {archived ? <ArchivedPill /> : null}
          </>
        }
        actions={
          archived ? (
            <ActionButton action={restoreWebsiteAction.bind(null, id)} label="Restore website" pendingLabel="Restoring…" />
          ) : (
            <>
              <Button asChild variant="outline" className="h-9">
                <Link href={`/websites/${id}/edit`}>
                  <Pencil aria-hidden="true" />
                  Edit
                </Link>
              </Button>
              <ActionButton action={archiveWebsiteAction.bind(null, id)} label="Archive website" pendingLabel="Archiving…" />
            </>
          )
        }
      />

      <Card>
        <CardContent>
          <Details
            items={[
              ["Client", <Link key="c" href={`/clients/${website.clientId}`} className="text-primary hover:underline">{clientName}</Link>],
              ["Primary domain", website.primaryDomain ?? "—"],
              ["Notes", website.notes ? <span className="whitespace-pre-wrap">{website.notes}</span> : "—"],
            ]}
          />
        </CardContent>
      </Card>

      <Section title="Repositories">
        {refreshNotice ? <FormMessage tone="success" message={refreshNotice} /> : null}
        {repos.length ? (
          repos.map(({ row, summary }) => (
            <RepositoryPanel key={row.link.id} websiteId={id} row={row} summary={summary} readOnly={archived} />
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No repository linked. Linking one shows commits, pull requests and checks here, and counts failing checks in
            release readiness.
          </p>
        )}
        {archived ? null : githubIntegrations.length ? (
          <details className="rounded-lg border bg-card p-4">
            <summary className="cursor-pointer text-sm font-medium text-primary">Link a GitHub repository</summary>
            <div className="mt-4">
              <RepoLinkForm
                action={createRepositoryLinkAction.bind(null, id)}
                integrations={githubIntegrations.map((i) => ({ value: i.id, label: i.name }))}
                hasPrimary={repos.length > 0}
              />
            </div>
          </details>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Link href="/integrations" className="text-primary hover:underline">
              Add a GitHub integration
            </Link>{" "}
            to link a repository.
          </p>
        )}
      </Section>

      <Section title="Hosting">
        {hosts.length ? (
          hosts.map((row) => (
            <HostingPanel
              key={row.link.id}
              websiteId={id}
              row={row}
              current={row.link.environment === "production" ? live : null}
              readOnly={archived}
            />
          ))
        ) : (
          <Card>
            <CardContent className="flex items-start gap-3 text-sm">
              <PlugZap className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="text-muted-foreground">
                No host linked. Until a production host is connected through an integration, SiteSync can&apos;t confirm a
                deploy, so this website&apos;s projects stop at Ready to Deploy and release readiness shows a blocker.
              </p>
            </CardContent>
          </Card>
        )}
        {archived ? null : (
          <details className="rounded-lg border bg-card p-4">
            <summary className="cursor-pointer text-sm font-medium text-primary">Link a host</summary>
            <div className="mt-4">
              <HostingLinkForm action={createHostingLinkAction.bind(null, id)} integrations={hostingIntegrations} />
            </div>
          </details>
        )}
      </Section>

      <Section title="Deploy history">
        {history.length ? (
          <DeploymentsTable rows={history} />
        ) : (
          <p className="text-sm text-muted-foreground">No deployments recorded yet.</p>
        )}
      </Section>

      <Section
        title="Projects"
        actions={
          archived ? null : (
            <Button asChild variant="outline" className="h-9">
              <Link href={`/projects/new?clientId=${website.clientId}&websiteId=${id}`}>
                <Plus aria-hidden="true" />
                New project
              </Link>
            </Button>
          )
        }
      >
        {projects.length ? <ProjectsTable rows={projects} hideClient /> : <p className="text-sm text-muted-foreground">No projects yet.</p>}
      </Section>

      <Section title="Activity">
        <ActivityFeed items={activity} />
      </Section>
    </div>
  );
}
