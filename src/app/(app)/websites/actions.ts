"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { db } from "@/server/db";
import { formValues, requireActor, runForm } from "@/server/http/action";
import { archiveWebsite, createWebsite, restoreWebsite, updateWebsite } from "@/server/records/websites";

const FIELDS = ["name", "primaryDomain", "status", "notes"] as const;

export async function createWebsiteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  const values = formValues(formData, [...FIELDS, "clientId"]);
  const result = await runForm(values, () => createWebsite(db(), actor, values));
  if (!result.ok) return result.state;
  redirect(`/websites/${result.value}`);
}

export async function updateWebsiteAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(id);
  const values = formValues(formData, FIELDS);
  const result = await runForm(values, () => updateWebsite(db(), actor, id, values));
  if (!result.ok) return result.state;
  redirect(`/websites/${id}`);
}

export async function archiveWebsiteAction(id: string): Promise<FormState> {
  const actor = await requireActor(id);
  const result = await runForm({}, () => archiveWebsite(db(), actor, id));
  if (!result.ok) return result.state;
  redirect(`/websites/${id}`);
}

export async function restoreWebsiteAction(id: string): Promise<FormState> {
  const actor = await requireActor(id);
  const result = await runForm({}, () => restoreWebsite(db(), actor, id));
  if (!result.ok) return result.state;
  redirect(`/websites/${id}`);
}
