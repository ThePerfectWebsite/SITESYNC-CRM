// Drizzle schema — mirrors spec §3. Extensions, shared functions, triggers,
// roles and grants live in hand-written migrations (see drizzle/*.sql).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
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

// ---------------------------------------------------------------------------
// Phase 1 — core records (spec §3.6–§3.13)

const archivedAt = () => tsNull("archived_at");
const archivedBy = () => uuid("archived_by").references(() => users.id, { onDelete: "restrict" });
const live = (archived: AnyPgColumn) => sql`${archived} IS NULL`;
const HOSTNAME_RE =
  "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$";

export const CLIENT_STATUSES = ["prospect", "active", "paused", "former"] as const;
export const WEBSITE_STATUSES = ["planned", "in_development", "live", "retired"] as const;
export const STEP_KINDS = ["linear", "on_hold", "archived"] as const;
export const STEP_ROLES = ["ready_to_deploy", "live"] as const;
export const STAGE_STATUSES = ["upcoming", "current", "completed", "skipped"] as const;
export const STAGE_TRANSITIONS = [
  "initial",
  "advance",
  "skip_forward",
  "move_back",
  "hold",
  "resume",
  "archive",
  "restore",
  "go_live",
] as const;

export type ClientStatus = (typeof CLIENT_STATUSES)[number];
export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];
export type StepKind = (typeof STEP_KINDS)[number];
export type StepRole = (typeof STEP_ROLES)[number];
export type StageStatus = (typeof STAGE_STATUSES)[number];
export type StageTransition = (typeof STAGE_TRANSITIONS)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

// §3.6
export const clients = pgTable(
  "clients",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status").$type<ClientStatus>().notNull().default("active"),
    notes: text("notes"),
    archivedAt: archivedAt(),
    archivedBy: archivedBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("clients_name_length", sql`length(${t.name}) BETWEEN 1 AND 200`),
    check(
      "clients_slug_format",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(${t.slug}) <= 100`,
    ),
    check("clients_status_check", sql`${t.status} IN (${inList(CLIENT_STATUSES)})`),
    check("clients_notes_length", sql`length(${t.notes}) <= 20000`),
    uniqueIndex("clients_slug_live_key").on(t.slug).where(live(t.archivedAt)),
    index("clients_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
  ],
);

// §3.7
export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    email: citext("email"),
    phone: text("phone"),
    roleTitle: text("role_title"),
    isPrimary: boolean("is_primary").notNull().default(false),
    notes: text("notes"),
    archivedAt: archivedAt(),
    archivedBy: archivedBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("contacts_name_length", sql`length(${t.name}) BETWEEN 1 AND 200`),
    check("contacts_email_length", sql`length(${t.email}) <= 254`),
    check("contacts_phone_length", sql`length(${t.phone}) <= 50`),
    check("contacts_role_title_length", sql`length(${t.roleTitle}) <= 200`),
    check("contacts_notes_length", sql`length(${t.notes}) <= 5000`),
    index("contacts_client_idx").on(t.clientId),
    uniqueIndex("contacts_one_primary_key")
      .on(t.clientId)
      .where(sql`${t.isPrimary} AND ${t.archivedAt} IS NULL`),
  ],
);

// §3.8
export const websites = pgTable(
  "websites",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    primaryDomain: text("primary_domain"),
    status: text("status").$type<WebsiteStatus>().notNull().default("planned"),
    notes: text("notes"),
    archivedAt: archivedAt(),
    archivedBy: archivedBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("websites_name_length", sql`length(${t.name}) BETWEEN 1 AND 200`),
    check(
      "websites_primary_domain_format",
      sql`length(${t.primaryDomain}) <= 253 AND ${t.primaryDomain} ~ ${sql.raw(`'${HOSTNAME_RE}'`)}`,
    ),
    check("websites_status_check", sql`${t.status} IN (${inList(WEBSITE_STATUSES)})`),
    check("websites_notes_length", sql`length(${t.notes}) <= 20000`),
    // Decision 0001: target of the composite FK from projects.
    unique("websites_id_client_id_key").on(t.id, t.clientId),
    uniqueIndex("websites_primary_domain_live_key").on(t.primaryDomain).where(live(t.archivedAt)),
    index("websites_client_idx").on(t.clientId),
    index("websites_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
  ],
);

// §3.9
export const stageTemplates = pgTable(
  "stage_templates",
  {
    id: id(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    description: text("description"),
    archivedAt: archivedAt(),
    archivedBy: archivedBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("stage_templates_name_length", sql`length(${t.name}) BETWEEN 1 AND 200`),
    check("stage_templates_description_length", sql`length(${t.description}) <= 2000`),
    uniqueIndex("stage_templates_name_live_key").on(t.name).where(live(t.archivedAt)),
    uniqueIndex("stage_templates_one_default_key")
      .on(t.isDefault)
      .where(sql`${t.isDefault} AND ${t.archivedAt} IS NULL`),
  ],
);

// §3.10 — the deferrable (template, position) unique constraint and the
// template-shape constraint trigger are in the hand-written migration.
export const stageTemplateSteps = pgTable(
  "stage_template_steps",
  {
    id: id(),
    stageTemplateId: uuid("stage_template_id")
      .notNull()
      .references(() => stageTemplates.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").$type<StepKind>().notNull().default("linear"),
    role: text("role").$type<StepRole>(),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("stage_template_steps_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_]{0,49}$'`),
    check("stage_template_steps_name_length", sql`length(${t.name}) BETWEEN 1 AND 100`),
    check("stage_template_steps_position_check", sql`${t.position} >= 0`),
    check("stage_template_steps_kind_check", sql`${t.kind} IN (${inList(STEP_KINDS)})`),
    check(
      "stage_template_steps_role_check",
      sql`${t.role} IS NULL OR (${t.role} IN (${inList(STEP_ROLES)}) AND ${t.kind} = 'linear')`,
    ),
    check("stage_template_steps_description_length", sql`length(${t.description}) <= 2000`),
    uniqueIndex("stage_template_steps_key_key").on(t.stageTemplateId, t.key),
    uniqueIndex("stage_template_steps_role_key")
      .on(t.stageTemplateId, t.role)
      .where(sql`${t.role} IS NOT NULL`),
  ],
);

