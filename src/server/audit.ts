// Audit writer (spec §3.5). Everything stored is redacted and size-bounded.
import { auditEvents } from "./db/schema";
import type { DbOrTx } from "./db/client";
import { redact, redactString } from "./redact";

export type AuditActor =
  | { type: "user"; userId: string }
  | { type: "system" }
  | { type: "provider" };

export type AuditInput = {
  actor: AuditActor;
  action: string;
  subjectType: string;
  subjectId?: string | null;
  clientId?: string | null;
  websiteId?: string | null;
  projectId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  requestId?: string | null;
};

const ACTION_FORMAT = /^[a-z_]+(\.[a-z_]+)+$/;
// The DB checks octet_length(jsonb::text) <= 16 KiB; jsonb's text form adds
// whitespace, so keep a margin against JSON.stringify's compact length.
const JSON_BUDGET_BYTES = 12 * 1024;
const SUMMARY_MAX = 500;

export function boundJson(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const redacted = redact(value);
  const bytes = Buffer.byteLength(JSON.stringify(redacted) ?? "null", "utf8");
  return bytes <= JSON_BUDGET_BYTES ? redacted : { _truncated: true, bytes };
}

function boundSummary(summary: string): string {
  const clean = redactString(summary.trim()) || "(no summary)";
  return clean.length <= SUMMARY_MAX ? clean : `${clean.slice(0, SUMMARY_MAX - 1)}…`;
}

export async function writeAudit(db: DbOrTx, input: AuditInput): Promise<string> {
  if (!ACTION_FORMAT.test(input.action)) {
    throw new Error(`Invalid audit action "${input.action}"`);
  }
  const [row] = await db
    .insert(auditEvents)
    .values({
      actorType: input.actor.type,
      actorUserId: input.actor.type === "user" ? input.actor.userId : null,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      clientId: input.clientId ?? null,
      websiteId: input.websiteId ?? null,
      projectId: input.projectId ?? null,
      summary: boundSummary(input.summary),
      before: boundJson(input.before),
      after: boundJson(input.after),
      metadata: boundJson(input.metadata),
      requestId: input.requestId ?? null,
    })
    .returning({ id: auditEvents.id });
  if (!row) throw new Error("audit insert returned no row");
  return row.id;
}
