"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { db } from "@/server/db";
import { formValues, requireActor, runForm } from "@/server/http/action";
import { saveChecklistTemplate, type TemplateRowInput } from "@/server/records/checklist";
import { saveAppTimeZone } from "@/server/records/dates";

/**
 * The template editor posts parallel lists: key[], label[], plus per-row
 * checkboxes required-<i> and remove-<i>. Blank new rows are ignored.
 */
export async function saveChecklistTemplateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  const keys = formData.getAll("key").map(String);
  const labels = formData.getAll("label").map(String);
  const rows: TemplateRowInput[] = labels.map((label, i) => ({
    key: keys[i] || null,
    label,
    required: formData.get(`required-${i}`) === "on",
    remove: formData.get(`remove-${i}`) === "on",
  }));
  const result = await runForm({}, () => saveChecklistTemplate(db(), actor, rows));
  if (!result.ok) {
    const problems = Object.values(result.state.fieldErrors ?? {}).filter(Boolean);
    return { ...result.state, message: result.state.message ?? problems.join(" ") };
  }
  redirect("/settings?saved=checklist");
}

export async function saveTimeZoneAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  const values = formValues(formData, ["timeZone"]);
  const result = await runForm(values, () => saveAppTimeZone(db(), actor, values));
  if (!result.ok) return result.state;
  redirect("/settings?saved=timezone");
}
