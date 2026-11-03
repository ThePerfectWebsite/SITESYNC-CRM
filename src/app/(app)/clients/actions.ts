"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { db } from "@/server/db";
import { formValues, requireActor, runForm } from "@/server/http/action";
import { archiveClient, createClient, restoreClient, updateClient } from "@/server/records/clients";
import { archiveContact, createContact, restoreContact, updateContact } from "@/server/records/contacts";

const CLIENT_FIELDS = ["name", "slug", "status", "notes"] as const;
const CONTACT_FIELDS = ["name", "email", "phone", "roleTitle", "notes"] as const;

export async function createClientAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  const values = formValues(formData, CLIENT_FIELDS);
  const result = await runForm(values, () => createClient(db(), actor, values));
  if (!result.ok) return result.state;
  redirect(`/clients/${result.value}`);
}

export async function updateClientAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(id);
  const values = formValues(formData, CLIENT_FIELDS);
  const result = await runForm(values, () => updateClient(db(), actor, id, values));
  if (!result.ok) return result.state;
  redirect(`/clients/${id}`);
}

export async function archiveClientAction(id: string): Promise<FormState> {
  const actor = await requireActor(id);
  const result = await runForm({}, () => archiveClient(db(), actor, id));
  if (!result.ok) return result.state;
  redirect(`/clients/${id}`);
}

export async function restoreClientAction(id: string): Promise<FormState> {
  const actor = await requireActor(id);
  const result = await runForm({}, () => restoreClient(db(), actor, id));
  if (!result.ok) return result.state;
  redirect(`/clients/${id}`);
}

function contactInput(formData: FormData) {
  const values = formValues(formData, CONTACT_FIELDS);
  const isPrimary = formData.get("isPrimary") === "on";
  return { values: { ...values, isPrimary: isPrimary ? "on" : "" }, input: { ...values, isPrimary } };
}

export async function createContactAction(clientId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(clientId);
  const { values, input } = contactInput(formData);
  const result = await runForm(values, () => createContact(db(), actor, clientId, input));
  if (!result.ok) return result.state;
  redirect(`/clients/${clientId}`);
}

export async function updateContactAction(
  clientId: string,
  contactId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireActor(clientId, contactId);
  const { values, input } = contactInput(formData);
  const result = await runForm(values, () => updateContact(db(), actor, contactId, input));
  if (!result.ok) return result.state;
  redirect(`/clients/${clientId}`);
}

export async function archiveContactAction(clientId: string, contactId: string): Promise<FormState> {
  const actor = await requireActor(clientId, contactId);
  const result = await runForm({}, () => archiveContact(db(), actor, contactId));
  if (!result.ok) return result.state;
  redirect(`/clients/${clientId}`);
}

export async function restoreContactAction(clientId: string, contactId: string): Promise<FormState> {
  const actor = await requireActor(clientId, contactId);
  const result = await runForm({}, () => restoreContact(db(), actor, contactId));
  if (!result.ok) return result.state;
  redirect(`/clients/${clientId}`);
}
