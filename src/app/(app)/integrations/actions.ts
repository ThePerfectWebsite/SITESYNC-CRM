"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { db } from "@/server/db";
import { formValues, requireActor, runForm } from "@/server/http/action";
import { archiveRepositoryLink, createRepositoryLink } from "@/server/integrations/repo-links";
import {
  archiveIntegration,
  createIntegration,
  setIntegrationDisabled,
  testIntegration,
  updateIntegration,
} from "@/server/integrations/service";
import { replayDelivery } from "@/server/integrations/webhooks";
import { enqueueSync, enqueueWebhook } from "@/server/jobs/runtime";

const FIELDS = ["name", "tokenEnvVar", "accountRef", "webhookSecretEnvVar"] as const;

function integrationInput(formData: FormData) {
  const values = formValues(formData, FIELDS);
  return {
    values,
    input: {
      ...values,
      pollEnabled: formData.get("pollEnabled") === "on",
      webhookEnabled: formData.get("webhookEnabled") === "on",
    },
  };
}

export async function createIntegrationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  const { values, input } = integrationInput(formData);
  const result = await runForm(values, () => createIntegration(db(), actor, { ...input, provider: "github" }));
  if (!result.ok) return result.state;
  redirect("/integrations?created=1");
}

export async function updateIntegrationAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(id);
  const { values, input } = integrationInput(formData);
  const result = await runForm(values, () => updateIntegration(db(), actor, id, input));
  if (!result.ok) return result.state;
  redirect("/integrations?saved=1");
}

export async function testIntegrationAction(id: string): Promise<FormState> {
  const actor = await requireActor(id);
  const result = await runForm({}, () => testIntegration(db(), actor, id));
  if (!result.ok) return result.state;
  redirect(`/integrations?tested=${result.value.ok ? "ok" : "failed"}`);
}

export async function disableIntegrationAction(id: string): Promise<FormState> {
  const actor = await requireActor(id);
  const result = await runForm({}, () => setIntegrationDisabled(db(), actor, id, true));
  if (!result.ok) return result.state;
  redirect("/integrations");
}

export async function enableIntegrationAction(id: string): Promise<FormState> {
  const actor = await requireActor(id);
  const result = await runForm({}, () => setIntegrationDisabled(db(), actor, id, false));
  if (!result.ok) return result.state;
  redirect("/integrations");
}

export async function archiveIntegrationAction(id: string): Promise<FormState> {
  const actor = await requireActor(id);
  const result = await runForm({}, () => archiveIntegration(db(), actor, id));
  if (!result.ok) return result.state;
  redirect("/integrations");
}

export async function replayDeliveryAction(id: string): Promise<FormState> {
  const actor = await requireActor(id);
  const result = await runForm({}, () => replayDelivery(db(), actor, id));
  if (!result.ok) return result.state;
  await enqueueWebhook(id);
  redirect("/integrations?replayed=1");
}

// --- Repository links (website detail) ------------------------------------------

export async function createRepositoryLinkAction(websiteId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(websiteId);
  const values = formValues(formData, ["integrationId", "owner", "repo", "productionBranch"]);
  const result = await runForm(values, () =>
    createRepositoryLink(db(), actor, websiteId, { ...values, isPrimary: formData.get("isPrimary") === "on" }),
  );
  if (!result.ok) return result.state;
  // First sync straight away (queued, or inline if the job runner isn't up).
  await enqueueSync(result.value, "initial");
  redirect(`/websites/${websiteId}`);
}

export async function refreshRepositoryLinkAction(websiteId: string, linkId: string): Promise<FormState> {
  await requireActor(websiteId, linkId);
  const outcome = await enqueueSync(linkId, "manual");
  redirect(`/websites/${websiteId}?refresh=${outcome}`);
}

export async function archiveRepositoryLinkAction(websiteId: string, linkId: string): Promise<FormState> {
  const actor = await requireActor(websiteId, linkId);
  const result = await runForm({}, () => archiveRepositoryLink(db(), actor, linkId));
  if (!result.ok) return result.state;
  redirect(`/websites/${websiteId}`);
}
