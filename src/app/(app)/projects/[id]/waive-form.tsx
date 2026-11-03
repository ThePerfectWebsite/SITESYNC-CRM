"use client";

import { useActionState } from "react";
import { Field } from "@/components/forms/field";
import { FormMessage, SubmitButton, TextareaField } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";

/** Waive one readiness blocker: a reason is required, a commit SHA optionally scopes it. */
export function WaiveForm({
  action,
  blockerKey,
  idPrefix,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  blockerKey: string;
  idPrefix: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  return (
    <form key={state.key} action={formAction} className="grid max-w-xl gap-3" noValidate>
      <FormMessage message={state.message} />
      <input type="hidden" name="blockerKey" value={blockerKey} />
      <TextareaField
        id={`${idPrefix}-reason`}
        name="reason"
        label="Why is it OK to release without this?"
        rows={2}
        required
        maxLength={2000}
        defaultValue={state.values?.reason}
        error={errors.reason}
      />
      <Field
        id={`${idPrefix}-commitSha`}
        name="commitSha"
        label="Only for commit (optional)"
        maxLength={40}
        spellCheck={false}
        autoComplete="off"
        className="h-9 font-mono"
        hint="A full 40-character SHA limits the waiver to that one commit."
        defaultValue={state.values?.commitSha}
        error={errors.commitSha}
      />
      <div>
        <SubmitButton variant="outline" pendingLabel="Waiving…">
          Waive blocker
        </SubmitButton>
      </div>
    </form>
  );
}
