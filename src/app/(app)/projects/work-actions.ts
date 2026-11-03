"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { isUuid } from "@/lib/ids";
import { db } from "@/server/db";
import { formValues, requireActor, runForm } from "@/server/http/action";
import { archiveChange, createChange, restoreChange, updateChange } from "@/server/records/changes";
import {
  addChecklistFromTemplate,
  archiveChecklistItem,
  restoreChecklistItem,
  setChecklistItemChecked,
} from "@/server/records/checklist";
import { DomainError } from "@/server/records/errors";
import { revokeWaiver, waiveBlocker } from "@/server/records/readiness";
import {
  archiveTask,
  completeTask,
  createTask,
  reopenTask,
  restoreTask,
  updateTask,
} from "@/server/records/tasks";

// Every action here acts on one project's work. Bound ids are checked by requireActor.

const TASK_FIELDS = ["title", "description", "status", "priority", "dueDate", "referenceUrl", "projectStageId"] as const;
const CHANGE_FIELDS = ["title", "description", "category", "status", "requestedByContactId", "taskId"] as const;

// --- Tasks -------------------------------------------------------------------

export async function createTaskAction(projectId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(projectId);
  const values = formValues(formData, TASK_FIELDS);
  const result = await runForm(values, () => createTask(db(), actor, projectId, values));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}/tasks`);
}

/** Quick-create: the project comes from the form. */
export async function createTaskForProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  const values = formValues(formData, [...TASK_FIELDS, "projectId"]);
  const result = await runForm(values, async () => {
    if (!isUuid(values.projectId)) {
      throw new DomainError("invalid", "Choose a project.", { projectId: "Choose a project." });
    }
    return createTask(db(), actor, values.projectId, values);
  });
  if (!result.ok) return result.state;
  redirect(`/projects/${values.projectId}/tasks`);
}

export async function updateTaskAction(
  projectId: string,
  taskId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireActor(projectId, taskId);
  const values = formValues(formData, TASK_FIELDS);
  const result = await runForm(values, () => updateTask(db(), actor, taskId, values));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}/tasks`);
}

function taskStep(step: typeof completeTask, back: (projectId: string, taskId: string) => string) {
  return async (projectId: string, taskId: string): Promise<FormState> => {
    const actor = await requireActor(projectId, taskId);
    const result = await runForm({}, () => step(db(), actor, taskId));
    if (!result.ok) return result.state;
    redirect(back(projectId, taskId));
  };
}

const toList = (projectId: string) => `/projects/${projectId}/tasks`;
const toTask = (projectId: string, taskId: string) => `/projects/${projectId}/tasks/${taskId}`;

export async function completeTaskAction(projectId: string, taskId: string): Promise<FormState> {
  return taskStep(completeTask, toList)(projectId, taskId);
}
export async function reopenTaskAction(projectId: string, taskId: string): Promise<FormState> {
  return taskStep(reopenTask, toList)(projectId, taskId);
}
export async function archiveTaskAction(projectId: string, taskId: string): Promise<FormState> {
  return taskStep(archiveTask, toTask)(projectId, taskId);
}
export async function restoreTaskAction(projectId: string, taskId: string): Promise<FormState> {
  return taskStep(restoreTask, toTask)(projectId, taskId);
}

// --- Changes -----------------------------------------------------------------

export async function createChangeAction(projectId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(projectId);
  const values = formValues(formData, CHANGE_FIELDS);
  const result = await runForm(values, () => createChange(db(), actor, projectId, values));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}/changes`);
}

export async function updateChangeAction(
  projectId: string,
  changeId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireActor(projectId, changeId);
  const values = formValues(formData, CHANGE_FIELDS);
  const result = await runForm(values, () => updateChange(db(), actor, changeId, values));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}/changes`);
}

export async function archiveChangeAction(projectId: string, changeId: string): Promise<FormState> {
  const actor = await requireActor(projectId, changeId);
  const result = await runForm({}, () => archiveChange(db(), actor, changeId));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}/changes/${changeId}`);
}

export async function restoreChangeAction(projectId: string, changeId: string): Promise<FormState> {
  const actor = await requireActor(projectId, changeId);
  const result = await runForm({}, () => restoreChange(db(), actor, changeId));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}/changes/${changeId}`);
}

// --- Checklist ---------------------------------------------------------------

export async function setChecklistItemAction(
  projectId: string,
  itemId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireActor(projectId, itemId);
  const values = formValues(formData, ["note", "checked"]);
  const result = await runForm(values, () =>
    setChecklistItemChecked(db(), actor, itemId, values.checked === "on", { note: values.note }),
  );
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}/settings`);
}

export async function archiveChecklistItemAction(projectId: string, itemId: string): Promise<FormState> {
  const actor = await requireActor(projectId, itemId);
  const result = await runForm({}, () => archiveChecklistItem(db(), actor, itemId));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}/settings`);
}

export async function restoreChecklistItemAction(projectId: string, itemId: string): Promise<FormState> {
  const actor = await requireActor(projectId, itemId);
  const result = await runForm({}, () => restoreChecklistItem(db(), actor, itemId));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}/settings`);
}

export async function addChecklistFromTemplateAction(projectId: string): Promise<FormState> {
  const actor = await requireActor(projectId);
  const result = await runForm({}, () => addChecklistFromTemplate(db(), actor, projectId));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}/settings`);
}

// --- Readiness ---------------------------------------------------------------

export async function waiveBlockerAction(projectId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(projectId);
  const values = formValues(formData, ["blockerKey", "reason", "commitSha"]);
  const result = await runForm(values, () => waiveBlocker(db(), actor, projectId, values));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}`);
}

export async function revokeWaiverAction(projectId: string, waiverId: string): Promise<FormState> {
  const actor = await requireActor(projectId, waiverId);
  const result = await runForm({}, () => revokeWaiver(db(), actor, waiverId));
  if (!result.ok) return result.state;
  redirect(`/projects/${projectId}`);
}
