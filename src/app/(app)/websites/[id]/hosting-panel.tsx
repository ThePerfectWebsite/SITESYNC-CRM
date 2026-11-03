import Link from "next/link";
import { Server } from "lucide-react";
import { AutoPublishCaveat, AutoPublishPill, DeploymentState, ExternalUrl, providerName } from "@/components/deployments";
import { ActionButton } from "@/components/forms/action-button";
import { IntegrationHealth } from "@/components/status";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import type { listHostingLinks } from "@/server/integrations/hosting-sync";
import { archiveHostingLinkAction, refreshHostingLinkAction } from "../../integrations/actions";

type Row = Awaited<ReturnType<typeof listHostingLinks>>[number];

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
            {manual ? <span className="text-xs text-muted-foreground">Manual record (not synced)</span> : <AutoPublishPill value={link.autoPublish} />}
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

        {showCaveat ? <AutoPublishCaveat provider={link.provider} value={link.autoPublish} /> : null}
      </CardContent>
    </Card>
  );
}
