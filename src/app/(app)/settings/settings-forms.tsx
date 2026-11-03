"use client";

import { useActionState } from "react";
import { Field } from "@/components/forms/field";
import { FormMessage, SubmitButton } from "@/components/forms/controls";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/lib/form-state";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;
type Item = { key: string; label: string; required: boolean };

const BLANK_ROWS = 3;

/** Edits the release checklist template. Existing items keep their key. */
export function ChecklistTemplateForm({ action, items }: { action: Action; items: Item[] }) {
  const [state, formAction] = useActionState(action, {});
  const rows: (Item | null)[] = [...items, ...Array.from({ length: BLANK_ROWS }, () => null)];
  return (
    <form key={state.key} action={formAction} className="grid gap-3" noValidate>
      <FormMessage message={state.message} />
      <table className="w-full text-sm">
        <caption className="sr-only">Release checklist template items</caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="pb-2 font-medium">
              Item
            </th>
            <th scope="col" className="w-24 pb-2 text-center font-medium">
              Required
            </th>
            <th scope="col" className="w-24 pb-2 text-center font-medium">
              Remove
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item, i) => (
            <tr key={item?.key ?? `new-${i}`}>
              <td className="py-1 pr-3">
                <input type="hidden" name="key" value={item?.key ?? ""} />
                <label htmlFor={`template-label-${i}`} className="sr-only">
                  {item ? `Label for ${item.label}` : `New item ${i - items.length + 1}`}
                </label>
                <Input
                  id={`template-label-${i}`}
                  name="label"
                  maxLength={300}
                  defaultValue={item?.label ?? ""}
                  placeholder={item ? undefined : "Add an item"}
                  className="h-9"
                />
              </td>
              <td className="py-1 text-center">
                <input
                  type="checkbox"
                  name={`required-${i}`}
                  defaultChecked={item ? item.required : true}
                  aria-label={item ? `${item.label} is required` : `New item ${i - items.length + 1} is required`}
                  className="size-4 accent-primary"
                />
              </td>
              <td className="py-1 text-center">
                {item ? (
                  <input
                    type="checkbox"
                    name={`remove-${i}`}
                    aria-label={`Remove ${item.label}`}
                    className="size-4 accent-primary"
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        Changes apply to new projects, and to existing ones when you use &ldquo;Add checklist from template&rdquo; (which only
        adds missing items).
      </p>
      <div>
        <SubmitButton pendingLabel="Saving…">Save template</SubmitButton>
      </div>
    </form>
  );
}

export function TimeZoneForm({ action, current }: { action: Action; current: string }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form key={state.key} action={formAction} className="flex flex-wrap items-end gap-3" noValidate>
      <div className="w-72">
        <Field
          name="timeZone"
          label="Time zone"
          defaultValue={state.values?.timeZone ?? current}
          hint="Decides what “today” is for due dates and overdue work."
          error={state.fieldErrors?.timeZone}
          spellCheck={false}
        />
      </div>
      <SubmitButton variant="outline" pendingLabel="Saving…" className="mb-5">
        Save time zone
      </SubmitButton>
      {state.message ? <FormMessage message={state.message} /> : null}
    </form>
  );
}
