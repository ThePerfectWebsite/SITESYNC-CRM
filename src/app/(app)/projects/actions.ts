"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { isUuid } from "@/lib/ids";
import { db } from "@/server/db";
import { formValues, requireActor, runForm } from "@/server/http/action";
import { DomainError, notFound } from "@/server/records/errors";
import { createProject, getProject, updateProject } from "@/server/records/projects";
import { inferTransition, type UserTransitionRequest } from "@/server/stages/machine";
import { confirmLiveFromProviderDeploy, loadStageState, transitionStage } from "@/server/stages/service";

const FIELDS = ["name", "code", "description", "startDate", "targetLaunchDate", "websiteId"] as const;

export async function createProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  const values = formValues(formData, [...FIELDS, "clientId", "initialStageKey"]);
  const result = await runForm(values, () => createProject(db(), actor, values));
  if (!result.ok) return result.state;
  redirect(`/projects/${result.value}`);
}

export async function updateProjectAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(id);
  const values = formValues(formData, FIELDS);
  const result = await runForm(values, () => updateProject(db(), actor, id, values));
  if (!result.ok) return result.state;
  redirect(`/projects/${id}/settings?saved=1`);
}

/**
 * One action for every operator stage move. The form says where to go; the
 * transition (advance, skip, back, hold, resume, archive, restore) is derived
 * from the project's stages on the server. Live is refused by the stage service.
 */
export async function moveStageAction(projectId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(projectId);
  const values = formValues(formData, ["targetId", "expectedCurrentStageId", "reason"]);
  const result = await runForm(values, async () => {
    if (!isUuid(values.targetId)) throw new DomainError("invalid", "Choose a stage.", { targetId: "Choose a stage." });
    if (!isUuid(values.expectedCurrentStageId)) throw new DomainError("stale", "Reload the page and try again.");
    const database = db();
    const row = await getProject(database, projectId);
    if (!row) throw notFound("Project");
    const state = await loadStageState(database, row.project);
    const kind = inferTransition(state, values.targetId);
    if (!kind) throw new DomainError("invalid", "The project is already at that stage.", { targetId: "Choose a different stage." });
    const reason = values.reason;
    const request: UserTransitionRequest =
      kind === "advance"
        ? { kind }
        : kind === "resume"
          ? { kind, targetId: values.targetId, reason }
          : kind === "skip_forward" || kind === "move_back"
            ? { kind, targetId: values.targetId, reason }
            : { kind, reason };
    return transitionStage(database, actor, {
      projectId,
      expectedCurrentStageId: values.expectedCurrentStageId,
      request,
    });
  });
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}`);
}

/**
 * OQ-2: the operator confirms that a deploy the provider published on its own
 * should move the project to Live. The go_live itself still requires the
 * provider's confirmation (decision 0004); the stage service checks it.
 */
export async function confirmLiveAction(projectId: string, deploymentId: string): Promise<FormState> {
  const actor = await requireActor(projectId, deploymentId);
  const result = await runForm({}, () => confirmLiveFromProviderDeploy(db(), actor, { projectId, deploymentId }));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}`);
}
