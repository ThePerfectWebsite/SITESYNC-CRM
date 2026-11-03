import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { providerName } from "@/components/deployments";
import { ActionButton } from "@/components/forms/action-button";
import { Details, PageHeader } from "@/components/page";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { effectiveStatus, getApproval } from "@/server/deploy/approvals";
import { ACTION_LABELS } from "@/server/deploy/preflight";
import { confirmReleaseAction, revokeApprovalAction } from "../../../projects/[id]/deploy/actions";
import { ConfirmForm, Countdown } from "./confirm-form";

export const metadata: Metadata = { title: "Confirm release" };

const STATUS_TEXT: Record<string, string> = {
  consumed: "This approval was confirmed and used.",
  expired: "This approval expired before it was confirmed. Start a new one from the project.",
  revoked: "This approval was revoked.",
  refused: "This approval was refused at confirmation.",
};

export default async function ConfirmApprovalPage({ params }: PageProps<"/approvals/[id]/confirm">) {
  await requireSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const row = await getApproval(db(), id);
  if (!row) notFound();
  const { approval } = row;
  const status = effectiveStatus(approval);
  const snapshot = approval.preflightSnapshot as {
    host?: { domain?: string | null; providerProjectId?: string | null } | null;
    current?: { providerDeploymentId?: string | null; commitSha?: string | null } | null;
    website?: { name?: string };
  };

  return (
    <div className="grid max-w-3xl gap-6">
      <PageHeader
        crumbs={[
          { label: "Projects", href: "/projects" },
          { label: row.projectName, href: `/projects/${approval.projectId}` },
          { label: "Confirm release" },
        ]}
        title="Confirm release"
      />
      <Card>
        <CardContent className="grid gap-3 text-sm">
          <Details
            items={[
              ["Action", ACTION_LABELS[approval.action]],
              ["Project", <Link key="p" href={`/projects/${approval.projectId}`} className="text-primary hover:underline">{row.projectName}</Link>],
              ["Website", snapshot.website?.name ?? "—"],
              ["Host", `${providerName(approval.provider)} · ${approval.providerProjectId}`],
              ["Production domain", snapshot.host?.domain ?? "—"],
              ["Live now", snapshot.current?.providerDeploymentId ? `${snapshot.current.providerDeploymentId}${snapshot.current.commitSha ? ` (${snapshot.current.commitSha.slice(0, 7)})` : ""}` : "nothing"],
              [
                approval.action === "build_from_ref" ? "Builds" : "Makes live",
                approval.action === "build_from_ref"
                  ? `${approval.productionBranch} at ${approval.targetCommitSha.slice(0, 7)}`
                  : `${approval.targetProviderDeploymentId} (${approval.targetCommitSha.slice(0, 7)})`,
              ],
              ["Commit", <code key="c" className="font-mono text-xs">{approval.targetCommitSha}</code>],
              ["Reason", approval.reason],
              ["Approved", `${formatDateTime(approval.approvedAt)} by ${row.approvedByName ?? "operator"}`],
              ["Time left", status === "awaiting_confirmation" ? <Countdown key="t" expiresAt={approval.expiresAt.toISOString()} /> : "—"],
            ]}
          />
        </CardContent>
      </Card>

      {status === "awaiting_confirmation" ? (
        <Card>
          <CardContent className="grid gap-4">
            <p className="text-sm">
              Confirming sends this release to {providerName(approval.provider)} now. SiteSync re-checks the host, the commit and
              readiness first, and refuses if anything changed since you approved.
            </p>
            <ConfirmForm action={confirmReleaseAction.bind(null, id)} />
            <div className="border-t pt-4">
              <ActionButton action={revokeApprovalAction.bind(null, id)} label="Revoke approval" pendingLabel="Revoking…" />
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="grid gap-2 text-sm">
            <p role="status">{STATUS_TEXT[status] ?? status}</p>
            {approval.refusalReason ? <p className="text-muted-foreground">Reason: {approval.refusalReason}</p> : null}
            <p>
              <Link href={`/projects/${approval.projectId}`} className="text-primary hover:underline">
                Back to the project
              </Link>
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
