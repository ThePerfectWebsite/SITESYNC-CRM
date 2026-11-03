import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleCheck, CircleX, Clock, TriangleAlert } from "lucide-react";
import { AutoPublishCaveat, AutoPublishPill, DeploymentState, ExternalUrl, providerName } from "@/components/deployments";
import { ActionButton } from "@/components/forms/action-button";
import { FormMessage } from "@/components/forms/controls";
import { Details, Section } from "@/components/page";
import { StatusPill } from "@/components/status";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { APPROVAL_ACTIONS, type ApprovalAction } from "@/server/db/schema";
import { ACTION_LABELS, buildPreflight, type PreflightDeploy } from "@/server/deploy/preflight";
import { approveReleaseAction, refreshPreflightAction } from "../actions";
import { ApproveForm } from "./approve-form";

export const metadata: Metadata = { title: "Release preflight" };

export default async function PreflightPage({ params, searchParams }: PageProps<"/projects/[id]/deploy/preflight">) {
  await requireSession();
  const { id } = await params;
  const query = await searchParams;
  if (!isUuid(id)) notFound();
  const action = typeof query.action === "string" && (APPROVAL_ACTIONS as readonly string[]).includes(query.action) ? (query.action as ApprovalAction) : null;
  const target = typeof query.target === "string" && isUuid(query.target) ? query.target : null;
  if (!action) notFound();
  const preflight = await buildPreflight(db(), id, { action, targetDeploymentId: target });
  if (!preflight) notFound();
  const { link, readiness } = preflight;
  const refreshed = query.refreshed === "1";

  return (
    <div className="grid max-w-4xl gap-8">
      <div className="grid gap-2">
        <h2 className="text-xl font-semibold">{ACTION_LABELS[action]}</h2>
        <p className="text-sm text-muted-foreground">
          Check what would change, then approve. Nothing is sent to the host until you confirm with your password.
        </p>
        {refreshed ? <FormMessage tone="success" message="Refreshed from the provider just now." /> : null}
      </div>

      <Section title="Target">
        <Card>
          <CardContent className="grid gap-3">
            <Details
              items={[
                ["Client", preflight.project.clientName],
                ["Website", <Link key="w" href={`/websites/${preflight.project.websiteId}`} className="text-primary hover:underline">{preflight.project.websiteName}</Link>],
                ["Project stage", preflight.project.stageName],
                ["Production domain", link?.domain ?? "—"],
                [
                  "Host",
                  link ? (
                    <span key="h" className="flex flex-wrap items-center gap-2">
                      {providerName(link.provider)}
                      {link.providerProjectName || link.providerProjectId ? (
                        <span className="text-muted-foreground">· {link.providerProjectName ?? link.providerProjectId}</span>
                      ) : null}
                      {link.integrationId ? <AutoPublishPill value={link.autoPublish} /> : null}
                    </span>
                  ) : (
                    "None"
                  ),
                ],
              ]}
            />
            {link?.integrationId ? <AutoPublishCaveat provider={link.provider} value={link.autoPublish} /> : null}
          </CardContent>
        </Card>
      </Section>

      <Section title="What changes">
        <div className="grid gap-3 md:grid-cols-2">
          <DeployCard title="Live now" deploy={preflight.current} empty="Nothing is live yet." />
          {action === "build_from_ref" ? (
            <Card>
              <CardContent className="grid gap-2 text-sm">
                <h3 className="font-semibold">Proposed</h3>
                <p>
                  A new production build of <strong>{preflight.productionBranch ?? "the production branch"}</strong> at{" "}
                  {preflight.targetCommitSha ? <code className="font-mono text-xs">{preflight.targetCommitSha.slice(0, 7)}</code> : "an unknown commit"}.
                </p>
                <p className="text-muted-foreground">
                  The host builds the branch&apos;s latest commit. SiteSync checks it&apos;s still this one before sending, and
                  checks the finished build&apos;s commit before marking Live.
                </p>
              </CardContent>
            </Card>
          ) : (
            <DeployCard title="Proposed" deploy={preflight.target} empty="Choose a deploy from the project overview." />
          )}
        </div>
        {preflight.compareUrl ? (
          <p className="text-sm">
            <ExternalUrl href={preflight.compareUrl}>Compare live and proposed on GitHub</ExternalUrl>
          </p>
        ) : null}
      </Section>

      <Section title="Checks and readiness">
        <Card>
          <CardContent className="grid gap-4 text-sm">
            <div className="grid gap-2">
              <h3 className="font-semibold">GitHub checks on the proposed commit</h3>
              {preflight.checks.length ? (
                <ul className="grid gap-1">
                  {preflight.checks.map((check) => (
                    <li key={check.name} className="flex flex-wrap items-center gap-2">
                      <CheckPill state={check.state} conclusion={check.conclusion} />
                      {check.htmlUrl ? <ExternalUrl href={check.htmlUrl}>{check.name}</ExternalUrl> : check.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">{preflight.repository ? "No checks reported for this commit." : "No GitHub repository linked."}</p>
              )}
            </div>
            <div className="grid gap-2">
              <h3 className="font-semibold">Open pull requests into the production branch</h3>
              {preflight.openPullRequests.length ? (
                <ul className="grid gap-1">
                  {preflight.openPullRequests.map((pr) => (
                    <li key={pr.number}>
                      {pr.htmlUrl ? <ExternalUrl href={pr.htmlUrl}>#{pr.number}</ExternalUrl> : `#${pr.number}`} {pr.title}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">None. (Shown for information; open pull requests don&apos;t block.)</p>
              )}
            </div>
            <div className="grid gap-2">
              <h3 className="font-semibold">Readiness</h3>
              {readiness.blockers.length ? (
                <ul className="grid gap-1" aria-label="Blockers">
                  {readiness.blockers.map((b) => (
                    <li key={b.key} className="flex items-start gap-2">
                      <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                      <span>{b.label}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2">
                  <CircleCheck className="size-4 text-success" aria-hidden="true" /> No open blockers.
                </p>
              )}
              {readiness.waived.length ? (
                <ul className="grid gap-1 text-muted-foreground" aria-label="Waived">
                  {readiness.waived.map(({ blocker, waiver }) => (
                    <li key={blocker.key}>
                      Waived: {blocker.label} ({waiver.reason}, by {waiver.waivedByName ?? "operator"})
                    </li>
                  ))}
                </ul>
              ) : null}
              {readiness.blockers.length ? (
                <p>
                  <Link href={`/projects/${id}`} className="text-primary hover:underline">
                    Resolve or waive blockers on the overview
                  </Link>
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Data freshness">
        <Card>
          <CardContent className="grid gap-3 text-sm">
            <Details
              items={[
                ["Host last synced", link?.integrationId ? formatDateTime(link.lastSyncedAt) : "—"],
                ["Repository last synced", preflight.repository ? formatDateTime(preflight.repository.lastSyncedAt) : "—"],
              ]}
            />
            <ActionButton
              action={refreshPreflightAction.bind(null, id, action, target ?? "")}
              label="Refresh from provider"
              pendingLabel="Refreshing…"
            />
          </CardContent>
        </Card>
      </Section>

      <Section title="Approve">
        {preflight.problems.length ? (
          <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <ul className="grid gap-1">
              {preflight.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {preflight.awaitingApprovalId ? (
          <p className="text-sm">
            <Link href={`/approvals/${preflight.awaitingApprovalId}/confirm`} className="text-primary hover:underline">
              Open the waiting approval
            </Link>
          </p>
        ) : null}
        <ApproveForm
          action={approveReleaseAction.bind(null, id)}
          releaseAction={action}
          targetDeploymentId={target}
          preflightHash={preflight.hash}
          disabled={!preflight.canApprove}
        />
      </Section>
    </div>
  );
}

function DeployCard({ title, deploy, empty }: { title: string; deploy: PreflightDeploy | null; empty: string }) {
  return (
    <Card>
      <CardContent className="grid gap-2 text-sm">
        <h3 className="font-semibold">{title}</h3>
        {deploy ? (
          <Details
            items={[
              ["State", <DeploymentState key="s" state={deploy.state} />],
              ["Deploy", <code key="d" className="font-mono text-xs">{deploy.providerDeploymentId ?? deploy.deploymentId}</code>],
              ["Commit", deploy.commitSha ? <code key="c" className="font-mono text-xs">{deploy.commitSha.slice(0, 7)}</code> : "—"],
              ["URL", deploy.deployUrl ? <ExternalUrl key="u" href={deploy.deployUrl}>{deploy.deployUrl.replace(/^https:\/\//, "")}</ExternalUrl> : "—"],
              ["Published", formatDateTime(deploy.publishedAt)],
              ["Last confirmed", formatDateTime(deploy.lastConfirmedAt)],
            ]}
          />
        ) : (
          <p className="text-muted-foreground">{empty}</p>
        )}
      </CardContent>
    </Card>
  );
}

function CheckPill({ state, conclusion }: { state: string; conclusion: string | null }) {
  if (state !== "completed") return <StatusPill icon={Clock} label="Running" tone="info" />;
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") return <StatusPill icon={CircleCheck} label="Passed" tone="success" />;
  return <StatusPill icon={CircleX} label={conclusion ?? "Failed"} tone="danger" />;
}
