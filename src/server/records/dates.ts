// Calendar dates for due dates and deadlines. "Today" is the operator's
// calendar day in the app's time zone, not the server's UTC day, so a task due
// today never shows as overdue just because UTC has already rolled over.
import { eq } from "drizzle-orm";
import { writeAudit } from "../audit";
import type { Db, DbOrTx } from "../db/client";
import { appSettings } from "../db/schema";
import { auditActor, type Actor } from "./actor";
import { invalidField } from "./errors";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date (YYYY-MM-DD) at `now` in `timeZone`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Adds whole days to a YYYY-MM-DD date (calendar arithmetic, no time zone involved). */
export function addDays(isoDate: string, days: number): string {
  if (!ISO_DATE.test(isoDate)) throw new Error(`not an ISO date: ${isoDate}`);
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A due date is overdue once its day has fully passed: due today is not overdue. */
export function isOverdue(dueDate: string | null, today: string): boolean {
  return dueDate !== null && dueDate < today;
}

export const TIME_ZONE_SETTING = "app.time_zone";

export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The app's time zone: the `app.time_zone` setting if valid, else the server's. */
export async function getAppTimeZone(db: DbOrTx): Promise<string> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, TIME_ZONE_SETTING));
  return isValidTimeZone(row?.value) ? row.value : serverTimeZone();
}

export async function appToday(db: DbOrTx, now: Date = new Date()): Promise<string> {
  return todayIn(await getAppTimeZone(db), now);
}

/** Sets the app's time zone (used for "today": overdue tasks and deadlines). */
export async function saveAppTimeZone(
  db: Db,
  actor: Actor,
  input: { timeZone?: unknown },
): Promise<void> {
  const raw = typeof input.timeZone === "string" ? input.timeZone.trim() : "";
  if (!isValidTimeZone(raw)) {
    throw invalidField("timeZone", "Enter an IANA time zone such as Europe/London.");
  }
  // Store the canonical spelling ("europe/london" → "Europe/London").
  const timeZone = new Intl.DateTimeFormat("en-GB", { timeZone: raw }).resolvedOptions().timeZone;
  await db.transaction(async (tx) => {
    const before = await getAppTimeZone(tx);
    await tx
      .insert(appSettings)
      .values({ key: TIME_ZONE_SETTING, value: timeZone, updatedBy: actor.userId })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: timeZone, updatedBy: actor.userId } });
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "settings.time_zone_updated",
      subjectType: "app_setting",
      summary: `Time zone set to ${timeZone}`,
      before: { timeZone: before },
      after: { timeZone },
      requestId: actor.requestId,
    });
  });
}
