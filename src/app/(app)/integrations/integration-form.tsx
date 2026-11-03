"use client";

import { useActionState } from "react";
import { Field } from "@/components/forms/field";
import { CheckboxField, FormMessage, SubmitButton } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";

export type IntegrationFormValues = {
  name: string;
  tokenEnvVar: string;
  accountRef: string;
  webhookSecretEnvVar: string;
  pollEnabled: boolean;
  webhookEnabled: boolean;
};

export function IntegrationForm({
  action,
  initial,
  submitLabel,
  idPrefix,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  initial?: IntegrationFormValues;
  submitLabel: string;
  idPrefix: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const values = state.values;
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <form key={state.key} action={formAction} className="grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2">
        <FormMessage message={state.message} />
      </div>
      <Field id={id("name")} name="name" label="Name" required maxLength={100} defaultValue={values?.name ?? initial?.name} error={errors.name} />
      <Field
        id={id("accountRef")}
        name="accountRef"
        label="Account or organisation (optional)"
        maxLength={200}
        defaultValue={values?.accountRef ?? initial?.accountRef}
        error={errors.accountRef}
      />
      <div className="sm:col-span-2">
        <Field
          id={id("tokenEnvVar")}
          name="tokenEnvVar"
          label="Token env var name"
          required
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
          className="h-9 font-mono"
          placeholder="GITHUB_TOKEN"
          defaultValue={values?.tokenEnvVar ?? initial?.tokenEnvVar}
          hint="The name of an environment variable on this machine that holds a read-only token. SiteSync never stores or shows the token itself."
          error={errors.tokenEnvVar}
        />
      </div>
      <div className="sm:col-span-2">
        <CheckboxField id={id("pollEnabled")} name="pollEnabled" label="Poll GitHub for changes (every 10 minutes)" defaultChecked={initial?.pollEnabled ?? true} />
      </div>
      <fieldset className="grid gap-3 rounded-lg border p-3 sm:col-span-2">
        <legend className="px-1 text-sm font-medium">Webhooks (optional, off by default)</legend>
        <CheckboxField id={id("webhookEnabled")} name="webhookEnabled" label="Accept GitHub webhooks" defaultChecked={initial?.webhookEnabled ?? false} />
        <Field
          id={id("webhookSecretEnvVar")}
          name="webhookSecretEnvVar"
          label="Webhook secret env var name"
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
          className="h-9 font-mono"
          placeholder="GITHUB_WEBHOOK_SECRET"
          defaultValue={values?.webhookSecretEnvVar ?? initial?.webhookSecretEnvVar}
          hint="Needed when webhooks are on. GitHub must reach this machine, through a tunnel you run yourself (see docs/github.md)."
          error={errors.webhookSecretEnvVar}
        />
      </fieldset>
      <div className="sm:col-span-2">
        <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
