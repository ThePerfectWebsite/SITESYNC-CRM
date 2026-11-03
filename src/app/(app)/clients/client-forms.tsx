"use client";

import { useActionState } from "react";
import { Field } from "@/components/forms/field";
import { CheckboxField, FormMessage, SelectField, SubmitButton, TextareaField } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";
import { CLIENT_STATUS_LABELS, optionsFrom } from "@/lib/format";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

export type ClientFormValues = { name: string; slug: string; status: string; notes: string };

export function ClientForm({
  action,
  initial,
  submitLabel,
}: {
  action: Action;
  initial?: ClientFormValues;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? initial;
  return (
    <form key={state.key} action={formAction} className="grid max-w-xl gap-4" noValidate>
      <FormMessage message={state.message} />
      <Field name="name" label="Name" required maxLength={200} defaultValue={values?.name} error={errors.name} />
      <Field
        name="slug"
        label="Slug"
        maxLength={100}
        defaultValue={values?.slug}
        hint="Short ID for URLs and project codes. Leave blank to generate one from the name."
        error={errors.slug}
      />
      <SelectField
        name="status"
        label="Status"
        options={optionsFrom(CLIENT_STATUS_LABELS)}
        defaultValue={values?.status ?? "active"}
        error={errors.status}
      />
      <TextareaField name="notes" label="Notes" rows={5} maxLength={20000} defaultValue={values?.notes} error={errors.notes} />
      <div>
        <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

export type ContactFormValues = {
  name: string;
  email: string;
  phone: string;
  roleTitle: string;
  notes: string;
  isPrimary: boolean;
};

export function ContactForm({
  action,
  initial,
  submitLabel,
  idPrefix,
}: {
  action: Action;
  initial?: ContactFormValues;
  submitLabel: string;
  idPrefix: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? initial;
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <form key={state.key} action={formAction} className="grid gap-3 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2">
        <FormMessage message={state.message} />
      </div>
      <Field id={id("name")} name="name" label="Name" required maxLength={200} defaultValue={values?.name} error={errors.name} />
      <Field id={id("roleTitle")} name="roleTitle" label="Role" maxLength={200} defaultValue={values?.roleTitle} error={errors.roleTitle} />
      <Field
        id={id("email")}
        name="email"
        label="Email"
        type="email"
        maxLength={254}
        defaultValue={values?.email}
        error={errors.email}
      />
      <Field id={id("phone")} name="phone" label="Phone" type="tel" maxLength={50} defaultValue={values?.phone} error={errors.phone} />
      <div className="sm:col-span-2">
        <TextareaField id={id("notes")} name="notes" label="Notes" rows={2} maxLength={5000} defaultValue={values?.notes} error={errors.notes} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
        <CheckboxField
          id={id("isPrimary")}
          name="isPrimary"
          label="Primary contact"
          defaultChecked={state.values ? state.values.isPrimary === "on" : initial?.isPrimary}
        />
        <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
