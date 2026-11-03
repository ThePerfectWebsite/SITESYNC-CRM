// Deployment state pills and the deploy history table (website detail, project tab 13).
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Clock,
  History,
  Lock,
  Rocket,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { StatusPill } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

const STATE: Record<string, [LucideIcon, "neutral" | "info" | "success" | "warning" | "danger" | "muted", string]> = {
  queued: [CircleDashed, "info", "Queued"],
  building: [CircleDot, "info", "Building"],
  ready: [CircleCheck, "neutral", "Ready"],
  published: [Rocket, "success", "Live"],
  failed: [CircleX, "danger", "Failed"],
  canceled: [Ban, "muted", "Canceled"],
  superseded: [History, "muted", "Replaced"],
  unknown: [CircleDashed, "warning", "Unknown"],
};

export function DeploymentState({ state }: { state: string }) {
  const [icon, tone, label] = STATE[state] ?? STATE.unknown!;
  return <StatusPill icon={icon} label={label} tone={tone} />;
}

/** How to stop the provider auto-deploying to production (spec §1.1, decision 0010). */
export const LOCK_HOW: Record<string, string> = {
  cloudflare:
    "Cloudflare Pages: Settings → Builds & deployments → Configure Production deployments, untick “Enable automatic production branch deployments”, and save.",
  netlify: "Netlify: Deploys → “Lock to stop auto publishing” on the published deploy.",
  vercel: "Vercel: Settings → Environments → Production → turn off “Auto-assign Custom Production Domains” (deploys are then staged until promoted).",
};

export function AutoPublishPill({ value }: { value: string }) {
  if (value === "locked") return <StatusPill icon={Lock} label="Auto-publish locked" tone="success" />;
  if (value === "disabled") return <StatusPill icon={Lock} label="Auto-deploy off" tone="success" />;
  if (value === "enabled") return <StatusPill icon={TriangleAlert} label="Auto-publish on" tone="warning" />;
  return <StatusPill icon={TriangleAlert} label="Auto-publish unknown" tone="warning" />;
}

/** The §1.1 caveat, shown wherever auto-publishing isn't confirmed off. */
export function AutoPublishCaveat({ provider, value }: { provider: string; value: string }) {
  if (value === "locked" || value === "disabled") return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <strong>SiteSync can&apos;t stop this host from auto-deploying to production on push or merge.</strong> With
        auto-publishing {value === "enabled" ? "on" : "possibly on"}, code merged to the production branch can go live
        without SiteSync&apos;s approval. {LOCK_HOW[provider] ?? ""}
      </p>
    </div>
  );
}

const DISPATCH: Record<string, [LucideIcon, "neutral" | "info" | "success" | "warning" | "danger" | "muted", string]> = {
  pending: [Clock, "info", "Sending"],
  dispatched: [Clock, "info", "Sent, waiting for the host"],
  confirming: [Clock, "info", "Waiting for the host"],
  confirmed_success: [Rocket, "success", "Confirmed live"],
  confirmed_failure: [CircleX, "danger", "Failed"],
  dispatch_failed: [CircleX, "danger", "Not sent"],
  timed_out: [TriangleAlert, "warning", "Not confirmed (timed out)"],
};

/** A SiteSync release's dispatch state (§5.3). */
export function DispatchState({ state }: { state: string }) {
  const [icon, tone, label] = DISPATCH[state] ?? [CircleDashed, "warning" as const, state];
  return <StatusPill icon={icon} label={label} tone={tone} />;
}

const PROVIDER_NAMES: Record<string, string> = { cloudflare: "Cloudflare Pages", netlify: "Netlify", vercel: "Vercel", other: "Other" };
export const providerName = (provider: string) => PROVIDER_NAMES[provider] ?? provider;

export type DeploymentRow = {
  id: string;
  provider: string;
  providerDeploymentId: string | null;
  environment: string;
  origin: string;
  state: string;
  providerState: string | null;
  commitSha: string | null;
  branch: string | null;
  deployUrl: string | null;
  providerCreatedAt: Date | null;
  lastConfirmedAt: Date | null;
  errorSummary: string | null;
  projectId: string | null;
};

/** Provider URLs are displayed, never fetched; they open in a new tab. */
export function ExternalUrl({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-primary hover:underline">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function DeploymentsTable({ rows, highlightProjectId }: { rows: DeploymentRow[]; highlightProjectId?: string }) {
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader className="bg-card lg:sticky lg:top-14 lg:z-[1]">
          <TableRow>
            <TableHead>Environment</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Commit</TableHead>
            <TableHead>URL</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Last confirmed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => (
            <TableRow key={d.id}>
              <TableCell className="capitalize">
                {d.environment}
                {highlightProjectId && d.projectId === highlightProjectId ? (
                  <span className="block text-xs text-muted-foreground normal-case">This project</span>
                ) : null}
              </TableCell>
              <TableCell>
                <span className="grid gap-0.5">
                  <DeploymentState state={d.state} />
                  {d.errorSummary ? <span className="max-w-56 text-xs whitespace-normal text-destructive">{d.errorSummary}</span> : null}
                </span>
              </TableCell>
              <TableCell>
                {providerName(d.provider)}
                {d.providerState ? <span className="block text-xs text-muted-foreground">{d.providerState}</span> : null}
              </TableCell>
              <TableCell>
                {d.commitSha ? <code className="font-mono text-xs">{d.commitSha.slice(0, 7)}</code> : "—"}
                {d.branch ? <span className="block text-xs text-muted-foreground">{d.branch}</span> : null}
              </TableCell>
              <TableCell className="max-w-64 whitespace-normal">
                {d.deployUrl ? <ExternalUrl href={d.deployUrl}>{d.deployUrl.replace(/^https:\/\//, "")}</ExternalUrl> : "—"}
              </TableCell>
              <TableCell>{formatDateTime(d.providerCreatedAt)}</TableCell>
              <TableCell>{formatDateTime(d.lastConfirmedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
