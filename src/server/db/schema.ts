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
    // Target of tasks' composite FK: a task's stage belongs to the task's project.
    unique("project_stages_id_project_id_key").on(t.id, t.projectId),
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

// ---------------------------------------------------------------------------
// Phase 2 — work tracking (spec §3.14–§3.17)

export const TASK_STATUSES = ["open", "in_progress", "blocked", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "critical"] as const;
export const CHANGE_CATEGORIES = [
  "feature",
  "fix",
  "content",
  "design",
  "technical",
  "scope",
  "deployment",
  "other",
] as const;
export const CHANGE_STATUSES = ["proposed", "accepted", "in_progress", "done", "rejected"] as const;
export const BLOCKER_TYPES = [
  "critical_task",
  "checklist_item",
  "failing_check",
  "pr_open",
  "preview_not_ready",
  "other",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];
export type BlockerType = (typeof BLOCKER_TYPES)[number];

// §3.14
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").$type<TaskStatus>().notNull().default("open"),
    priority: text("priority").$type<TaskPriority>().notNull().default("normal"),
    dueDate: date("due_date", { mode: "string" }),
    referenceUrl: text("reference_url"),
    projectStageId: uuid("project_stage_id"),
    completedAt: tsNull("completed_at"),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "restrict" }),
    archivedAt: archivedAt(),
    archivedBy: archivedBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The optional stage must be one of the task's project's stages.
    foreignKey({
      name: "tasks_stage_same_project_fk",
      columns: [t.projectStageId, t.projectId],
      foreignColumns: [projectStages.id, projectStages.projectId],
    }).onDelete("restrict"),
    check("tasks_title_length", sql`length(${t.title}) BETWEEN 1 AND 300`),
    check("tasks_description_length", sql`length(${t.description}) <= 20000`),
    check("tasks_status_check", sql`${t.status} IN (${inList(TASK_STATUSES)})`),
    check("tasks_priority_check", sql`${t.priority} IN (${inList(TASK_PRIORITIES)})`),
    check(
      "tasks_reference_url_format",
      sql`length(${t.referenceUrl}) <= 2048 AND ${t.referenceUrl} ~ '^https?://'`,
    ),
    check("tasks_completed_check", sql`(${t.status} = 'done') = (${t.completedAt} IS NOT NULL)`),
    check("tasks_completed_by_check", sql`(${t.completedAt} IS NULL) = (${t.completedBy} IS NULL)`),
    // Target of changes' composite FK: a change's task belongs to the change's project.
    unique("tasks_id_project_id_key").on(t.id, t.projectId),
    index("tasks_project_status_idx").on(t.projectId, t.status),
    index("tasks_open_due_idx")
      .on(t.dueDate)
      .where(sql`${t.status} NOT IN ('done','cancelled') AND ${t.archivedAt} IS NULL`),
    index("tasks_open_critical_idx")
      .on(t.priority)
      .where(sql`${t.priority} = 'critical' AND ${t.status} NOT IN ('done','cancelled')`),
    index("tasks_title_trgm_idx").using("gin", sql`${t.title} gin_trgm_ops`),
  ],
);

// §3.15 — shipped_in_deployment_id gets its FK when deployments exists (decision 0007).
export const changes = pgTable(
  "changes",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").$type<ChangeCategory>().notNull(),
    status: text("status").$type<ChangeStatus>().notNull().default("proposed"),
    requestedByContactId: uuid("requested_by_contact_id").references(() => contacts.id, {
      onDelete: "restrict",
    }),
    taskId: uuid("task_id"),
    shippedInDeploymentId: uuid("shipped_in_deployment_id"),
    archivedAt: archivedAt(),
    archivedBy: archivedBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The optional linked task must belong to the change's project.
    foreignKey({
      name: "changes_task_same_project_fk",
      columns: [t.taskId, t.projectId],
      foreignColumns: [tasks.id, tasks.projectId],
    }).onDelete("restrict"),
    check("changes_title_length", sql`length(${t.title}) BETWEEN 1 AND 300`),
    check("changes_description_length", sql`length(${t.description}) <= 20000`),
    check("changes_category_check", sql`${t.category} IN (${inList(CHANGE_CATEGORIES)})`),
    check("changes_status_check", sql`${t.status} IN (${inList(CHANGE_STATUSES)})`),
    index("changes_project_created_idx").on(t.projectId, t.createdAt.desc()),
    index("changes_project_category_idx").on(t.projectId, t.category),
  ],
);

