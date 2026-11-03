// Read-side of audit_events for activity feeds (dashboard, client, website, project).
import { and, desc, eq, notLike, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { auditEvents, users } from "../db/schema";

export type ActivityScope = {
  clientId?: string;
  websiteId?: string;
  projectId?: string;
  /** Leave out sign-in/sign-out events (the dashboard feed is about the work). */
  excludeAuth?: boolean;
};

export async function listActivity(db: DbOrTx, scope: ActivityScope = {}, limit = 50) {
  const conditions: SQL[] = [];
  if (scope.projectId) conditions.push(eq(auditEvents.projectId, scope.projectId));
  else if (scope.websiteId) conditions.push(eq(auditEvents.websiteId, scope.websiteId));
  else if (scope.clientId) conditions.push(eq(auditEvents.clientId, scope.clientId));
  if (scope.excludeAuth) conditions.push(notLike(auditEvents.action, "auth.%"));
  return db
    .select({
      id: auditEvents.id,
      createdAt: auditEvents.createdAt,
      action: auditEvents.action,
      summary: auditEvents.summary,
      actorType: auditEvents.actorType,
      actorName: users.displayName,
      metadata: auditEvents.metadata,
      projectId: auditEvents.projectId,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(and(...conditions))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
}
