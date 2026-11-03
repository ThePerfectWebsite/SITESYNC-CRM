// Confirmation of SiteSync releases (spec §5.3, §8.5; decision 0011). The
// provider decides: after each sync, every in-flight release on the link is
// evaluated against what the provider now reports. Success makes the deploy
// published (provider-confirmed) and runs go_live; a late answer after the
// 20-minute timeout is still applied and audited.
import { and, eq, inArray, sql } from "drizzle-orm";
import { writeAudit } from "../audit";
import type { Db, Tx } from "../db/client";
import { deployments, hostingLinks, productionApprovals, websites } from "../db/schema";
import { lockHostingLinkWork, syncHostingLink } from "../integrations/hosting-sync";
import type { AdapterFactory } from "../integrations/service";
import type { HostingAdapter } from "../providers/hosting";
import { DomainError } from "../records/errors";
import { goLiveWithinTransaction } from "../stages/service";

export const CONFIRM_TIMEOUT_MS = 20 * 60 * 1000;
/** A dispatch the executor created but never recorded an answer for (process stopped). */
export const PENDING_STUCK_MS = 2 * 60 * 1000;

const IN_FLIGHT = ["pending", "dispatched", "confirming", "timed_out"] as const;

/** Polling backoff (§5.3): 5 s, 10 s, 20 s, 40 s, then every 60 s. */
export function confirmBackoffSeconds(attempt: number): number {
  return Math.min(60, 5 * 2 ** Math.max(0, attempt - 1));
}

type DeploymentRow = typeof deployments.$inferSelect;
type Outcome = { kind: "success" } | { kind: "failure"; reason: string } | { kind: "waiting" };

/**
 * Pure: what the provider's state (as synced) says about a release.
 * `currentId` is the link's provider-reported live deploy.
 */
export function judgeRelease(
  row: Pick<DeploymentRow, "id" | "kind" | "providerDeploymentId" | "targetDeploymentId" | "previousLiveDeploymentId" | "state" | "commitSha">,
  approvedCommitSha: string,
  currentId: string | null,
  target: Pick<DeploymentRow, "state"> | null,
): Outcome {
  if (row.kind === "deploy") {
    // A build: its own row tracks the provider's new deploy.
    if (!row.providerDeploymentId) return { kind: "waiting" };
    if (row.state === "failed" || row.state === "canceled") return { kind: "failure", reason: `The provider build ${row.state}.` };
    if (row.state === "published" || currentId === row.id) {
      if (!row.commitSha) return { kind: "failure", reason: "The provider didn't report which commit it built, so SiteSync can't confirm the approved one went live." };
      if (row.commitSha !== approvedCommitSha) {
        return {
          kind: "failure",
          reason: `The provider built ${row.commitSha.slice(0, 7)}, not the approved ${approvedCommitSha.slice(0, 7)} (the branch moved during the release). Roll back or approve this commit.`,
        };
      }
      return { kind: "success" };
    }
    return { kind: "waiting" };
  }
  // Promote / rollback: the target (or a new deploy the provider made for it) becomes live.
  if (currentId && (currentId === row.targetDeploymentId || currentId === row.id)) return { kind: "success" };
  if (target && (target.state === "failed" || target.state === "canceled")) return { kind: "failure", reason: `The target deploy is ${target.state}.` };
  if (currentId && currentId !== row.previousLiveDeploymentId) {
    return { kind: "failure", reason: "A different deploy went live instead." };
  }
  return { kind: "waiting" };
}

