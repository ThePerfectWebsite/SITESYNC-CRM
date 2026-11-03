// Stage service (spec §5.1). Every transition runs in one transaction: lock the
// project row, check the caller's expected current stage, update
// project_stages, insert audit_events, insert stage_history. Any failure rolls
// back all of it.
import { and, asc, desc, eq } from "drizzle-orm";
import { writeAudit } from "../audit";
import type { Db, DbOrTx, Tx } from "../db/client";
import { deployments, projectStages, projects, stageHistory, users } from "../db/schema";
import type { Actor } from "../records/actor";
import { DomainError, isUniqueViolation, notFound } from "../records/errors";
import { databaseDeploymentFacts, type DeploymentFacts } from "./deployment-facts";
import {
  checkGoLiveDeployment,
  currentStage,
  planGoLive,
  planUserTransition,
  type ProjectStageState,
  type StageView,
  type TransitionPlan,
  type UserTransitionRequest,
} from "./machine";

export type StageServiceOptions = {
  facts?: DeploymentFacts;
  /** Test hook: runs inside the transaction right after the history insert. */
  afterHistoryInsert?: (tx: Tx) => Promise<void>;
};

type ProjectRow = typeof projects.$inferSelect;

export async function loadStages(db: DbOrTx, projectId: string): Promise<StageView[]> {
  return db
    .select({
      id: projectStages.id,
      key: projectStages.key,
      name: projectStages.name,
      position: projectStages.position,
      kind: projectStages.kind,
      role: projectStages.role,
      status: projectStages.status,
      enteredAt: projectStages.enteredAt,
    })
    .from(projectStages)
    .where(eq(projectStages.projectId, projectId))
    .orderBy(asc(projectStages.position));
}

/** The stage an archived project returns to: where it was when last archived. */
async function restoreTarget(db: DbOrTx, projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ from: stageHistory.fromProjectStageId })
    .from(stageHistory)
    .where(and(eq(stageHistory.projectId, projectId), eq(stageHistory.transition, "archive")))
    .orderBy(desc(stageHistory.createdAt))
    .limit(1);
  return row?.from ?? null;
}

export async function loadStageState(db: DbOrTx, project: ProjectRow): Promise<ProjectStageState> {
  const stages = await loadStages(db, project.id);
  const archived = stages.some((s) => s.kind === "archived" && s.status === "current");
  return {
    stages,
    heldFromId: project.heldFromProjectStageId,
    restoreToId: archived ? await restoreTarget(db, project.id) : null,
  };
}

async function lockProject(tx: Tx, projectId: string): Promise<ProjectRow> {
  const [row] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
  if (!row) throw notFound("Project");
  return row;
}

/** Writes a plan's status changes. The old current stage is released before the new one is set (unique index). */
async function applyPlan(tx: Tx, project: ProjectRow, plan: TransitionPlan, actorUserId: string | null, now: Date) {
  const ordered = [...plan.updates].sort((a, b) =>
    a.status === "current" ? 1 : b.status === "current" ? -1 : 0,
  );
  for (const update of ordered) {
    await tx
      .update(projectStages)
      .set({
        status: update.status,
        ...(update.id === plan.fromId ? { exitedAt: now } : {}),
        ...(update.id === plan.toId ? { enteredAt: now } : {}),
      })
      .where(and(eq(projectStages.id, update.id), eq(projectStages.projectId, project.id)));
  }

  const projectChanges: Partial<ProjectRow> = {};
  if (plan.heldFromId !== undefined) projectChanges.heldFromProjectStageId = plan.heldFromId;
  if (plan.archive === "set") Object.assign(projectChanges, { archivedAt: now, archivedBy: actorUserId });
  if (plan.archive === "clear") Object.assign(projectChanges, { archivedAt: null, archivedBy: null });
  if (Object.keys(projectChanges).length) {
    await tx.update(projects).set(projectChanges).where(eq(projects.id, project.id));
  }
}

function describeMove(stages: StageView[], plan: TransitionPlan) {
  const name = (id: string | null) => stages.find((s) => s.id === id)?.name ?? "—";
  const key = (id: string | null) => stages.find((s) => s.id === id)?.key ?? null;
  return {
    fromName: name(plan.fromId),
    toName: name(plan.toId),
    metadata: {
      transition: plan.transition,
      from: key(plan.fromId),
      to: key(plan.toId),
      reason: plan.reason,
    },
  };
}

