import Link from "next/link";
import { ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { ActionButton } from "@/components/forms/action-button";
import { CheckPill, IntegrationHealth } from "@/components/status";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import type { listRepositoryLinks, repositorySummary } from "@/server/integrations/repo-links";
import { archiveRepositoryLinkAction, refreshRepositoryLinkAction } from "../../integrations/actions";

type LinkRow = Awaited<ReturnType<typeof listRepositoryLinks>>[number];
type Summary = Awaited<ReturnType<typeof repositorySummary>>;

/** Displays a provider URL (never fetched); opens in a new tab. */
function External({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-primary hover:underline">
      {children}
      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">(opens GitHub in a new tab)</span>
    </a>
  );
}

export function RepositoryPanel({
  websiteId,
  row,
  summary,
  readOnly,
}: {
  websiteId: string;
  row: LinkRow;
  summary: Summary;
  readOnly: boolean;
}) {
  const { link } = row;
  const name = `${link.owner}/${link.repo}`;
  return (
    <Card>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">
              <External href={`https://github.com/${link.owner}/${link.repo}`}>{name}</External>
            </h3>
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <GitBranch className="size-3.5" aria-hidden="true" />
              {link.productionBranch}
            </span>
            {link.isPrimary ? <span className="text-xs text-muted-foreground">Primary</span> : null}
          </div>
          {readOnly ? null : (
            <div className="flex flex-wrap gap-2">
              <ActionButton
                action={refreshRepositoryLinkAction.bind(null, websiteId, link.id)}
                label="Refresh from GitHub"
                pendingLabel="Refreshing…"
                accessibleLabel={`Refresh ${name} from GitHub`}
              />
              <ActionButton
                action={archiveRepositoryLinkAction.bind(null, websiteId, link.id)}
                label="Unlink"
                variant="ghost"
                accessibleLabel={`Unlink ${name}`}
              />
            </div>
          )}
        </div>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          Via{" "}
          <Link href="/integrations" className="text-primary hover:underline">
            {row.integrationName}
          </Link>
          <IntegrationHealth health={row.integrationHealth} />
          <span>Last synced {link.lastSyncedAt ? formatDateTime(link.lastSyncedAt) : "never"}.</span>
          {summary.headSha ? (
            <span>
              Head <code className="font-mono">{summary.headSha.slice(0, 7)}</code>
            </span>
          ) : null}
        </p>
        {row.integrationHealth !== "ok" && row.integrationHealthDetail ? (
          <p className="text-sm text-muted-foreground">{row.integrationHealthDetail}</p>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-3">
          <section aria-label={`Checks on the head of ${link.productionBranch}`} className="grid content-start gap-2">
            <h4 className="text-sm font-semibold">Checks on {link.productionBranch}</h4>
            {summary.checks.length ? (
              <ul className="grid gap-1.5">
                {summary.checks.map((check) => (
                  <li key={check.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <CheckPill state={check.state} conclusion={check.conclusion} />
                    <External href={check.htmlUrl}>{check.title}</External>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No checks reported{summary.headSha ? "" : " (not synced yet)"}.</p>
            )}
          </section>

          <section aria-label="Recent commits" className="grid content-start gap-2">
            <h4 className="text-sm font-semibold">Recent commits</h4>
            {summary.commits.length ? (
              <ul className="grid gap-1.5">
                {summary.commits.map((commit) => (
                  <li key={commit.id} className="grid text-sm">
                    <span className="flex items-center gap-1.5">
                      <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <External href={commit.htmlUrl}>
                        <code className="font-mono">{commit.commitSha?.slice(0, 7)}</code>
                      </External>
                      <span className="truncate">{commit.title}</span>
                    </span>
                    <span className="pl-5 text-xs text-muted-foreground">
                      {commit.authorLogin ?? "unknown"}, {formatDateTime(commit.occurredAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None yet.</p>
            )}
          </section>

          <section aria-label="Open pull requests" className="grid content-start gap-2">
            <h4 className="text-sm font-semibold">Open pull requests into {link.productionBranch}</h4>
            {summary.pullsIntoProduction.length ? (
              <ul className="grid gap-1.5">
                {summary.pullsIntoProduction.map((pr) => (
                  <li key={pr.id} className="flex items-start gap-1.5 text-sm">
                    <GitPullRequest className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span>
                      <External href={pr.htmlUrl}>#{pr.providerEventId}</External> {pr.title}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None.</p>
            )}
            {summary.otherPulls.length ? (
              <p className="text-xs text-muted-foreground">
                {summary.otherPulls.length} more open into other branches.
              </p>
            ) : null}
          </section>
        </div>
      </CardContent>
    </Card>
  );
}
