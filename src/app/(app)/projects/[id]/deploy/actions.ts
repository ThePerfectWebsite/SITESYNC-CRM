"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { eq } from "drizzle-orm";
import { preflightHref } from "@/lib/release";
import { db } from "@/server/db";
import { approveRelease, confirmAndExecute, getApproval, revokeApproval } from "@/server/deploy/approvals";
import { checkRelease, evaluateReleasesForLink } from "@/server/deploy/confirm";
import { buildPreflight } from "@/server/deploy/preflight";
import { formValues, requireActor, runForm } from "@/server/http/action";
import { requestMeta } from "@/server/http/request";
import { syncRepositoryLink } from "@/server/integrations/github-sync";
import { syncHostingLink } from "@/server/integrations/hosting-sync";
import { enqueueDeployConfirm } from "@/server/jobs/runtime";
import { APPROVAL_ACTIONS, deployments, type ApprovalAction } from "@/server/db/schema";

// Release actions (spec §8.2–§8.5). Every decision is made by the services,
// server-side; these only check the session, parse ids and route.

const parseAction = (value: string): ApprovalAction | null =>
  (APPROVAL_ACTIONS as readonly string[]).includes(value) ? (value as ApprovalAction) : null;

/** "Refresh from provider": re-syncs the host and repository now, then shows the preflight again. */
export async function refreshPreflightAction(projectId: string, action: string, target: string): Promise<FormState> {
  await requireActor(projectId, ...(target ? [target] : []));
  const kind = parseAction(action);
  if (!kind) return { key: randomUUID(), message: "Unknown release action." };
  const database = db();
  const preflight = await buildPreflight(database, projectId, { action: kind, targetDeploymentId: target || null });
  if (!preflight) return { key: randomUUID(), message: "Project not found." };
  const [host, repo] = await Promise.all([
    preflight.link?.integrationId ? syncHostingLink(database, preflight.link.id) : null,
    preflight.repository ? syncRepositoryLink(database, preflight.repository.id, { mode: "manual" }) : null,
  ]);
  if (preflight.link && host?.status === "ok") await evaluateReleasesForLink(database, preflight.link.id);
  const failed = [host, repo].find((r) => r?.status === "failed");
  if (failed) return { key: randomUUID(), message: "Couldn't refresh from the provider. See the integration's health on the Integrations page." };
  redirect(`${preflightHref(projectId, kind, target)}&refreshed=1`);
}

export async function approveReleaseAction(projectId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(projectId);
  const values = formValues(formData, ["action", "targetDeploymentId", "preflightHash", "reason"]);
  const result = await runForm(values, () => approveRelease(db(), actor, projectId, values));
  if (!result.ok) return result.state;
  redirect(`/approvals/${result.value}/confirm`);
}

/** Final confirmation (screen 16): password, then the executor. */
export async function confirmReleaseAction(approvalId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(approvalId);
  const password = formData.get("password");
  const database = db();
  const row = await getApproval(database, approvalId);
  if (!row) return { key: randomUUID(), message: "Approval not found." };
  const meta = await requestMeta();
  const result = await confirmAndExecute(
    database,
    actor,
    approvalId,
    typeof password === "string" ? password : "",
    { ip: meta.ip, userAgent: meta.userAgent },
    { enqueueConfirm: enqueueDeployConfirm },
  );
  switch (result.status) {
    case "wrong_password":
      return { key: randomUUID(), fieldErrors: { password: "That password isn't right. The approval is unchanged." } };
    case "throttled":
      return { key: randomUUID(), message: `Too many wrong passwords. Try again in ${result.retryAfterSeconds} s.` };
    case "refused":
      return { key: randomUUID(), message: `Refused: ${result.reason}` };
    case "dispatch_failed":
    case "dispatched":
      redirect(`/projects/${row.approval.projectId}?release=${result.status}`);
  }
}

export async function revokeApprovalAction(approvalId: string): Promise<FormState> {
  const actor = await requireActor(approvalId);
  const database = db();
  const row = await getApproval(database, approvalId);
  if (!row) return { key: randomUUID(), message: "Approval not found." };
  const result = await runForm({}, () => revokeApproval(database, actor, approvalId));
  if (!result.ok) return result.state;
  redirect(`/projects/${row.approval.projectId}`);
}

/** "Re-check now" for a release that's in flight or timed out. */
export async function recheckReleaseAction(projectId: string, deploymentId: string): Promise<FormState> {
  await requireActor(projectId, deploymentId);
  const database = db();
  const [release] = await database
    .select({ projectId: deployments.projectId, origin: deployments.origin })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  if (!release || release.projectId !== projectId || release.origin !== "sitesync_initiated") {
    return { key: randomUUID(), message: "That release isn't part of this project." };
  }
  await checkRelease(database, deploymentId);
  redirect(`/projects/${projectId}?release=rechecked`);
}
