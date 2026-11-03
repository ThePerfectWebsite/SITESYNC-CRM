"use client";

import { useActionState } from "react";
import { FormMessage, SubmitButton, TextareaField } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";

/**
 * Approve (spec §8.3 step 1). The hash is of what this page showed; the server
 * recomputes it and refuses if anything changed since.
 */
export function ApproveForm({
  action,
  releaseAction,
  targetDeploymentId,
  preflightHash,
  disabled,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  releaseAction: string;
  targetDeploymentId: string | null;
  preflightHash: string;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  return (
    <form key={state.key} action={formAction} className="grid max-w-xl gap-3" noValidate>
      <FormMessage message={state.message} />
      <input type="hidden" name="action" value={releaseAction} />
      <input type="hidden" name="targetDeploymentId" value={targetDeploymentId ?? ""} />
      <input type="hidden" name="preflightHash" value={preflightHash} />
      <TextareaField
        id="approve-reason"
        name="reason"
        label="Reason for this release"
        rows={2}
        required
        maxLength={2000}
        disabled={disabled}
        defaultValue={state.values?.reason}
        error={errors.reason}
        hint="Recorded with the approval. You confirm with your password on the next screen, within 30 minutes."
      />
      <div>
        {disabled ? (
          <p className="text-sm text-muted-foreground">Approve is unavailable until everything above is resolved.</p>
        ) : (
          <SubmitButton pendingLabel="Approving…">Approve release</SubmitButton>
        )}
      </div>
    </form>
  );
}