export type TransitionInput = {
  projectId: string;
  /** The current stage the operator saw (optimistic concurrency). */
  expectedCurrentStageId: string;
  request: UserTransitionRequest;
};

/** An operator-initiated transition. Live is never reachable from here. */
export async function transitionStage(
  db: Db,
  actor: Actor,
  input: TransitionInput,
  options: StageServiceOptions = {},
): Promise<TransitionPlan> {
  const facts = options.facts ?? databaseDeploymentFacts;
  try {
    return await db.transaction(async (tx) => {
      const project = await lockProject(tx, input.projectId);
      const state = await loadStageState(tx, project);
      const current = currentStage(state.stages);
      if (current.id !== input.expectedCurrentStageId) {
        throw new DomainError(
          "stale",
          `This project moved to ${current.name} in the meantime. Check the stage and try again.`,
        );
      }

      const result = planUserTransition(state, input.request, {
        hasIntegrationBackedProductionLink: await facts.hasIntegrationBackedProductionLink(tx, project.websiteId),
        hasInFlightDeploymentWork: await facts.hasInFlightDeploymentWork(tx, project.id),
      });
      if (!result.ok) {
        throw new DomainError("invalid", result.error, result.field ? { [result.field]: result.error } : {});
      }
      const { plan } = result;
      // Defence in depth: nothing a user does may land on Live.
      if (state.stages.find((s) => s.id === plan.toId)?.role === "live") {
        throw new Error("user transition targeted the live stage");
      }

      const now = new Date();
      await applyPlan(tx, project, plan, actor.userId, now);
      const move = describeMove(state.stages, plan);
      const auditEventId = await writeAudit(tx, {
        actor: { type: "user", userId: actor.userId },
        action: "project.stage_changed",
        subjectType: "project",
        subjectId: project.id,
        clientId: project.clientId,
        websiteId: project.websiteId,
        projectId: project.id,
        summary: `${project.name}: ${move.fromName} → ${move.toName}`,
        metadata: move.metadata,
        requestId: actor.requestId,
      });
      await tx.insert(stageHistory).values({
        projectId: project.id,
        fromProjectStageId: plan.fromId,
        toProjectStageId: plan.toId,
        transition: plan.transition,
        actorType: "user",
        actorUserId: actor.userId,
        reason: plan.reason,
        auditEventId,
      });
      await options.afterHistoryInsert?.(tx);
      return plan;
    });
  } catch (error) {
    if (isUniqueViolation(error, "projects_code_live_key")) {
      throw new DomainError("conflict", "Another project now uses this project's code. Change one of them first.");
    }
    throw error;
  }
}

export type GoLiveResult = { moved: boolean };

/**
 * System path to Live (decision 0004). Only called by deployment confirmation
 * (Phases 3b/4), never from a Server Action. Requires a provider-confirmed,
 * published production deployment on an integration-backed hosting link.
 */
export async function systemGoLive(
  db: Db,
  input: { projectId: string; deploymentId: string; requestId?: string | null },
  options: StageServiceOptions = {},
): Promise<GoLiveResult> {
  return db.transaction(async (tx) => goLiveInTransaction(tx, await lockProject(tx, input.projectId), input, options));
}

/**
 * go_live inside the caller's transaction (Phase 4 confirmation, spec §8.5).
 * Locks the project; the same checks as systemGoLive apply.
 */
export async function goLiveWithinTransaction(
  tx: Tx,
  input: { projectId: string; deploymentId: string; metadata?: Record<string, unknown> },
  options: StageServiceOptions = {},
): Promise<GoLiveResult> {
  return goLiveInTransaction(tx, await lockProject(tx, input.projectId), input, options);
}

