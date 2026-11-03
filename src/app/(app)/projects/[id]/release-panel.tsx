import Link from "next/link";
import { Rocket, RotateCcw } from "lucide-react";
import { DispatchState, ExternalUrl, providerName } from "@/components/deployments";
import { ActionButton } from "@/components/forms/action-button";
import { FormMessage } from "@/components/forms/controls";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { preflightHref } from "@/lib/release";
import type { listApprovalsForProject, releasesForProject } from "@/server/deploy/approvals";
import type { releaseOptions } from "@/server/deploy/preflight";
import { recheckReleaseAction } from "./deploy/actions";

type Options = Awaited<ReturnType<typeof releaseOptions>>;
type Release = Awaited<ReturnType<typeof releasesForProject>>[number];
type Approval = Awaited<ReturnType<typeof listApprovalsForProject>>[number];

const NOTICE: Record<string, { message: string; tone: "success" | "error" }> = {
  dispatched: { message: "Release sent to the host. SiteSync is waiting for it to confirm; this page shows the result.", tone: "success" },
  dispatch_failed: { message: "The host didn't accept the release. See the details below.", tone: "error" },
  rechecked: { message: "Re-checked with the host.", tone: "success" },
};

const ACTION_NAMES = { promote: "Promote", rollback: "Rollback", build_from_ref: "Build" } as const;

/** Release section of the overview (spec §8.2, and the §5.3 recovery options). */
export function ReleasePanel({
  projectId,
  websiteId,
  canRelease,
  options,
  releases,
  awaiting,
  notice,
}: {
  projectId: string;
  websiteId: string;
  canRelease: boolean;
  options: Options;
  releases: Release[];
  awaiting: Approval | null;
  notice?: string;
}) {
  const latest = releases[0] ?? null;
  const dispatchState = latest?.deployment.dispatchState ?? "";
  const inFlight = ["pending", "dispatched", "confirming"].includes(dispatchState);
  const needsRecovery = ["dispatch_failed", "confirmed_failure", "timed_out"].includes(dispatchState);
  const shown = notice ? NOTICE[notice] : undefined;

  if (!options) {
    return (
      <p className="text-sm text-muted-foreground">
        SiteSync releases through a connected host.{" "}
        <Link href={`/websites/${websiteId}`} className="text-primary hover:underline">
          Link Cloudflare Pages, Netlify or Vercel on the website page
        </Link>{" "}
        to release from here.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {shown ? <FormMessage message={shown.message} tone={shown.tone} /> : null}

      {awaiting ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-950">
          An approval is waiting for your password (expires {formatDateTime(awaiting.approval.expiresAt)}).{" "}
          <Link href={`/approvals/${awaiting.approval.id}/confirm`} className="font-medium underline">
            Confirm or revoke it
          </Link>
        </div>
      ) : null}

      {latest ? (
        <Card>
          <CardContent className="grid gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">Latest release</h3>
              <DispatchState state={dispatchState || "unknown"} />
              <span className="text-muted-foreground">
                {ACTION_NAMES[latest.action]} of <code className="font-mono text-xs">{latest.targetCommitSha.slice(0, 7)}</code> ·{" "}
                {formatDateTime(latest.deployment.createdAt)}
              </span>
            </div>
            {latest.deployment.errorSummary ? <p className="text-muted-foreground">{latest.deployment.errorSummary}</p> : null}
            {inFlight || needsRecovery ? (
              <div className="flex flex-wrap items-start gap-3">
                {dispatchState !== "dispatch_failed" ? (
                  <ActionButton
                    action={recheckReleaseAction.bind(null, projectId, latest.deployment.id)}
                    label="Re-check now"
                    pendingLabel="Checking…"
                  />
                ) : null}
                {latest.deployment.deployUrl ? (
                  <ExternalUrl href={latest.deployment.deployUrl}>Open the deploy on {providerName(latest.deployment.provider)}</ExternalUrl>
                ) : null}
              </div>
            ) : null}
            {needsRecovery ? (
              <p className="text-muted-foreground">
                The project stays where it is. Start a new approval below, or roll back if the live site is affected.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {canRelease && !inFlight && !awaiting ? (
        <Card>
          <CardContent className="grid gap-3 text-sm">
            <h3 className="font-semibold">Release to production</h3>
            {options.capabilities.buildFromRef ? (
              <div>
                <Button asChild>
                  <Link href={preflightHref(projectId, "build_from_ref")}>
                    <Rocket aria-hidden="true" /> Review a release of the production branch
                  </Link>
                </Button>
              </div>
            ) : null}
            {options.capabilities.promote ? (
              options.promotable.length ? (
                <ul className="grid gap-2" aria-label="Built deploys waiting to go live">
                  {options.promotable.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-xs">{d.commitSha!.slice(0, 7)}</code>
                      <span className="text-muted-foreground">{formatDateTime(d.providerCreatedAt)}</span>
                      <Link href={preflightHref(projectId, "promote", d.id)} className="text-primary hover:underline">
                        Review and promote
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">
                  No built production deploy is waiting. With auto-publishing locked, the host builds production deploys
                  without publishing them; they appear here after the next sync.
                </p>
              )
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {!inFlight && !awaiting && options.rollbackTargets.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-primary">
            <RotateCcw className="mr-1 inline size-4" aria-hidden="true" />
            Roll back production
          </summary>
          <ul className="mt-2 grid gap-2" aria-label="Earlier production deploys">
            {options.rollbackTargets.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs">{d.commitSha!.slice(0, 7)}</code>
                <span className="text-muted-foreground">earlier live deploy · {formatDateTime(d.publishedAt ?? d.providerCreatedAt)}</span>
                <Link href={preflightHref(projectId, "rollback", d.id)} className="text-primary hover:underline">
                  Review rollback
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
