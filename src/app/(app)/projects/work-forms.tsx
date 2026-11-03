"use client";

import { useActionState } from "react";
import { Field } from "@/components/forms/field";
import { FormMessage, SelectField, SubmitButton, TextareaField } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";
import {
  CHANGE_CATEGORY_LABELS,
  CHANGE_STATUS_LABELS,
  optionsFrom,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
} from "@/lib/format";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;
type Option = { value: string; label: string };

export type TaskFormValues = {
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string;
  referenceUrl: string;
  projectStageId: string;
};

const EDITABLE_STATUSES = optionsFrom(TASK_STATUS_LABELS).filter((o) => o.value !== "done");

export function TaskForm({
  action,
  initial,
  submitLabel,
  stages,
  projects,
  isDone = false,
  idPrefix = "task",
}: {
  action: Action;
  initial?: Partial<TaskFormValues>;
  submitLabel: string;
  /** The project's stages, for the optional "belongs to stage". */
  stages: Option[];
  /** Quick-create only: pick the project. */
  projects?: Option[];
  /** A done task's status changes only by reopening it. */
  isDone?: boolean;
  idPrefix?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const values = { ...initial, ...state.values };
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <form key={state.key} action={formAction} className="grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2">
        <FormMessage message={state.message} />
      </div>
      {projects ? (
        <div className="sm:col-span-2">
          <SelectField
            id={id("projectId")}
            name="projectId"
            label="Project"
            required
            placeholder="Choose a project"
            options={projects}
            defaultValue={(values as Record<string, string>).projectId ?? ""}
            error={errors.projectId}
          />
        </div>
      ) : null}
      <div className="sm:col-span-2">
        <Field id={id("title")} name="title" label="Title" required maxLength={300} defaultValue={values.title} error={errors.title} />
      </div>
      {isDone ? (
        <p className="text-sm text-muted-foreground sm:col-span-2">This task is done. Reopen it to change its status.</p>
      ) : (
        <SelectField
          id={id("status")}
          name="status"
          label="Status"
          options={EDITABLE_STATUSES}
          defaultValue={values.status ?? "open"}
          error={errors.status}
        />
      )}
      <SelectField
        id={id("priority")}
        name="priority"
        label="Priority"
        options={optionsFrom(TASK_PRIORITY_LABELS)}
        defaultValue={values.priority ?? "normal"}
        hint="Open critical tasks block release readiness."
        error={errors.priority}
      />
      <Field id={id("dueDate")} name="dueDate" label="Due date" type="date" defaultValue={values.dueDate} error={errors.dueDate} />
      <SelectField
        id={id("projectStageId")}
        name="projectStageId"
        label="Stage"
        placeholder="Any stage"
        options={stages}
        defaultValue={values.projectStageId ?? ""}
        error={errors.projectStageId}
      />
      <div className="sm:col-span-2">
        <Field
          id={id("referenceUrl")}
          name="referenceUrl"
          label="Reference link"
          type="url"
          maxLength={2048}
          placeholder="https://"
          hint="Optional: a ticket, doc or design. Shown as a link only."
          defaultValue={values.referenceUrl}
          error={errors.referenceUrl}
        />
      </div>
      <div className="sm:col-span-2">
        <TextareaField
          id={id("description")}
          name="description"
          label="Description"
          rows={4}
          maxLength={20000}
          defaultValue={values.description}
          error={errors.description}
        />
      </div>
      <div className="sm:col-span-2">
        <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

export type ChangeFormValues = {
  title: string;
  description: string;
  category: string;
  status: string;
  requestedByContactId: string;
  taskId: string;
};

export function ChangeForm({
  action,
  initial,
  submitLabel,
  contacts,
  tasks,
  idPrefix = "change",
}: {
  action: Action;
  initial?: Partial<ChangeFormValues>;
  submitLabel: string;
  contacts: Option[];
  tasks: Option[];
  idPrefix?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const values = { ...initial, ...state.values };
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <form key={state.key} action={formAction} className="grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2">
        <FormMessage message={state.message} />
      </div>
      <div className="sm:col-span-2">
        <Field id={id("title")} name="title" label="Title" required maxLength={300} defaultValue={values.title} error={errors.title} />
      </div>
      <SelectField
        id={id("category")}
        name="category"
        label="Category"
        required
        placeholder="Choose a category"
        options={optionsFrom(CHANGE_CATEGORY_LABELS)}
        defaultValue={values.category ?? ""}
        error={errors.category}
      />
      <SelectField
        id={id("status")}
        name="status"
        label="Status"
        options={optionsFrom(CHANGE_STATUS_LABELS)}
        defaultValue={values.status ?? "proposed"}
        error={errors.status}
      />
      <SelectField
        id={id("requestedByContactId")}
        name="requestedByContactId"
        label="Requested by"
        placeholder="Nobody in particular"
        options={contacts}
        defaultValue={values.requestedByContactId ?? ""}
        error={errors.requestedByContactId}
      />
      <SelectField
        id={id("taskId")}
        name="taskId"
        label="Related task"
        placeholder="None"
        options={tasks}
        defaultValue={values.taskId ?? ""}
        error={errors.taskId}
      />
      <div className="sm:col-span-2">
        <TextareaField
          id={id("description")}
          name="description"
          label="Description"
          rows={4}
          maxLength={20000}
          defaultValue={values.description}
          error={errors.description}
        />
      </div>
      <div className="sm:col-span-2">
        <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
