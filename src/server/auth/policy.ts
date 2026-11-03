// Session lifetimes (spec OQ-5: idle 2 h, absolute 12 h), overridable via app_settings.
import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../db/client";
import { appSettings } from "../db/schema";

export type SessionPolicy = { idleMinutes: number; absoluteHours: number };

export const DEFAULT_SESSION_POLICY: SessionPolicy = { idleMinutes: 120, absoluteHours: 12 };

const idleMinutes = z.number().int().min(5).max(24 * 60);
const absoluteHours = z.number().int().min(1).max(7 * 24);

export async function getSessionPolicy(db: DbOrTx): Promise<SessionPolicy> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, ["session.idle_minutes", "session.absolute_hours"]));
  const policy = { ...DEFAULT_SESSION_POLICY };
  for (const row of rows) {
    if (row.key === "session.idle_minutes") {
      const parsed = idleMinutes.safeParse(row.value);
      if (parsed.success) policy.idleMinutes = parsed.data;
    } else {
      const parsed = absoluteHours.safeParse(row.value);
      if (parsed.success) policy.absoluteHours = parsed.data;
    }
  }
  return policy;
}
