// Project stage state machine (spec §5.1), as pure functions over a project's
// stages. The stage service applies the resulting plan inside one transaction.
import type { StageStatus, StageTransition, StepKind, StepRole } from "../db/schema";

export type StageView = {
  id: string;
  key: string;
  name: string;
  position: number;
  kind: StepKind;
  role: StepRole | null;
  status: StageStatus;
  /** When the stage was last entered (display only; not used by the rules). */
  enteredAt?: Date | null;
};

export type ProjectStageState = {
  stages: StageView[];
  /** Set while On Hold: the linear stage the project was held from. */
  heldFromId: string | null;
  /** While Archived: the stage the project was in when archived (from stage history). */
  restoreToId: string | null;
};

export type UserTransitionRequest =
  | { kind: "advance" }
  | { kind: "skip_forward"; targetId: string; reason: string }
  | { kind: "move_back"; targetId: string; reason: string }
  | { kind: "hold"; reason: string }
  | { kind: "resume"; targetId?: string | null; reason?: string | null }
  | { kind: "archive"; reason: string }
  | { kind: "restore"; reason: string };

export type UserTransitionKind = UserTransitionRequest["kind"];

/** Facts from outside the project that some transitions depend on. */
export type TransitionContext = {
  /** The website has a production hosting link backed by an integration (decision 0004). */
  hasIntegrationBackedProductionLink: boolean;
  /** An approval is awaiting confirmation or a SiteSync deploy is in flight. */
  hasInFlightDeploymentWork: boolean;
};

export type StageUpdate = { id: string; status: StageStatus };

export type TransitionPlan = {
  transition: StageTransition;
  fromId: string | null;
  toId: string;
  updates: StageUpdate[];
  reason: string | null;
  /** New value for projects.held_from_project_stage_id (undefined = unchanged). */
  heldFromId?: string | null;
  /** Archive sets projects.archived_at, restore clears it. */
  archive?: "set" | "clear";
};

export type PlanResult =
  | { ok: true; plan: TransitionPlan }
  | { ok: false; error: string; field?: "reason" | "targetId" };

export const LIVE_EXPLANATION = "Reached automatically after a confirmed production deploy.";
export const NO_HOSTING_EXPLANATION =
  "This website has no connected hosting provider, so SiteSync can't confirm a deploy. Connect Netlify or Vercel to let this project reach Live.";

const REASON_MIN = 3;
const REASON_MAX = 2000;

const fail = (error: string, field?: "reason" | "targetId"): PlanResult => ({
  ok: false,
  error,
  field,
});

export function linearStages(stages: StageView[]): StageView[] {
  return stages.filter((s) => s.kind === "linear").sort((a, b) => a.position - b.position);
}

export function currentStage(stages: StageView[]): StageView {
  const current = stages.filter((s) => s.status === "current");
  if (current.length !== 1) throw new Error(`expected one current stage, found ${current.length}`);
  return current[0]!;
}

function special(stages: StageView[], kind: "on_hold" | "archived"): StageView {
  const step = stages.find((s) => s.kind === kind);
  if (!step) throw new Error(`project has no ${kind} stage`);
  return step;
}

function byRole(stages: StageView[], role: StepRole): StageView {
  const step = stages.find((s) => s.role === role);
  if (!step) throw new Error(`project has no ${role} stage`);
  return step;
}

function cleanReason(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() ?? "";
  return trimmed.length ? trimmed : null;
}

function checkReason(reason: string | null): string | null {
  if (!reason || reason.length < REASON_MIN) return "Give a reason (at least 3 characters).";
  if (reason.length > REASON_MAX) return "The reason is too long (2,000 characters at most).";
  return null;
}

/** Diff a desired status map against the current statuses. */
function diff(stages: StageView[], desired: Map<string, StageStatus>): StageUpdate[] {
  const updates: StageUpdate[] = [];
  for (const stage of stages) {
    const next = desired.get(stage.id);
    if (next && next !== stage.status) updates.push({ id: stage.id, status: next });
  }
  return updates;
}

/**
 * Statuses for moving between linear stages `fromIndex` → `toIndex`. Forward
 * moves complete the origin and skip anything between; backward moves reset
 * everything after the target to upcoming.
 */
function linearMove(
  linear: StageView[],
  fromIndex: number,
  toIndex: number,
  desired: Map<string, StageStatus>,
): void {
  if (toIndex > fromIndex) {
    desired.set(linear[fromIndex]!.id, "completed");
    for (let i = fromIndex + 1; i < toIndex; i++) desired.set(linear[i]!.id, "skipped");
  } else {
    for (let i = toIndex + 1; i < linear.length; i++) desired.set(linear[i]!.id, "upcoming");
  }
  desired.set(linear[toIndex]!.id, "current");
}

/**
 * Checks a forward jump against the Live rules: a user can never land on Live,
 * and can only jump over it when no integration-backed production link exists.
 */