/** Evaluates one release against the synced provider state. Returns its dispatch state afterwards. */
export async function evaluateRelease(db: Db, deploymentId: string, now: Date = new Date()): Promise<DeploymentRow["dispatchState"]> {
  return db.transaction(async (tx) => {
    const [first] = await tx.select({ hostingLinkId: deployments.hostingLinkId }).from(deployments).where(eq(deployments.id, deploymentId));
    if (!first) return null;
    await lockHostingLinkWork(tx, first.hostingLinkId);
    const [row] = await tx.select().from(deployments).where(eq(deployments.id, deploymentId)).for("update");
    if (!row || !row.dispatchState || !(IN_FLIGHT as readonly string[]).includes(row.dispatchState) || !row.approvalId) {
      return row?.dispatchState ?? null;
    }
    const age = now.getTime() - row.createdAt.getTime();
    if (row.dispatchState === "pending") {
      if (age <= PENDING_STUCK_MS) return row.dispatchState;
      // The executor created it but never recorded the provider's answer.
      await markTimedOut(tx, row, "SiteSync stopped before it recorded the provider's answer. Check the provider, then re-check here.");
      return "timed_out";
    }
    const [approval] = await tx.select().from(productionApprovals).where(eq(productionApprovals.id, row.approvalId));
    const [link] = await tx.select().from(hostingLinks).where(eq(hostingLinks.id, row.hostingLinkId));
    const target = row.targetDeploymentId
      ? ((await tx.select().from(deployments).where(eq(deployments.id, row.targetDeploymentId)))[0] ?? null)
      : null;
    const outcome = judgeRelease(row, approval!.targetCommitSha, link?.currentDeploymentId ?? null, target);
    const late = row.dispatchState === "timed_out";

    if (outcome.kind === "waiting") {
      if (row.dispatchState === "timed_out") return row.dispatchState;
      if (age > CONFIRM_TIMEOUT_MS) {
        await markTimedOut(tx, row, "The provider hadn't confirmed the release after 20 minutes.");
        return "timed_out";
      }
      if (row.dispatchState === "dispatched") {
        await tx.update(deployments).set({ dispatchState: "confirming", lastConfirmedAt: now }).where(eq(deployments.id, row.id));
        return "confirming";
      }
      await tx.update(deployments).set({ lastConfirmedAt: now }).where(eq(deployments.id, row.id));
      return row.dispatchState;
    }

    if (outcome.kind === "failure") {
      await tx
        .update(deployments)
        .set({
          dispatchState: "confirmed_failure",
          ...(row.kind === "deploy" ? {} : { state: "failed" as const }),
          errorSummary: outcome.reason.slice(0, 2000),
          lastConfirmedAt: now,
        })
        .where(eq(deployments.id, row.id));
      await writeAudit(tx, {
        actor: { type: "system" },
        action: "deployment.confirmed_failure",
        subjectType: "deployment",
        subjectId: row.id,
        websiteId: row.websiteId,
        projectId: row.projectId,
        summary: `Release ${late ? "(late answer) " : ""}failed: ${outcome.reason}`,
        metadata: { approvalId: row.approvalId, late },
      });
      return "confirmed_failure";
    }

    // Success: the provider reports the release live.
    await tx
      .update(deployments)
      .set({
        dispatchState: "confirmed_success",
        state: "published",
        confirmationSource: "provider",
        publishedAt: sql`coalesce(${deployments.publishedAt}, ${now})`,
        lastConfirmedAt: now,
        errorSummary: null,
      })
      .where(eq(deployments.id, row.id));
    await tx.update(websites).set({ status: "live" }).where(and(eq(websites.id, row.websiteId), sql`${websites.status} <> 'live'`));
    await writeAudit(tx, {
      actor: { type: "system" },
      action: "deployment.confirmed_success",
      subjectType: "deployment",
      subjectId: row.id,
      websiteId: row.websiteId,
      projectId: row.projectId,
      summary: `Release confirmed live by the provider${late ? " (after the timeout)" : ""}: ${approval!.targetCommitSha.slice(0, 7)}`,
      metadata: { approvalId: row.approvalId, action: approval!.action, late },
    });
    if (row.projectId && row.kind !== "rollback") await goLive(tx, row.projectId, row.id, row.approvalId);
    return "confirmed_success";
  });
}

async function markTimedOut(tx: Tx, row: DeploymentRow, reason: string) {
  await tx.update(deployments).set({ dispatchState: "timed_out", errorSummary: reason }).where(eq(deployments.id, row.id));
  await writeAudit(tx, {
    actor: { type: "system" },
    action: "deployment.timed_out",
    subjectType: "deployment",
    subjectId: row.id,
    websiteId: row.websiteId,
    projectId: row.projectId,
    summary: `Release not confirmed: ${reason}`,
    metadata: { approvalId: row.approvalId },
  });
}

/** go_live in a savepoint: if the project has moved on, the release still stands. */
async function goLive(tx: Tx, projectId: string, deploymentId: string, approvalId: string) {
  try {
    await tx.transaction((sp) => goLiveWithinTransaction(sp, { projectId, deploymentId, metadata: { approvalId } }));
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    await writeAudit(tx, {
      actor: { type: "system" },
      action: "project.go_live_skipped",
      subjectType: "project",
      subjectId: projectId,
      projectId,
      summary: `Release confirmed, but the project didn't move to Live: ${error.message}`,
      metadata: { deploymentId, approvalId },
    });
  }
}

/** Every in-flight release on a link, evaluated after a sync (late confirmations included). */
export async function evaluateReleasesForLink(db: Db, linkId: string, now: Date = new Date()) {
  const rows = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.hostingLinkId, linkId),
        eq(deployments.origin, "sitesync_initiated"),
        inArray(deployments.dispatchState, [...IN_FLIGHT]),
      ),
    );
  for (const { id } of rows) await evaluateRelease(db, id, now);
  return rows.length;
}

/** One confirmation step (the job, or "Re-check now"): re-read the provider, then evaluate. */
export async function checkRelease(
  db: Db,
  deploymentId: string,
  options: { factory?: AdapterFactory<HostingAdapter>; now?: Date } = {},
): Promise<DeploymentRow["dispatchState"]> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!row) return null;
  if (row.dispatchState && (IN_FLIGHT as readonly string[]).includes(row.dispatchState) && row.dispatchState !== "pending") {
    await syncHostingLink(db, row.hostingLinkId, { factory: options.factory, now: options.now });
  }
  return evaluateRelease(db, deploymentId, options.now ?? new Date());
}

/** True while the confirmation job should keep polling. */
export function stillConfirming(state: DeploymentRow["dispatchState"]): boolean {
  return state === "dispatched" || state === "confirming" || state === "pending";
}
