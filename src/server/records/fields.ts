// Shared Zod field helpers for record forms. Form inputs arrive as strings;
// blank optional fields become null.
import { z } from "zod";

export const uuid = (message = "Choose an item.") => z.string().trim().pipe(z.uuid({ message }));

export const requiredText = (label: string, max: number) =>
  z
    .string({ message: `Enter ${label}.` })
    .trim()
    .min(1, `Enter ${label}.`)
    .max(max, `Keep it to ${max.toLocaleString("en-GB")} characters.`);

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it to ${max.toLocaleString("en-GB")} characters.`)
    .nullish()
    .transform((value) => (value ? value : null));

export const reason = z
  .string({ message: "Give a reason (at least 3 characters)." })
  .trim()
  .min(3, "Give a reason (at least 3 characters).")
  .max(2000, "Keep the reason to 2,000 characters.");

const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A bare hostname, stored lower-case (spec §2.1). */
export const optionalDomain = z
  .string()
  .trim()
  .toLowerCase()
  .nullish()
  .transform((value) => (value ? value.replace(/\.$/, "") : null))
  .refine((value) => value === null || (value.length <= 253 && HOSTNAME.test(value)), {
    message: "Enter a domain like example.com, without https:// or a path.",
  });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const optionalDate = z
  .string()
  .trim()
  .nullish()
  .transform((value) => (value ? value : null))
  .refine(
    (value) =>
      value === null ||
      (ISO_DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)),
    { message: "Enter a valid date." },
  );

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
}

/** Escapes LIKE/ILIKE wildcards in user search text. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Today's date in the server's local time zone, as YYYY-MM-DD. */
export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
