"use client";

import { useActionState } from "react";
import { Field } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { loginAction, type FormState } from "../actions";

export function LoginForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(loginAction, {});
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="grid gap-4" noValidate>
      <div aria-live="polite">
        {state.message ? (
          <Alert variant="destructive">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="username"
        required
        defaultValue={state.values?.email}
        error={errors.email}
      />
      <Field
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        error={errors.password}
      />
      <Button type="submit" className="h-9" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
