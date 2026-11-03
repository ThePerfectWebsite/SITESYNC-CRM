"use client";

import { useActionState, useState } from "react";
import { Field } from "@/components/forms/field";
import { CheckboxField, FormMessage, SelectField, SubmitButton } from "@/components/forms/controls";
import type { FormState } from "@/lib/form-state";

type Provider = "github" | "cloudflare" | "netlify" | "vercel";

export type IntegrationFormValues = {
  name: string;
  tokenEnvVar: string;
  accountRef: string;
  webhookSecretEnvVar: string;
  pollEnabled: boolean;
  webhookEnabled: boolean;
};

const PROVIDER_OPTIONS: { value: Provider; label: string }[] = [
  { value: "github", label: "GitHub (source)" },
  { value: "cloudflare", label: "Cloudflare Pages (hosting)" },
  { value: "netlify", label: "Netlify (hosting)" },
  { value: "vercel", label: "Vercel (hosting)" },
];

const HINTS: Record<Provider, { token: string; tokenPlaceholder: string; account: string; accountLabel: string }> = {
  github: {
    token: "A read-only fine-grained token (see docs/github.md).",
    tokenPlaceholder: "GITHUB_TOKEN",
    accountLabel: "Account or organisation (optional)",
    account: "For your reference only.",
  },
  cloudflare: {
    token: "A Cloudflare API token with the Pages Read permission (see docs/hosting.md).",
    tokenPlaceholder: "CLOUDFLARE_API_TOKEN",
    accountLabel: "Cloudflare account ID",
    account: "Required: the 32-character account ID from your Cloudflare dashboard.",
  },
  netlify: {
    token: "A Netlify personal access token.",
    tokenPlaceholder: "NETLIFY_TOKEN",
    accountLabel: "Account (optional)",
    account: "For your reference only.",
  },
  vercel: {
    token: "A Vercel access token.",
    tokenPlaceholder: "VERCEL_TOKEN",
    accountLabel: "Team ID (optional)",
    account: "Needed only for projects owned by a team.",
  },
};

export function IntegrationForm({
  action,
  initial,
  submitLabel,
  idPrefix,
  provider: fixedProvider,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  initial?: IntegrationFormValues;
  submitLabel: string;
  idPrefix: string;
  /** Editing: the provider can't change. Omitted when adding: the operator chooses. */
  provider?: Provider;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const values = state.values;
  const [chosen, setChosen] = useState<Provider>((values?.provider as Provider) ?? "github");
  const provider = fixedProvider ?? chosen;
  const hints = HINTS[provider];
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <form key={state.key} action={formAction} className="grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2">
        <FormMessage message={state.message} />
      </div>
      {fixedProvider ? null : (
        <div className="sm:col-span-2">
          <SelectField
            id={id("provider")}
            name="provider"
            label="Provider"
            options={PROVIDER_OPTIONS}
            value={chosen}
            onChange={(event) => setChosen(event.target.value as Provider)}
            error={errors.provider}
          />
        </div>
      )}
      <Field id={id("name")} name="name" label="Name" required maxLength={100} defaultValue={values?.name ?? initial?.name} error={errors.name} />
      <Field
        id={id("accountRef")}
        name="accountRef"
        label={hints.accountLabel}
        maxLength={200}
        spellCheck={false}
        defaultValue={values?.accountRef ?? initial?.accountRef}
        hint={hints.account}
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
          placeholder={hints.tokenPlaceholder}
          defaultValue={values?.tokenEnvVar ?? initial?.tokenEnvVar}
          hint={`The name of an environment variable on this machine that holds the token. ${hints.token} SiteSync never stores or shows the token itself.`}
          error={errors.tokenEnvVar}
        />
      </div>
      <div className="sm:col-span-2">
        <CheckboxField
          id={id("pollEnabled")}
          name="pollEnabled"
          label="Check for changes automatically (every 10 minutes)"
          defaultChecked={initial?.pollEnabled ?? true}
        />
      </div>
      {provider === "github" ? (
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
      ) : null}
      <div className="sm:col-span-2">
        <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
