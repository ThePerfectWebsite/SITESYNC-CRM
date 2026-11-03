// Deployment state pills and the deploy history table (website detail, project tab 13).
import { Ban, CircleCheck, CircleDashed, CircleDot, CircleX, History, Rocket, type LucideIcon } from "lucide-react";
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
