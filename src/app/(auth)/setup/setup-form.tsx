"use client";

import { useActionState } from "react";
import { Field } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { setupAction, type FormState } from "../actions";

export function SetupForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(setupAction, {});
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="grid gap-4" noValidate>
      <Field
        name="displayName"
        label="Your name"
        autoComplete="name"
        required
        maxLength={200}
        defaultValue={state.values?.displayName}
        error={errors.displayName}
      />
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="username"
        required
        maxLength={254}
        defaultValue={state.values?.email}
        error={errors.email}
      />
      <Field
        name="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        required
        minLength={12}
        maxLength={256}
        hint="At least 12 characters. A passphrase works well."
        error={errors.password}
      />
      <Field
        name="confirmPassword"
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        required
        error={errors.confirmPassword}
      />
      <Button type="submit" className="h-9" disabled={pending}>
        {pending ? "Creating account…" : "Create admin account"}
      </Button>
    </form>
  );
}
