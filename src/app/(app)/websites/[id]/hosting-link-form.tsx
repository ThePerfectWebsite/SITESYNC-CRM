"use client";

import { useActionState, useState } from "react";
import { Field } from "@/components/forms/field";
import { FormMessage, SelectField, SubmitButton } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";

type Integration = { id: string; name: string; provider: string };

const PROJECT_LABEL: Record<string, { label: string; hint: string }> = {
  cloudflare: { label: "Pages project name", hint: "As shown in Cloudflare (Workers & Pages), e.g. my-client-site." },
  netlify: { label: "Netlify site ID", hint: "Site configuration → Site details → Site ID." },
  vercel: { label: "Vercel project ID or name", hint: "Project settings → General → Project ID." },
};

/** Link a host: through an integration (synced), or as a manual record (no sync). */
export function HostingLinkForm({
  action,
  integrations,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  integrations: Integration[];
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const values = state.values;
  const [integrationId, setIntegrationId] = useState(values?.integrationId ?? integrations[0]?.id ?? "");
  const integration = integrations.find((i) => i.id === integrationId);
  const project = integration ? PROJECT_LABEL[integration.provider] : null;
  return (
    <form key={state.key} action={formAction} className="grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2">
        <FormMessage message={state.message} />
      </div>
      <div className="sm:col-span-2">
        <SelectField
          id="host-integrationId"
          name="integrationId"
          label="Connection"
          options={[
            ...integrations.map((i) => ({ value: i.id, label: i.name })),
            { value: "", label: "None: a manual record (no sync)" },
          ]}
          value={integrationId}
          onChange={(event) => setIntegrationId(event.target.value)}
          hint="A manual record says where the site is hosted, but SiteSync can't see its deploys or confirm Live."
          error={errors.integrationId}
        />
      </div>
      {project ? (
        <div className="sm:col-span-2">
          <Field
            id="host-providerProjectId"
            name="providerProjectId"
            label={project.label}
            required
            maxLength={200}
            spellCheck={false}
            defaultValue={values?.providerProjectId}
            hint={project.hint}
            error={errors.providerProjectId}
          />
        </div>
      ) : (
        <SelectField
          id="host-provider"
          name="provider"
          label="Host"
          options={[
            { value: "cloudflare", label: "Cloudflare Pages" },
            { value: "netlify", label: "Netlify" },
            { value: "vercel", label: "Vercel" },
            { value: "other", label: "Other" },
          ]}
          defaultValue={values?.provider ?? "other"}
          error={errors.provider}
        />
      )}
      <SelectField
        id="host-environment"
        name="environment"
        label="Environment"
        options={[
          { value: "production", label: "Production" },
          { value: "staging", label: "Staging" },
          { value: "preview", label: "Preview" },
        ]}
        defaultValue={values?.environment ?? "production"}
        hint="One production host per website."
        error={errors.environment}
      />
      <Field
        id="host-domain"
        name="domain"
        label="Domain (optional)"
        maxLength={253}
        placeholder="www.example.com"
        defaultValue={values?.domain}
        hint={project ? "Filled in from the provider if left blank." : undefined}
        error={errors.domain}
      />
      <div className="sm:col-span-2">
        <SubmitButton pendingLabel="Linking…">Link host</SubmitButton>
      </div>
    </form>
  );
}
