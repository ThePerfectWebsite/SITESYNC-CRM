"use client";

import { useActionState, useState } from "react";
import { Field } from "@/components/forms/field";
import { FormMessage, SelectField, SubmitButton, TextareaField } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";

type Option = { id: string; name: string };
type WebsiteOption = Option & { clientId: string; domain: string | null };

export type ProjectFormValues = {
  clientId?: string;
  websiteId: string;
  name: string;
  code: string;
  description: string;
  startDate: string;
  targetLaunchDate: string;
  initialStageKey?: string;
};

export function ProjectForm({
  action,
  initial,
  submitLabel,
  clients,
  websites,
  initialStages,
  lockedClientId,
  websiteLockedReason,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  initial: ProjectFormValues;
  submitLabel: string;
  /** Only when creating: the client can't change afterwards. */
  clients?: Option[];
  websites: WebsiteOption[];
  /** Only when creating: stages a project may start at. */
  initialStages?: { key: string; name: string }[];
  /** When editing: websites are limited to the project's client. */
  lockedClientId?: string;
  websiteLockedReason?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const values = { ...initial, ...state.values };
  const [clientId, setClientId] = useState(values.clientId ?? lockedClientId ?? "");
  const clientWebsites = websites.filter((w) => w.clientId === (lockedClientId ?? clientId));

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
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          error={errors.clientId}
        />
      ) : null}
      <SelectField
        key={lockedClientId ?? clientId}
        name="websiteId"
        label="Website"
        required
        placeholder={clientWebsites.length ? "Choose a website" : "This client has no websites yet"}
        options={clientWebsites.map((w) => ({ value: w.id, label: w.domain ? `${w.name} (${w.domain})` : w.name }))}
        defaultValue={clientWebsites.some((w) => w.id === values.websiteId) ? values.websiteId : ""}
        disabled={Boolean(websiteLockedReason)}
        hint={websiteLockedReason ?? "One of the client's websites."}
        error={errors.websiteId}
      />
      {websiteLockedReason ? <input type="hidden" name="websiteId" value={values.websiteId} /> : null}
      <Field name="name" label="Name" required maxLength={200} defaultValue={values.name} error={errors.name} />
      <Field
        name="code"
        label="Code"
        maxLength={30}
        defaultValue={values.code}
        placeholder="ACME-2026-01"
        hint="Optional short reference, unique across live projects."
        error={errors.code}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="startDate" label="Start date" type="date" defaultValue={values.startDate} error={errors.startDate} />
        <Field
          name="targetLaunchDate"
          label="Target launch date"
          type="date"
          defaultValue={values.targetLaunchDate}
          error={errors.targetLaunchDate}
        />
      </div>
      {initialStages ? (
        <SelectField
          name="initialStageKey"
          label="Starting stage"
          options={initialStages.map((s) => ({ value: s.key, label: s.name }))}
          defaultValue={values.initialStageKey ?? initialStages[0]?.key}
          hint="Earlier stages are marked as skipped."
          error={errors.initialStageKey}
        />
      ) : null}
      <TextareaField
        name="description"
        label="Description"
        rows={5}
        maxLength={20000}
        defaultValue={values.description}
        error={errors.description}
      />
      <div>
        <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
