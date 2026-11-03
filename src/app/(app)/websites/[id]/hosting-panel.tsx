import Link from "next/link";
import { Lock, Server, TriangleAlert } from "lucide-react";
import { DeploymentState, ExternalUrl, providerName } from "@/components/deployments";
import { ActionButton } from "@/components/forms/action-button";
import { IntegrationHealth, StatusPill } from "@/components/status";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import type { listHostingLinks } from "@/server/integrations/hosting-sync";
import { archiveHostingLinkAction, refreshHostingLinkAction } from "../../integrations/actions";

type Row = Awaited<ReturnType<typeof listHostingLinks>>[number];

/** How to stop the provider auto-deploying to production (spec §1.1, decision 0010). */
const LOCK_HOW: Record<string, string> = {
  cloudflare:
    "Cloudflare Pages: Settings → Builds & deployments → Configure Production deployments, untick “Enable automatic production branch deployments”, and save.",
  netlify: "Netlify: Deploys → “Lock to stop auto publishing” on the published deploy.",
  vercel: "Vercel: Settings → Environments → Production → turn off “Auto-assign Custom Production Domains” (deploys are then staged until promoted).",
};

function AutoPublish({ value }: { value: string }) {
  if (value === "locked") return <StatusPill icon={Lock} label="Auto-publish locked" tone="success" />;
  if (value === "disabled") return <StatusPill icon={Lock} label="Auto-deploy off" tone="success" />;
  if (value === "enabled") return <StatusPill icon={TriangleAlert} label="Auto-publish on" tone="warning" />;
  return <StatusPill icon={TriangleAlert} label="Auto-publish unknown" tone="warning" />;
}

export function HostingPanel({
  websiteId,
  row,
  current,
  readOnly,
}: {
  websiteId: string;
  row: Row;
  current: { state: string; deployUrl: string | null; commitSha: string | null; publishedAt: Date | null } | null;
  readOnly: boolean;
}) {
  const { link } = row;
  const manual = !link.integrationId;
  const label = `${providerName(link.provider)} ${link.environment}`;
  const showCaveat = !manual && link.environment === "production" && (link.autoPublish === "enabled" || link.autoPublish === "unknown");
  return (
    <Card>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Server className="size-4 text-muted-foreground" aria-hidden="true" />
            <h3 className="font-semibold">
              {providerName(link.provider)}
              {link.providerProjectName || link.providerProjectId ? (
                <span className="font-normal text-muted-foreground"> · {link.providerProjectName ?? link.providerProjectId}</span>
              ) : null}
            </h3>
            <span className="text-sm capitalize text-muted-foreground">{link.environment}</span>
            {manual ? <span className="text-xs text-muted-foreground">Manual record (not synced)</span> : <AutoPublish value={link.autoPublish} />}
          </div>
          {readOnly ? null : (
            <div className="flex flex-wrap gap-2">
              {manual ? null : (
                <ActionButton
                  action={refreshHostingLinkAction.bind(null, websiteId, link.id)}
                  label="Refresh deployments"
                  pendingLabel="Refreshing…"
                  accessibleLabel={`Refresh ${label} deployments`}
                />
              )}
              <ActionButton action={archiveHostingLinkAction.bind(null, websiteId, link.id)} label="Unlink" variant="ghost" accessibleLabel={`Unlink ${label}`} />
            </div>
          )}
        </div>

        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {link.domain ? <span>Domain {link.domain}.</span> : null}
          {manual ? null : (
            <>
              Via{" "}
              <Link href="/integrations" className="text-primary hover:underline">
                {row.integrationName}
              </Link>
              {row.integrationHealth ? <IntegrationHealth health={row.integrationHealth} /> : null}
              <span>Last synced {link.lastSyncedAt ? formatDateTime(link.lastSyncedAt) : "never"}.</span>
            </>
          )}
        </p>
        {row.integrationHealth && row.integrationHealth !== "ok" && row.integrationHealthDetail ? (
          <p className="text-sm text-muted-foreground">{row.integrationHealthDetail}</p>
        ) : null}

        {link.environment === "production" && !manual ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Live now:</span>
            {current ? (
              <>
                <DeploymentState state={current.state} />
                {current.commitSha ? <code className="font-mono text-xs">{current.commitSha.slice(0, 7)}</code> : null}
                {current.deployUrl ? <ExternalUrl href={current.deployUrl}>{current.deployUrl.replace(/^https:\/\//, "")}</ExternalUrl> : null}
                {current.publishedAt ? <span className="text-muted-foreground">since {formatDateTime(current.publishedAt)}</span> : null}
              </>
            ) : (
              <span className="text-muted-foreground">not known yet</span>
            )}
          </div>
        ) : null}

        {showCaveat ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              <strong>SiteSync can&apos;t stop this host from auto-deploying to production on push or merge.</strong> With
              auto-publishing {link.autoPublish === "enabled" ? "on" : "possibly on"}, code merged to the production branch
              can go live without SiteSync&apos;s approval. {LOCK_HOW[link.provider] ?? ""}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
