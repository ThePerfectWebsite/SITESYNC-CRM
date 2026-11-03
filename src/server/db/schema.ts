// Drizzle schema — mirrors spec §3. Extensions, shared functions, triggers,
// roles and grants live in hand-written migrations (see drizzle/*.sql).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const tsNull = (name: string) => timestamp(name, { withTimezone: true });

// §3.1
export const users = pgTable(
  "users",
  {
    id: id(),
    email: citext("email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role").notNull().default("admin"),
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordParams: jsonb("password_params").$type<ScryptParams>().notNull(),
    passwordChangedAt: tsNull("password_changed_at").notNull(),
    lastLoginAt: tsNull("last_login_at"),
    disabledAt: tsNull("disabled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    check("users_email_length", sql`length(${t.email}) <= 254`),
    check("users_display_name_length", sql`length(${t.displayName}) BETWEEN 1 AND 200`),
    check("users_role_check", sql`${t.role} IN ('admin')`),
    check("users_password_params_size", sql`octet_length(${t.passwordParams}::text) <= 256`),
  ],
);

export type ScryptParams = { N: number; r: number; p: number; keylen: number };

// §3.2
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenHash: bytea("token_hash").notNull(),
    expiresAt: tsNull("expires_at").notNull(),
    idleExpiresAt: tsNull("idle_expires_at").notNull(),
    revokedAt: tsNull("revoked_at"),
    userAgent: text("user_agent"),
    ip: inet("ip"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_active_idx").on(t.userId).where(sql`${t.revokedAt} IS NULL`),
    check("sessions_user_agent_length", sql`length(${t.userAgent}) <= 512`),
  ],
);

// §3.3 (added)
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: id(),
    emailHash: bytea("email_hash").notNull(),
    ip: inet("ip"),
    succeeded: boolean("succeeded").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("login_attempts_email_idx").on(t.emailHash, t.createdAt.desc()),
    index("login_attempts_ip_idx").on(t.ip, t.createdAt.desc()),
  ],
);

// §3.4
export const appSettings = pgTable(
  "app_settings",
  {
    id: id(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("app_settings_key_key").on(t.key),
    check("app_settings_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_.]{0,99}$'`),
    check("app_settings_value_size", sql`octet_length(${t.value}::text) <= 16384`),
  ],
);

// §3.5 — append-only (decision 0002): no updated_at.
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    createdAt: createdAt(),
    actorType: text("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references((): AnyPgColumn => users.id, {
      onDelete: "restrict",
    }),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    clientId: uuid("client_id"),
    websiteId: uuid("website_id"),
    projectId: uuid("project_id"),
    summary: text("summary").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    metadata: jsonb("metadata"),
    requestId: uuid("request_id"),
  },
  (t) => [
    check("audit_events_actor_type_check", sql`${t.actorType} IN ('user','system','provider')`),
    check(
      "audit_events_actor_user_check",
      sql`${t.actorType} <> 'user' OR ${t.actorUserId} IS NOT NULL`,
    ),
    check("audit_events_action_format", sql`${t.action} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    check("audit_events_subject_type_length", sql`length(${t.subjectType}) BETWEEN 1 AND 100`),
    check("audit_events_summary_length", sql`length(${t.summary}) BETWEEN 1 AND 500`),
    check("audit_events_before_size", sql`octet_length(${t.before}::text) <= 16384`),
    check("audit_events_after_size", sql`octet_length(${t.after}::text) <= 16384`),
    check("audit_events_metadata_size", sql`octet_length(${t.metadata}::text) <= 16384`),
    index("audit_events_created_idx").on(t.createdAt.desc()),
    index("audit_events_subject_idx").on(t.subjectType, t.subjectId, t.createdAt.desc()),
    index("audit_events_project_idx").on(t.projectId, t.createdAt.desc()),
    index("audit_events_client_idx").on(t.clientId, t.createdAt.desc()),
    index("audit_events_action_idx").on(t.action),
  ],
);