function checkForwardTarget(
  linear: StageView[],
  fromIndex: number,
  toIndex: number,
  context: TransitionContext,
): PlanResult | null {
  const target = linear[toIndex]!;
  if (target.role === "live") {
    return fail(`Live can't be chosen. ${LIVE_EXPLANATION}`, "targetId");
  }
  const liveIndex = linear.findIndex((s) => s.role === "live");
  const jumpsOverLive = liveIndex > fromIndex && liveIndex < toIndex;
  if (jumpsOverLive && context.hasIntegrationBackedProductionLink) {
    return fail(
      "This website has a connected production host, so the project can only reach Live through a confirmed production deploy.",
      "targetId",
    );
  }
  return null;
}

export function planUserTransition(
  state: ProjectStageState,
  request: UserTransitionRequest,
  context: TransitionContext,
): PlanResult {
  const { stages } = state;
  const current = currentStage(stages);
  const linear = linearStages(stages);
  const onHold = special(stages, "on_hold");
  const archived = special(stages, "archived");
  const desired = new Map<string, StageStatus>();
  const reason = "reason" in request ? cleanReason(request.reason) : null;

  if (current.kind === "archived" && request.kind !== "restore") {
    return fail("This project is archived. Restore it first.");
  }
  if (current.kind === "on_hold" && !["resume", "archive"].includes(request.kind)) {
    return fail("This project is on hold. Resume it first.");
  }

  switch (request.kind) {
    case "advance": {
      const index = linear.findIndex((s) => s.id === current.id);
      const next = linear[index + 1];
      if (!next) return fail(`${current.name} is the last stage.`);
      if (next.role === "live") {
        return fail(
          `The project can't be moved to Live by hand. ${LIVE_EXPLANATION} Without a connected hosting provider, skip past Live with a reason instead.`,
        );
      }
      linearMove(linear, index, index + 1, desired);
      return plan("advance", current.id, next.id, null);
    }

    case "skip_forward":
    case "move_back": {
      const error = checkReason(reason);
      if (error) return fail(error, "reason");
      const from = linear.findIndex((s) => s.id === current.id);
      const to = linear.findIndex((s) => s.id === request.targetId);
      if (to < 0) return fail("Choose a stage to move to.", "targetId");
      if (linear[to]!.role === "live") return fail(`Live can't be chosen. ${LIVE_EXPLANATION}`, "targetId");
      if (request.kind === "skip_forward") {
        if (to <= from + 1) {
          return fail("Skipping forward needs a stage at least two steps ahead.", "targetId");
        }
        const blocked = checkForwardTarget(linear, from, to, context);
        if (blocked) return blocked;
      } else if (to >= from) {
        return fail("Moving back needs an earlier stage.", "targetId");
      }
      linearMove(linear, from, to, desired);
      return plan(request.kind, current.id, linear[to]!.id, reason);
    }

    case "hold": {
      const error = checkReason(reason);
      if (error) return fail(error, "reason");
      desired.set(current.id, "upcoming");
      desired.set(onHold.id, "current");
      return plan("hold", current.id, onHold.id, reason, { heldFromId: current.id });
    }

    case "resume": {
      if (current.kind !== "on_hold") return fail("This project isn't on hold.");
      const heldIndex = linear.findIndex((s) => s.id === state.heldFromId);
      if (heldIndex < 0) throw new Error("on-hold project has no held-from stage");
      const targetId = request.targetId || state.heldFromId!;
      const to = linear.findIndex((s) => s.id === targetId);
      if (to < 0) return fail("Choose a stage to resume at.", "targetId");
      // Resuming onto Live is refused even when Live was the held stage.
      if (to !== heldIndex && linear[to]!.role === "live") {
        return fail(`Live can't be chosen. ${LIVE_EXPLANATION}`, "targetId");
      }
      desired.set(onHold.id, "upcoming");
      if (to === heldIndex) {
        desired.set(linear[to]!.id, "current");
        return plan("resume", current.id, linear[to]!.id, reason, { heldFromId: null });
      }
      // Resuming somewhere else is a jump from the held stage and needs a reason.
      const error = checkReason(reason);
      if (error) return fail(error, "reason");
      if (to > heldIndex) {
        const blocked = checkForwardTarget(linear, heldIndex, to, context);
        if (blocked) return blocked;
      }
      linearMove(linear, heldIndex, to, desired);
      return plan("resume", current.id, linear[to]!.id, reason, { heldFromId: null });
    }

    case "archive": {
      const error = checkReason(reason);
      if (error) return fail(error, "reason");
      if (context.hasInFlightDeploymentWork) {
        return fail(
          "This project has a production approval awaiting confirmation or a deploy in flight. Wait for it to finish first.",
        );
      }
      desired.set(current.id, "upcoming");
      desired.set(archived.id, "current");
      return plan("archive", current.id, archived.id, reason, { archive: "set" });
    }

    case "restore": {
      if (current.kind !== "archived") return fail("This project isn't archived.");
      const error = checkReason(reason);
      if (error) return fail(error, "reason");
      const target = stages.find((s) => s.id === state.restoreToId) ?? linear[0]!;
      desired.set(archived.id, "upcoming");
      desired.set(target.id, "current");
      return plan("restore", current.id, target.id, reason, { archive: "clear" });
    }
  }

  function plan(
    transition: StageTransition,
    fromId: string,
    toId: string,
    planReason: string | null,
    extra: Pick<TransitionPlan, "heldFromId" | "archive"> = {},
  ): PlanResult {
    return {
      ok: true,
      plan: { transition, fromId, toId, updates: diff(stages, desired), reason: planReason, ...extra },
    };
  }
}

