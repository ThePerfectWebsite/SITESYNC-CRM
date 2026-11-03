// Release readiness (spec §6). Computed on read, never stored. Phase 2 has the
// manual blockers only: open critical tasks and unchecked required checklist
// items. Provider-derived blockers (checks, previews, hosting) join in
// Phases 3–4 (decision 0008). Waivers accept one blocker, with a reason and audit.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx, Tx } from "../db/client";
import { readinessWaivers, releaseChecklistItems, tasks, users, type BlockerType } from "../db/schema";
import { auditActor, type Actor } from "./actor";
import { DomainError, isUniqueViolation, notFound, parseInput } from "./errors";
import { reason } from "./fields";
import { OPEN_TASK_STATUSES, requireLiveProject } from "./tasks";

export type Blocker = {
  key: string;
  type: BlockerType;
  label: string;
  /** Some blockers (e.g. a missing production host) can never be waived. */
  waivable: boolean;
  snapshot: Record<string, unknown>;
};

export type WaiverView = {
  id: string;
  blockerKey: string;
  blockerType: BlockerType;
  blockerSnapshot: unknown;
  reason: string;
  commitSha: string | null;
  createdAt: Date;
  waivedByName: string | null;
};

export type Readiness = {
  ready: boolean;
  /** Blockers that still block. */
  blockers: Blocker[];
  /** Blockers accepted by an active waiver that applies to the proposed target. */
  waived: { blocker: Blocker; waiver: WaiverView }[];
  /** Active waivers that currently match nothing (blocker resolved, or another commit). */
  inactiveWaivers: WaiverView[];
};

export type ProposedTarget = { commitSha?: string | null };

/** Does a waiver apply? A commit-scoped waiver applies only to that exact proposed commit. */
export function waiverApplies(waiver: Pick<WaiverView, "commitSha">, proposed?: ProposedTarget): boolean {
  if (!waiver.commitSha) return true;
  return Boolean(proposed?.commitSha) && waiver.commitSha === proposed!.commitSha;
}

/** Pure: splits blockers into blocking and waived. Unwaivable blockers always block. */
export function evaluateReadiness(blockers: Blocker[], waivers: WaiverView[], proposed?: ProposedTarget): Readiness {
  const used = new Set<string>();
  const blocking: Blocker[] = [];
  const waived: Readiness["waived"] = [];
  for (const blocker of blockers) {
    const waiver = blocker.waivable
      ? waivers.find((w) => w.blockerKey === blocker.key && waiverApplies(w, proposed))
      : undefined;
    if (waiver) {
      waived.push({ blocker, waiver });
      used.add(waiver.id);
    } else {
      blocking.push(blocker);
    }
  }
  return {
    ready: blocking.length === 0,
    blockers: blocking,
    waived,
    inactiveWaivers: waivers.filter((w) => !used.has(w.id)),
  };
}

/** The manual blockers for a project, as they stand now. */
export async function manualBlockers(db: DbOrTx, projectId: string): Promise<Blocker[]> {
  const [criticalTasks, checklist] = await Promise.all([
    db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          eq(tasks.priority, "critical"),
          inArray(tasks.status, OPEN_TASK_STATUSES),
          isNull(tasks.archivedAt),
        ),
      ),
    db
      .select({ key: releaseChecklistItems.key, label: releaseChecklistItems.label })
      .from(releaseChecklistItems)
      .where(
        and(
          eq(releaseChecklistItems.projectId, projectId),
          eq(releaseChecklistItems.required, true),
          isNull(releaseChecklistItems.checkedAt),
          isNull(releaseChecklistItems.archivedAt),
        ),
      )
      .orderBy(releaseChecklistItems.position),
  ]);
  return [
    ...criticalTasks.map((task) => ({
      key: `task:${task.id}`,
      type: "critical_task" as const,
      label: `Critical task open: ${task.title}`,
      waivable: true,
      snapshot: { taskId: task.id, title: task.title, status: task.status },
    })),
    ...checklist.map((item) => ({
      key: `checklist:${item.key}`,
      type: "checklist_item" as const,
      label: `Checklist item not done: ${item.label}`,
      waivable: true,
      snapshot: { key: item.key, label: item.label },
    })),
  ];
}