/** go_live inside an open transaction, with the project row already locked. */
async function goLiveInTransaction(
  tx: Tx,
  project: ProjectRow,
  input: { deploymentId: string; requestId?: string | null; metadata?: Record<string, unknown> },
  options: StageServiceOptions,
): Promise<GoLiveResult> {
  const facts = options.facts ?? databaseDeploymentFacts;
  {
    const refusal = checkGoLiveDeployment(project.id, await facts.findDeployment(tx, input.deploymentId));
    if (refusal) throw new DomainError("invalid", `Can't move to Live: ${refusal}.`);

    const state = await loadStageState(tx, project);
    const result = planGoLive(state);
    if (!result.ok) throw new DomainError("invalid", `Can't move to Live: ${result.error}.`);
    if (!result.plan) {
      // Already Live (or later): a re-deploy confirms but doesn't move the stage.
      await writeAudit(tx, {
        actor: { type: "system" },
        action: "project.deploy_confirmed",
        subjectType: "project",
        subjectId: project.id,
        clientId: project.clientId,
        websiteId: project.websiteId,
        projectId: project.id,
        summary: `${project.name}: production deploy confirmed`,
        metadata: { deploymentId: input.deploymentId, ...input.metadata },
        requestId: input.requestId,
      });
      return { moved: false };
    }

    const plan = result.plan;
    await applyPlan(tx, project, plan, null, new Date());
    const move = describeMove(state.stages, plan);
    const auditEventId = await writeAudit(tx, {
      actor: { type: "system" },
      action: "project.stage_changed",
      subjectType: "project",
      subjectId: project.id,
      clientId: project.clientId,
      websiteId: project.websiteId,
      projectId: project.id,
      summary: `${project.name}: ${move.fromName} → ${move.toName} (production deploy confirmed)`,
      metadata: { ...move.metadata, deploymentId: input.deploymentId, ...input.metadata },
      requestId: input.requestId,
    });
    await tx.insert(stageHistory).values({
      projectId: project.id,
      fromProjectStageId: plan.fromId,
      toProjectStageId: plan.toId,
      transition: "go_live",
      actorType: "system",
      deploymentId: input.deploymentId,
      auditEventId,
    });
    await options.afterHistoryInsert?.(tx);
    return { moved: true };
  }
}

/**
 * OQ-2: the provider published a production deploy on its own (auto-publish)
 * while the project waits at Ready to Deploy. The operator confirms "mark Live";
 * the deploy is attributed to the project and go_live runs with it, in one
 * transaction. Live still rests on the provider's confirmation, not the click.
 */
export async function confirmLiveFromProviderDeploy(
  db: Db,
  actor: Actor,
  input: { projectId: string; deploymentId: string },
  options: StageServiceOptions = {},
): Promise<GoLiveResult> {
  return db.transaction(async (tx) => {
    const project = await lockProject(tx, input.projectId);
    const [deployment] = await tx
      .select()
      .from(deployments)
      .where(eq(deployments.id, input.deploymentId))
      .for("update");
    if (!deployment) throw notFound("Deployment");
    if (deployment.websiteId !== project.websiteId) {
      throw new DomainError("invalid", "That deployment belongs to another website.");
    }
    if (deployment.projectId && deployment.projectId !== project.id) {
      throw new DomainError("conflict", "That deployment is already attributed to another project.");
    }
    if (!deployment.projectId) {
      await tx.update(deployments).set({ projectId: project.id }).where(eq(deployments.id, deployment.id));
      await writeAudit(tx, {
        actor: { type: "user", userId: actor.userId },
        action: "deployment.attributed",
        subjectType: "deployment",
        subjectId: deployment.id,
        clientId: project.clientId,
        websiteId: project.websiteId,
        projectId: project.id,
        summary: `Production deploy ${deployment.providerDeploymentId ?? deployment.id} attributed to ${project.name}`,
        metadata: { reason: "operator confirmed a provider-published deploy (OQ-2)" },
        requestId: actor.requestId,
      });
    }
    return goLiveInTransaction(
      tx,
      project,
      { deploymentId: deployment.id, requestId: actor.requestId, metadata: { confirmedBy: actor.userId, via: "oq2_prompt" } },
      options,
    );
  });
}

export async function stageHistoryForProject(db: DbOrTx, projectId: string) {
  return db
    .select({
      id: stageHistory.id,
      createdAt: stageHistory.createdAt,
      transition: stageHistory.transition,
      fromProjectStageId: stageHistory.fromProjectStageId,
      toProjectStageId: stageHistory.toProjectStageId,
      actorType: stageHistory.actorType,
      actorName: users.displayName,
      reason: stageHistory.reason,
      deploymentId: stageHistory.deploymentId,
    })
    .from(stageHistory)
    .leftJoin(users, eq(users.id, stageHistory.actorUserId))
    .where(eq(stageHistory.projectId, projectId))
    .orderBy(desc(stageHistory.createdAt));
}