/** Initial stage on creation: the first linear stage, or a chosen one up to Ready to Deploy. */
export function planInitial(stages: StageView[], initialStageKey?: string | null): PlanResult {
  const linear = linearStages(stages);
  const rtd = byRole(stages, "ready_to_deploy");
  const target = initialStageKey ? linear.find((s) => s.key === initialStageKey) : linear[0];
  if (!target || target.position > rtd.position) {
    return fail(`Start at a stage up to ${rtd.name}.`, "targetId");
  }
  const desired = new Map<string, StageStatus>();
  for (const stage of linear) {
    if (stage.position < target.position) desired.set(stage.id, "skipped");
  }
  desired.set(target.id, "current");
  return {
    ok: true,
    plan: { transition: "initial", fromId: null, toId: target.id, updates: diff(stages, desired), reason: null },
  };
}

/** What a provider-confirmed deployment must look like to move a project to Live (decision 0004). */
export type DeploymentFact = {
  id: string;
  projectId: string | null;
  environment: "production" | "preview" | "staging";
  origin: "provider_observed" | "sitesync_initiated" | "manual_record";
  state: string;
  confirmationSource: "provider" | null;
  hostingLinkHasIntegration: boolean;
};

export function checkGoLiveDeployment(projectId: string, deployment: DeploymentFact | null): string | null {
  if (!deployment) return "deployment not found";
  if (deployment.projectId !== projectId) return "deployment belongs to another project";
  if (deployment.environment !== "production") return "deployment is not a production deploy";
  if (deployment.origin === "manual_record") return "manual deployment records can't move a project to Live";
  if (deployment.state !== "published") return "deployment is not published";
  if (deployment.confirmationSource !== "provider") return "deployment is not confirmed by the provider";
  if (!deployment.hostingLinkHasIntegration) return "deployment's hosting link has no integration";
  return null;
}

/**
 * The system-only go_live transition. From Ready to Deploy it moves to Live;
 * from Live or any later linear stage (a re-deploy) it changes nothing.
 */
export function planGoLive(
  state: ProjectStageState,
): { ok: true; plan: TransitionPlan | null } | { ok: false; error: string } {
  const { stages } = state;
  const current = currentStage(stages);
  const rtd = byRole(stages, "ready_to_deploy");
  const live = byRole(stages, "live");
  if (current.kind !== "linear") return { ok: false, error: `project is ${current.name}` };
  if (current.position >= live.position) return { ok: true, plan: null };
  if (current.id !== rtd.id) return { ok: false, error: `project is at ${current.name}, not ${rtd.name}` };
  return {
    ok: true,
    plan: {
      transition: "go_live",
      fromId: rtd.id,
      toId: live.id,
      updates: [
        { id: rtd.id, status: "completed" },
        { id: live.id, status: "current" },
      ],
      reason: null,
    },
  };
}

/**
 * Maps "move to stage X" (what the UI asks) onto a §5.1 transition. Returns null
 * for a no-op (target is the current stage).
 */
export function inferTransition(state: ProjectStageState, targetId: string): UserTransitionKind | null {
  const current = currentStage(state.stages);
  const target = state.stages.find((s) => s.id === targetId);
  if (!target || target.id === current.id) return null;
  if (target.kind === "archived") return "archive";
  if (current.kind === "archived") return "restore";
  if (target.kind === "on_hold") return "hold";
  if (current.kind === "on_hold") return "resume";
  const linear = linearStages(state.stages);
  const from = linear.findIndex((s) => s.id === current.id);
  const to = linear.findIndex((s) => s.id === target.id);
  if (to === from + 1) return "advance";
  return to > from ? "skip_forward" : "move_back";
}

export function transitionLabel(transition: StageTransition): string {
  const labels: Record<StageTransition, string> = {
    initial: "Started",
    advance: "Advanced",
    skip_forward: "Skipped forward",
    move_back: "Moved back",
    hold: "Put on hold",
    resume: "Resumed",
    archive: "Archived",
    restore: "Restored",
    go_live: "Went live",
  };
  return labels[transition];
}