export async function activeWaivers(db: DbOrTx, projectId: string): Promise<WaiverView[]> {
  return db
    .select({
      id: readinessWaivers.id,
      blockerKey: readinessWaivers.blockerKey,
      blockerType: readinessWaivers.blockerType,
      blockerSnapshot: readinessWaivers.blockerSnapshot,
      reason: readinessWaivers.reason,
      commitSha: readinessWaivers.commitSha,
      createdAt: readinessWaivers.createdAt,
      waivedByName: users.displayName,
    })
    .from(readinessWaivers)
    .leftJoin(users, eq(users.id, readinessWaivers.waivedBy))
    .where(and(eq(readinessWaivers.projectId, projectId), isNull(readinessWaivers.revokedAt)))
    .orderBy(desc(readinessWaivers.createdAt));
}

export async function computeReadiness(db: DbOrTx, projectId: string, proposed?: ProposedTarget): Promise<Readiness> {
  const [blockers, waivers] = await Promise.all([manualBlockers(db, projectId), activeWaivers(db, projectId)]);
  return evaluateReadiness(blockers, waivers, proposed);
}

export const waiverSchema = z.object({
  blockerKey: z.string().trim().min(1).max(200),
  reason,
  commitSha: z
    .string()
    .trim()
    .toLowerCase()
    .nullish()
    .transform((value) => (value ? value : null))
    .refine((value) => value === null || /^[0-9a-f]{40}$/.test(value), {
      message: "Enter the full 40-character commit SHA, or leave it blank.",
    }),
});

/** Waives one current blocker. Refused for blockers that don't exist or can't be waived. */
export async function waiveBlocker(
  db: Db,
  actor: Actor,
  projectId: string,
  input: { blockerKey?: unknown; reason?: unknown; commitSha?: unknown },
): Promise<string> {
  const data = parseInput(waiverSchema, input);
  try {
    return await db.transaction(async (tx: Tx) => {
      const project = await requireLiveProject(tx, projectId);
      const blocker = (await manualBlockers(tx, projectId)).find((b) => b.key === data.blockerKey);
      if (!blocker) throw new DomainError("conflict", "That blocker no longer applies. Reload the page.");
      if (!blocker.waivable) throw new DomainError("invalid", "This blocker can't be waived.");
      const auditEventId = await writeAudit(tx, {
        actor: auditActor(actor),
        action: "readiness.waived",
        subjectType: "project",
        subjectId: projectId,
        clientId: project.clientId,
        websiteId: project.websiteId,
        projectId,
        summary: `Readiness blocker waived on ${project.name}: ${blocker.label}`,
        metadata: { blockerKey: blocker.key, reason: data.reason, commitSha: data.commitSha },
        requestId: actor.requestId,
      });
      const [row] = await tx
        .insert(readinessWaivers)
        .values({
          projectId,
          blockerKey: blocker.key,
          blockerType: blocker.type,
          blockerSnapshot: { label: blocker.label, ...blocker.snapshot },
          reason: data.reason,
          waivedBy: actor.userId,
          commitSha: data.commitSha,
          auditEventId,
        })
        .returning({ id: readinessWaivers.id });
      return row!.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, "readiness_waivers_active_key")) {
      throw new DomainError("conflict", "This blocker is already waived. Revoke the existing waiver first.");
    }
    throw error;
  }
}

export async function revokeWaiver(db: Db, actor: Actor, waiverId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [waiver] = await tx.select().from(readinessWaivers).where(eq(readinessWaivers.id, waiverId)).for("update");
    if (!waiver) throw notFound("Waiver");
    const project = await requireLiveProject(tx, waiver.projectId);
    if (waiver.revokedAt) return;
    await tx
      .update(readinessWaivers)
      .set({ revokedAt: new Date(), revokedBy: actor.userId })
      .where(eq(readinessWaivers.id, waiverId));
    const label = (waiver.blockerSnapshot as { label?: unknown }).label;
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "readiness.waiver_revoked",
      subjectType: "project",
      subjectId: project.id,
      clientId: project.clientId,
      websiteId: project.websiteId,
      projectId: project.id,
      summary: `Readiness waiver revoked on ${project.name}: ${typeof label === "string" ? label : waiver.blockerKey}`,
      metadata: { waiverId, blockerKey: waiver.blockerKey },
      requestId: actor.requestId,
    });
  });
}
