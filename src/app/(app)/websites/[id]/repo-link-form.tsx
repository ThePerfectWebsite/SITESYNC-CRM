"use client";

import { useActionState } from "react";
import { Field } from "@/components/forms/field";
import { CheckboxField, FormMessage, SelectField, SubmitButton } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";

export function RepoLinkForm({
  action,
  integrations,
  hasPrimary,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  integrations: { value: string; label: string }[];
  hasPrimary: boolean;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const values = state.values;
  return (
    <form key={state.key} action={formAction} className="grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2">
        <FormMessage message={state.message} />
      </div>
      <div className="sm:col-span-2">
        <SelectField
          id="repo-integrationId"
          name="integrationId"
          label="GitHub integration"
          required
          options={integrations}
          defaultValue={values?.integrationId ?? integrations[0]?.value ?? ""}
          error={errors.integrationId}
        />
      </div>
      <Field
        id="repo-owner"
        name="owner"
        label="Owner"
        required
        maxLength={39}
        spellCheck={false}
        placeholder="acme-studio"
        defaultValue={values?.owner}
        error={errors.owner}
      />
      <Field
        id="repo-repo"
        name="repo"
        label="Repository"
        required
        maxLength={100}
        spellCheck={false}
        placeholder="client-website"
        defaultValue={values?.repo}
        error={errors.repo}
      />
      <Field
        id="repo-productionBranch"
        name="productionBranch"
        label="Production branch"
        required
        maxLength={255}
        spellCheck={false}
        defaultValue={values?.productionBranch ?? "main"}
        hint="The branch that goes live."
        error={errors.productionBranch}
      />
      {hasPrimary ? (
        <div className="flex items-end pb-1">
          <CheckboxField id="repo-isPrimary" name="isPrimary" label="Make this the primary repository" />
        </div>
      ) : null}
      <div className="sm:col-span-2">
        <SubmitButton pendingLabel="Linking…">Link repository</SubmitButton>
      </div>
    </form>
  );
}
