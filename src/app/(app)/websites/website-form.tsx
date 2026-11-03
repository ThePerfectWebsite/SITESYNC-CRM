"use client";

import { useActionState } from "react";
import { Field } from "@/components/forms/field";
import { FormMessage, SelectField, SubmitButton, TextareaField } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";
import { optionsFrom, WEBSITE_STATUS_LABELS } from "@/lib/format";

export type WebsiteFormValues = { clientId?: string; name: string; primaryDomain: string; status: string; notes: string };

export function WebsiteForm({
  action,
  initial,
  submitLabel,
  clients,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  initial?: WebsiteFormValues;
  submitLabel: string;
  /** Present when creating: the client can't change afterwards. */
  clients?: { id: string; name: string }[];
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? initial;
  return (
    <form key={state.key} action={formAction} className="grid max-w-xl gap-4" noValidate>
      <FormMessage message={state.message} />
      {clients ? (
        <SelectField
          name="clientId"
          label="Client"
          required
          placeholder="Choose a client"
          options={clients.map((c) => ({ value: c.id, label: c.name }))}
          defaultValue={values?.clientId ?? ""}
          hint="A website's client can't change later."
          error={errors.clientId}
        />
      ) : null}
      <Field name="name" label="Name" required maxLength={200} defaultValue={values?.name} error={errors.name} />
      <Field
        name="primaryDomain"
        label="Primary domain"
        maxLength={253}
        defaultValue={values?.primaryDomain}
        placeholder="example.com"
        hint="Just the domain, without https:// or a path. Optional."
        error={errors.primaryDomain}
      />
      <SelectField
        name="status"
        label="Status"
        options={optionsFrom(WEBSITE_STATUS_LABELS)}
        defaultValue={values?.status ?? "planned"}
        error={errors.status}
      />
      <TextareaField name="notes" label="Notes" rows={5} maxLength={20000} defaultValue={values?.notes} error={errors.notes} />
      <div>
        <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