// §3.16
export const releaseChecklistItems = pgTable(
  "release_checklist_items",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    required: boolean("required").notNull().default(true),
    position: integer("position").notNull(),
    checkedAt: tsNull("checked_at"),
    checkedBy: uuid("checked_by").references(() => users.id, { onDelete: "restrict" }),
    note: text("note"),
    archivedAt: archivedAt(),
    archivedBy: archivedBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("release_checklist_items_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_]{0,49}$'`),
    check("release_checklist_items_label_length", sql`length(${t.label}) BETWEEN 1 AND 300`),
    check(
      "release_checklist_items_checked_check",
      sql`(${t.checkedAt} IS NULL) = (${t.checkedBy} IS NULL)`,
    ),
    check("release_checklist_items_note_length", sql`length(${t.note}) <= 2000`),
    uniqueIndex("release_checklist_items_key_key").on(t.projectId, t.key),
  ],
);

// §3.17 — revoked, never deleted.
export const readinessWaivers = pgTable(
  "readiness_waivers",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    blockerKey: text("blocker_key").notNull(),
    blockerType: text("blocker_type").$type<BlockerType>().notNull(),
    blockerSnapshot: jsonb("blocker_snapshot").notNull(),
    reason: text("reason").notNull(),
    waivedBy: uuid("waived_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    commitSha: text("commit_sha"),
    revokedAt: tsNull("revoked_at"),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "restrict" }),
    auditEventId: uuid("audit_event_id")
      .notNull()
      .references(() => auditEvents.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("readiness_waivers_blocker_key_length", sql`length(${t.blockerKey}) BETWEEN 1 AND 200`),
    check(
      "readiness_waivers_blocker_type_check",
      sql`${t.blockerType} IN (${inList(BLOCKER_TYPES)})`,
    ),
    check("readiness_waivers_snapshot_size", sql`octet_length(${t.blockerSnapshot}::text) <= 4096`),
    check("readiness_waivers_reason_length", sql`length(${t.reason}) BETWEEN 3 AND 2000`),
    check("readiness_waivers_commit_sha_format", sql`${t.commitSha} ~ '^[0-9a-f]{40}$'`),
    check(
      "readiness_waivers_revoked_check",
      sql`(${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL)`,
    ),
    uniqueIndex("readiness_waivers_active_key")
      .on(t.projectId, t.blockerKey)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Phase 3a — GitHub read sync (spec §3.18–§3.20, §3.24)

export const PROVIDERS = ["github", "netlify", "vercel"] as const;
export const INTEGRATION_HEALTH = ["unconfigured", "ok", "degraded", "error", "disabled"] as const;
export const REPOSITORY_EVENT_TYPES = [
  "commit",
  "pull_request",
  "check_run",
  "check_suite",
  "push",
  "branch_protection",
] as const;
export const WEBHOOK_STATUSES = [
  "received",
  "processing",
  "processed",
  "ignored",
  "failed",
  "dead_lettered",
] as const;

export type Provider = (typeof PROVIDERS)[number];
export type IntegrationHealth = (typeof INTEGRATION_HEALTH)[number];
export type RepositoryEventType = (typeof REPOSITORY_EVENT_TYPES)[number];
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

const ENV_VAR_NAME = sql.raw(`'^[A-Z][A-Z0-9_]{0,63}$'`);

// §3.18 — tokens are never stored: only the *name* of the env var holding one.
export const integrations = pgTable(
  "integrations",
  {
    id: id(),
    provider: text("provider").$type<Provider>().notNull(),
    name: text("name").notNull(),
    tokenEnvVar: text("token_env_var").notNull(),
    accountRef: text("account_ref"),
    webhookEnabled: boolean("webhook_enabled").notNull().default(false),
    webhookSecretEnvVar: text("webhook_secret_env_var"),
    health: text("health").$type<IntegrationHealth>().notNull().default("unconfigured"),
    healthDetail: text("health_detail"),
    lastTestedAt: tsNull("last_tested_at"),
    lastSyncStartedAt: tsNull("last_sync_started_at"),
    lastSyncSucceededAt: tsNull("last_sync_succeeded_at"),
    lastErrorAt: tsNull("last_error_at"),
    lastError: text("last_error"),
    rateLimitRemaining: integer("rate_limit_remaining"),
    rateLimitLimit: integer("rate_limit_limit"),
    rateLimitResetAt: tsNull("rate_limit_reset_at"),
    pollEnabled: boolean("poll_enabled").notNull().default(true),
    archivedAt: archivedAt(),
    archivedBy: archivedBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("integrations_provider_check", sql`${t.provider} IN (${inList(PROVIDERS)})`),
    check("integrations_name_length", sql`length(${t.name}) BETWEEN 1 AND 100`),
    check("integrations_token_env_var_format", sql`${t.tokenEnvVar} ~ ${ENV_VAR_NAME}`),
    check("integrations_account_ref_length", sql`length(${t.accountRef}) <= 200`),
    check("integrations_webhook_secret_env_var_format", sql`${t.webhookSecretEnvVar} ~ ${ENV_VAR_NAME}`),
    check(
      "integrations_webhook_secret_required",
      sql`NOT ${t.webhookEnabled} OR ${t.webhookSecretEnvVar} IS NOT NULL`,
    ),
    check("integrations_health_check", sql`${t.health} IN (${inList(INTEGRATION_HEALTH)})`),
    check("integrations_health_detail_length", sql`length(${t.healthDetail}) <= 1000`),
    check("integrations_last_error_length", sql`length(${t.lastError}) <= 2000`),
    uniqueIndex("integrations_name_live_key")
      .on(t.provider, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
  ],
);

// §3.19
export const repositoryLinks = pgTable(
  "repository_links",
  {
    id: id(),
    websiteId: uuid("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "restrict" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "restrict" }),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    providerRepoId: text("provider_repo_id"),
    productionBranch: text("production_branch").notNull(),
    isPrimary: boolean("is_primary").notNull().default(true),
    lastSyncedAt: tsNull("last_synced_at"),
    syncCursor: jsonb("sync_cursor").$type<RepositorySyncCursor>(),
    archivedAt: archivedAt(),
    archivedBy: archivedBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("repository_links_owner_format", sql`${t.owner} ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'`),
    check("repository_links_repo_format", sql`${t.repo} ~ '^[A-Za-z0-9._-]{1,100}$'`),
    check(
      "repository_links_branch_format",
      sql`length(${t.productionBranch}) BETWEEN 1 AND 255 AND ${t.productionBranch} !~ '(\\.\\.|[[:cntrl:] ~^:?*\\[\\\\]|@\\{|^/|/$|\\.lock$|^-)'`,
    ),
    check("repository_links_sync_cursor_size", sql`octet_length(${t.syncCursor}::text) <= 4096`),
    uniqueIndex("repository_links_one_primary_key")
      .on(t.websiteId)
      .where(sql`${t.isPrimary} AND ${t.archivedAt} IS NULL`),
    uniqueIndex("repository_links_repo_live_key")
      .on(t.websiteId, sql`lower(${t.owner})`, sql`lower(${t.repo})`)
      .where(sql`${t.archivedAt} IS NULL`),
    index("repository_links_integration_idx").on(t.integrationId),
  ],
);

export type RepositorySyncCursor = {
  /** Production branch head SHA as of the last sync (or push webhook). */
  headSha?: string;
  headCheckedAt?: string;
};

// §3.20 — normalized, redacted snapshots; never source code.
export const repositoryEvents = pgTable(
  "repository_events",
  {
    id: id(),
    repositoryLinkId: uuid("repository_link_id")
      .notNull()
      .references(() => repositoryLinks.id, { onDelete: "restrict" }),
    eventType: text("event_type").$type<RepositoryEventType>().notNull(),
    providerEventId: text("provider_event_id").notNull(),
    source: text("source").$type<"poll" | "webhook">().notNull(),
    commitSha: text("commit_sha"),
    ref: text("ref"),
    title: text("title"),
    authorLogin: text("author_login"),
    state: text("state"),
    conclusion: text("conclusion"),
    htmlUrl: text("html_url"),
    occurredAt: tsNull("occurred_at").notNull(),
    providerUpdatedAt: tsNull("provider_updated_at"),
    snapshot: jsonb("snapshot").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("repository_events_type_check", sql`${t.eventType} IN (${inList(REPOSITORY_EVENT_TYPES)})`),
    check("repository_events_provider_event_id_length", sql`length(${t.providerEventId}) BETWEEN 1 AND 200`),
    check("repository_events_source_check", sql`${t.source} IN ('poll','webhook')`),
    check("repository_events_commit_sha_format", sql`${t.commitSha} ~ '^[0-9a-f]{40}$'`),
    check("repository_events_ref_length", sql`length(${t.ref}) <= 255`),
    check("repository_events_title_length", sql`length(${t.title}) <= 300`),
    check("repository_events_author_length", sql`length(${t.authorLogin}) <= 100`),
    check("repository_events_state_length", sql`length(${t.state}) <= 30`),
    check("repository_events_conclusion_length", sql`length(${t.conclusion}) <= 30`),
    check(
      "repository_events_html_url_format",
      sql`length(${t.htmlUrl}) <= 2048 AND ${t.htmlUrl} ~ '^https://'`,
    ),
    check("repository_events_snapshot_size", sql`octet_length(${t.snapshot}::text) <= 65536`),
    uniqueIndex("repository_events_identity_key").on(t.repositoryLinkId, t.eventType, t.providerEventId),
    index("repository_events_link_type_idx").on(t.repositoryLinkId, t.eventType, t.occurredAt.desc()),
    index("repository_events_commit_idx").on(t.commitSha),
  ],
);

// §3.24 — bad signatures are rejected before anything is stored.
export const webhookInbox = pgTable(
  "webhook_inbox",
  {
    id: id(),
    provider: text("provider").$type<Provider>().notNull(),
    integrationId: uuid("integration_id").references(() => integrations.id, { onDelete: "restrict" }),
    deliveryId: text("delivery_id").notNull(),
    eventType: text("event_type").notNull(),
    signatureValid: boolean("signature_valid").notNull(),
    body: jsonb("body").notNull(),
    bodySha256: bytea("body_sha256").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").$type<WebhookStatus>().notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tsNull("next_attempt_at"),
    lastError: text("last_error"),
    processedAt: tsNull("processed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("webhook_inbox_provider_check", sql`${t.provider} IN (${inList(PROVIDERS)})`),
    check("webhook_inbox_delivery_id_length", sql`length(${t.deliveryId}) BETWEEN 1 AND 200`),
    check("webhook_inbox_event_type_length", sql`length(${t.eventType}) BETWEEN 1 AND 100`),
    check("webhook_inbox_body_size", sql`octet_length(${t.body}::text) <= 262144`),
    check("webhook_inbox_status_check", sql`${t.status} IN (${inList(WEBHOOK_STATUSES)})`),
    check("webhook_inbox_attempts_check", sql`${t.attempts} >= 0`),
    check("webhook_inbox_last_error_length", sql`length(${t.lastError}) <= 2000`),
    uniqueIndex("webhook_inbox_delivery_key").on(t.provider, t.deliveryId),
    index("webhook_inbox_status_idx").on(t.status, t.nextAttemptAt),
  ],
);
