"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/form-state";
import { FormMessage, SubmitButton } from "./controls";
import type { Button } from "@/components/ui/button";

/** A one-button form (archive, restore…) that shows the action's error message, if any. */
export function ActionButton({
  action,
  label,
  pendingLabel,
  variant = "outline",
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  label: string;
  pendingLabel?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form key={state.key} action={formAction} className="grid gap-2">
      <SubmitButton variant={variant} pendingLabel={pendingLabel}>
        {label}
      </SubmitButton>
      <FormMessage message={state.message} />
    </form>
  );
}
