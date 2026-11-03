import "server-only";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { isUuid } from "@/lib/ids";
import { requireSession } from "../auth/next";
import type { Actor } from "../records/actor";
import { DomainError } from "../records/errors";
import { requestMeta } from "./request";

/**
 * First call in every record Server Action: the signed-in operator, or a
 * redirect. Bound record ids come back from the browser, so anything that
 * isn't a UUID is a 404 rather than a database error.
 */
export async function requireActor(...boundIds: string[]): Promise<Actor> {
  const session = await requireSession();
  if (!boundIds.every(isUuid)) notFound();
  const { requestId } = await requestMeta();
  return { userId: session.user.id, requestId };
}

/** Reads the named string fields from a form submission (missing fields become ""). */
export function formValues<K extends string>(formData: FormData, keys: readonly K[]): Record<K, string> {
  const values = {} as Record<K, string>;
  for (const key of keys) {
    const value = formData.get(key);
    values[key] = typeof value === "string" ? value : "";
  }
  return values;
}

/**
 * Runs a service call for a form. DomainErrors become form state (with the
 * submitted values echoed back); anything else is a bug and propagates.
 */
export async function runForm<T>(
  values: Record<string, string>,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; state: FormState }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    const hasFields = Object.keys(error.fieldErrors).length > 0;
    return {
      ok: false,
      state: {
        key: randomUUID(),
        message: hasFields && error.code === "invalid" ? undefined : error.message,
        fieldErrors: error.fieldErrors,
        values,
      },
    };
  }
}
