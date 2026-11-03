"use client";

import { useActionState } from "react";
import { FormMessage, SubmitButton } from "@/components/forms/controls";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/lib/form-state";

/** One checklist item: tick it (with an optional note) and save. */
export function ChecklistItemForm({
  action,
  itemId,
  label,
  required,
  checked,
  note,
  checkedBy,
  disabled,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  itemId: string;
  label: string;
  required: boolean;
  checked: boolean;
  note: string;
  /** "Checked by X on date", if checked. */
  checkedBy?: string;
  disabled?: boolean;
}) {
  const [state, formAction] = useActionState(action, {});
  const values = state.values;
  const id = `checklist-${itemId}`;
  return (
    <form key={state.key} action={formAction} className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_16rem_auto] lg:items-center">
      <div className="flex items-start gap-2">
        <input
          id={id}
          name="checked"
          type="checkbox"
          defaultChecked={values ? values.checked === "on" : checked}
          disabled={disabled}
          className="mt-0.5 size-4 shrink-0 accent-primary"
          aria-describedby={checkedBy ? `${id}-by` : undefined}
        />
        <label htmlFor={id} className="grid text-sm">
          <span>
            {label}
            {required ? null : <span className="text-muted-foreground"> (optional)</span>}
          </span>
          {checkedBy ? (
            <span id={`${id}-by`} className="text-xs text-muted-foreground">
              {checkedBy}
            </span>
          ) : null}
        </label>
      </div>
      <div>
        <label htmlFor={`${id}-note`} className="sr-only">
          Note for {label}
        </label>
        <Input
          id={`${id}-note`}
          name="note"
          maxLength={2000}
          placeholder="Note (optional)"
          defaultValue={values?.note ?? note}
          disabled={disabled}
          className="h-9"
        />
      </div>
      {disabled ? null : (
        <div>
          <SubmitButton variant="outline" pendingLabel="Saving…" accessibleLabel={`Save “${label}”`}>
            Save
          </SubmitButton>
        </div>
      )}
      {state.message || state.fieldErrors?.note ? (
        <div className="lg:col-span-3">
          <FormMessage message={state.message ?? state.fieldErrors?.note} />
        </div>
      ) : null}
    </form>
  );
}
