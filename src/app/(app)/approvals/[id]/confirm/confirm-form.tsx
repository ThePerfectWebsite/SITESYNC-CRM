"use client";

import { useActionState, useEffect, useState } from "react";
import { Field } from "@/components/forms/field";
import { FormMessage, SubmitButton } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";

/** Time left on the approval. Display only: the server checks expiry itself. */
export function Countdown({ expiresAt }: { expiresAt: string }) {
  const end = new Date(expiresAt).getTime();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  if (now === null) return <span>expires {new Date(expiresAt).toLocaleTimeString()}</span>;
  const left = Math.max(0, Math.floor((end - now) / 1000));
  if (left === 0) return <span className="font-semibold text-destructive">expired</span>;
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, "0");
  // Announce only each minute, not every second.
  return (
    <span>
      <span aria-hidden="true" className="font-mono tabular-nums">
        {minutes}:{seconds}
      </span>
      <span className="sr-only" aria-live="polite">
        {minutes} minute{minutes === 1 ? "" : "s"} left
      </span>{" "}
      left
    </span>
  );
}

/** Final confirmation (spec §8.3 step 2): re-enter the password to release. */
export function ConfirmForm({ action }: { action: (state: FormState, formData: FormData) => Promise<FormState> }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form key={state.key} action={formAction} className="grid max-w-sm gap-3" noValidate>
      <FormMessage message={state.message} />
      <Field
        id="confirm-password"
        name="password"
        type="password"
        label="Your password"
        autoComplete="current-password"
        required
        maxLength={256}
        error={state.fieldErrors?.password}
      />
      <div>
        <SubmitButton pendingLabel="Releasing…">Confirm and release</SubmitButton>
      </div>
    </form>
  );
}
