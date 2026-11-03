"use client";

import { useActionState } from "react";
import { FormMessage, SelectField, SubmitButton, TextareaField } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";

type Stage = {
  id: string;
  name: string;
  kind: "linear" | "on_hold" | "archived";
  role: "ready_to_deploy" | "live" | null;
};

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/** A single-button move (advance, resume at the held stage) with no reason. */
export function QuickMove({
  action,
  currentId,
  targetId,
  label,
}: {
  action: Action;
  currentId: string;
  targetId: string;
  label: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form key={state.key} action={formAction} className="grid gap-2">
      <input type="hidden" name="expectedCurrentStageId" value={currentId} />
      <input type="hidden" name="targetId" value={targetId} />
      <div>
        <SubmitButton pendingLabel="Moving…">{label}</SubmitButton>
      </div>
      <FormMessage message={state.message ?? state.fieldErrors?.targetId} />
    </form>
  );
}

/** Restore an archived project (to where it was archived from); needs a reason. */
export function RestoreForm({ action, currentId, targetId }: { action: Action; currentId: string; targetId: string }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form key={state.key} action={formAction} className="grid max-w-xl gap-3" noValidate>
      <FormMessage message={state.message} />
      <input type="hidden" name="expectedCurrentStageId" value={currentId} />
      <input type="hidden" name="targetId" value={targetId} />
      <TextareaField
        id="restore-reason"
        name="reason"
        label="Reason for restoring"
        rows={2}
        required
        maxLength={2000}
        defaultValue={state.values?.reason}
        error={state.fieldErrors?.reason}
      />
      <div>
        <SubmitButton pendingLabel="Restoring…">Restore project</SubmitButton>
      </div>
    </form>
  );
}

/** Move to any other stage. Live is listed but can't be chosen. */
export function MoveStageForm({
  action,
  currentId,
  stages,
  heldFromId,
  idPrefix = "move",
  onlyArchive = false,
}: {
  action: Action;
  currentId: string;
  stages: Stage[];
  heldFromId: string | null;
  idPrefix?: string;
  /** Project settings uses this form for archiving only. */
  onlyArchive?: boolean;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const choices = stages.filter((s) => s.id !== currentId && s.role !== "live" && (!onlyArchive || s.kind === "archived"));
  const label = (s: Stage) =>
    s.kind === "on_hold" ? `${s.name} (pause)` : s.kind === "archived" ? `${s.name} (archive the project)` : s.name;

  return (
    <form key={state.key} action={formAction} className="grid max-w-xl gap-3" noValidate>
      <FormMessage message={state.message} />
      <input type="hidden" name="expectedCurrentStageId" value={currentId} />
      {onlyArchive ? (
        <input type="hidden" name="targetId" value={choices[0]?.id ?? ""} />
      ) : (
        <SelectField
          id={`${idPrefix}-target`}
          name="targetId"
          label="Move to"
          required
          placeholder="Choose a stage"
          options={choices.map((s) => ({ value: s.id, label: label(s) }))}
          defaultValue={state.values?.targetId ?? ""}
          hint="Live isn't listed: it's reached automatically after a confirmed production deploy."
          error={errors.targetId}
        />
      )}
      <TextareaField
        id={`${idPrefix}-reason`}
        name="reason"
        label="Reason"
        rows={2}
        maxLength={2000}
        defaultValue={state.values?.reason}
        hint={
          onlyArchive
            ? "Required. Archived projects are hidden from lists and can be restored."
            : `Required, except when advancing one stage${heldFromId ? " or resuming where the project was held" : ""}.`
        }
        error={errors.reason}
      />
      <div>
        <SubmitButton variant={onlyArchive ? "destructive" : "default"} pendingLabel="Moving…">
          {onlyArchive ? "Archive project" : "Move stage"}
        </SubmitButton>
      </div>
    </form>
  );
}