// §3.11
export const projects = pgTable(
  "projects",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    websiteId: uuid("website_id").notNull(),
    stageTemplateId: uuid("stage_template_id")
      .notNull()
      .references(() => stageTemplates.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    code: text("code"),
    description: text("description"),
    startDate: date("start_date", { mode: "string" }),
    targetLaunchDate: date("target_launch_date", { mode: "string" }),
    heldFromProjectStageId: uuid("held_from_project_stage_id").references(
      (): AnyPgColumn => projectStages.id,
      { onDelete: "restrict" },
    ),
    archivedAt: archivedAt(),
    archivedBy: archivedBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Decision 0001: the project's website must belong to the project's client.
    foreignKey({
      name: "projects_website_same_client_fk",
      columns: [t.websiteId, t.clientId],
      foreignColumns: [websites.id, websites.clientId],
    }).onDelete("restrict"),
    check("projects_name_length", sql`length(${t.name}) BETWEEN 1 AND 200`),
    check("projects_code_length", sql`length(${t.code}) BETWEEN 1 AND 30`),
    check("projects_description_length", sql`length(${t.description}) <= 20000`),
    check(
      "projects_dates_order",
      sql`${t.targetLaunchDate} IS NULL OR ${t.startDate} IS NULL OR ${t.targetLaunchDate} >= ${t.startDate}`,
    ),
    uniqueIndex("projects_code_live_key").on(t.code).where(live(t.archivedAt)),
    index("projects_client_idx").on(t.clientId),
    index("projects_website_idx").on(t.websiteId),
    index("projects_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
  ],
);

// §3.12 — decision 0003: a per-project copy of the template's steps.
export const projectStages = pgTable(
  "project_stages",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references((): AnyPgColumn => projects.id, { onDelete: "restrict" }),
    templateStepId: uuid("template_step_id").references(() => stageTemplateSteps.id, {
      onDelete: "restrict",
    }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").$type<StepKind>().notNull(),
    role: text("role").$type<StepRole>(),
    status: text("status").$type<StageStatus>().notNull().default("upcoming"),
    enteredAt: tsNull("entered_at"),
    exitedAt: tsNull("exited_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("project_stages_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_]{0,49}$'`),
    check("project_stages_name_length", sql`length(${t.name}) BETWEEN 1 AND 100`),
    check("project_stages_position_check", sql`${t.position} >= 0`),
    check("project_stages_kind_check", sql`${t.kind} IN (${inList(STEP_KINDS)})`),
    check(
      "project_stages_role_check",
      sql`${t.role} IS NULL OR (${t.role} IN (${inList(STEP_ROLES)}) AND ${t.kind} = 'linear')`,
    ),
    check("project_stages_status_check", sql`${t.status} IN (${inList(STAGE_STATUSES)})`),
    uniqueIndex("project_stages_key_key").on(t.projectId, t.key),
    uniqueIndex("project_stages_position_key").on(t.projectId, t.position),
    uniqueIndex("project_stages_one_current_key")
      .on(t.projectId)
      .where(sql`${t.status} = 'current'`),
  ],
);

// §3.13 — append-only (decision 0002). deployment_id has no FK yet: the
// deployments table arrives in Phase 3b, which adds it (decision 0007).
export const stageHistory = pgTable(
  "stage_history",
  {
    id: id(),
    createdAt: createdAt(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    fromProjectStageId: uuid("from_project_stage_id").references(() => projectStages.id, {
      onDelete: "restrict",
    }),
    toProjectStageId: uuid("to_project_stage_id")
      .notNull()
      .references(() => projectStages.id, { onDelete: "restrict" }),
    transition: text("transition").$type<StageTransition>().notNull(),
    actorType: text("actor_type").$type<"user" | "system">().notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason"),
    deploymentId: uuid("deployment_id"),
    auditEventId: uuid("audit_event_id")
      .notNull()
      .references(() => auditEvents.id, { onDelete: "restrict" }),
  },
  (t) => [
    check(
      "stage_history_transition_check",
      sql`${t.transition} IN (${inList(STAGE_TRANSITIONS)})`,
    ),
    check("stage_history_actor_type_check", sql`${t.actorType} IN ('user','system')`),
    check(
      "stage_history_actor_user_check",
      sql`${t.actorType} <> 'user' OR ${t.actorUserId} IS NOT NULL`,
    ),
    check("stage_history_reason_length", sql`length(${t.reason}) BETWEEN 3 AND 2000`),
    check(
      "stage_history_reason_required",
      sql`${t.transition} NOT IN ('skip_forward','move_back','hold','archive','restore') OR ${t.reason} IS NOT NULL`,
    ),
    // Only the system path moves a project to Live, and only with a deployment.
    check(
      "stage_history_go_live_check",
      sql`(${t.transition} = 'go_live') = (${t.actorType} = 'system') AND (${t.transition} <> 'go_live' OR ${t.deploymentId} IS NOT NULL)`,
    ),
    index("stage_history_project_idx").on(t.projectId, t.createdAt.desc()),
  ],
);
