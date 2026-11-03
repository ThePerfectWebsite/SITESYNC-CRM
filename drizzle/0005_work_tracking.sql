ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_id_project_id_key" UNIQUE("id","project_id");--> statement-breakpoint
CREATE TABLE "changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"requested_by_contact_id" uuid,
	"task_id" uuid,
	"shipped_in_deployment_id" uuid,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "changes_title_length" CHECK (length("changes"."title") BETWEEN 1 AND 300),
	CONSTRAINT "changes_description_length" CHECK (length("changes"."description") <= 20000),
	CONSTRAINT "changes_category_check" CHECK ("changes"."category" IN ('feature','fix','content','design','technical','scope','deployment','other')),
	CONSTRAINT "changes_status_check" CHECK ("changes"."status" IN ('proposed','accepted','in_progress','done','rejected'))
);
--> statement-breakpoint
CREATE TABLE "readiness_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"blocker_key" text NOT NULL,
	"blocker_type" text NOT NULL,
	"blocker_snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"waived_by" uuid NOT NULL,
	"commit_sha" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"audit_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "readiness_waivers_blocker_key_length" CHECK (length("readiness_waivers"."blocker_key") BETWEEN 1 AND 200),
	CONSTRAINT "readiness_waivers_blocker_type_check" CHECK ("readiness_waivers"."blocker_type" IN ('critical_task','checklist_item','failing_check','pr_open','preview_not_ready','other')),
	CONSTRAINT "readiness_waivers_snapshot_size" CHECK (octet_length("readiness_waivers"."blocker_snapshot"::text) <= 4096),
	CONSTRAINT "readiness_waivers_reason_length" CHECK (length("readiness_waivers"."reason") BETWEEN 3 AND 2000),
	CONSTRAINT "readiness_waivers_commit_sha_format" CHECK ("readiness_waivers"."commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "readiness_waivers_revoked_check" CHECK (("readiness_waivers"."revoked_at" IS NULL) = ("readiness_waivers"."revoked_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "release_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"position" integer NOT NULL,
	"checked_at" timestamp with time zone,
	"checked_by" uuid,
	"note" text,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_checklist_items_key_format" CHECK ("release_checklist_items"."key" ~ '^[a-z][a-z0-9_]{0,49}$'),
	CONSTRAINT "release_checklist_items_label_length" CHECK (length("release_checklist_items"."label") BETWEEN 1 AND 300),
	CONSTRAINT "release_checklist_items_checked_check" CHECK (("release_checklist_items"."checked_at" IS NULL) = ("release_checklist_items"."checked_by" IS NULL)),
	CONSTRAINT "release_checklist_items_note_length" CHECK (length("release_checklist_items"."note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"due_date" date,
	"reference_url" text,
	"project_stage_id" uuid,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "tasks_title_length" CHECK (length("tasks"."title") BETWEEN 1 AND 300),
	CONSTRAINT "tasks_description_length" CHECK (length("tasks"."description") <= 20000),
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('open','in_progress','blocked','done','cancelled')),
	CONSTRAINT "tasks_priority_check" CHECK ("tasks"."priority" IN ('low','normal','high','critical')),
	CONSTRAINT "tasks_reference_url_format" CHECK (length("tasks"."reference_url") <= 2048 AND "tasks"."reference_url" ~ '^https?://'),
	CONSTRAINT "tasks_completed_check" CHECK (("tasks"."status" = 'done') = ("tasks"."completed_at" IS NOT NULL)),
	CONSTRAINT "tasks_completed_by_check" CHECK (("tasks"."completed_at" IS NULL) = ("tasks"."completed_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_requested_by_contact_id_contacts_id_fk" FOREIGN KEY ("requested_by_contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_task_same_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "public"."tasks"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_waivers" ADD CONSTRAINT "readiness_waivers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_waivers" ADD CONSTRAINT "readiness_waivers_waived_by_users_id_fk" FOREIGN KEY ("waived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_waivers" ADD CONSTRAINT "readiness_waivers_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_waivers" ADD CONSTRAINT "readiness_waivers_audit_event_id_audit_events_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."audit_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_checklist_items" ADD CONSTRAINT "release_checklist_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_checklist_items" ADD CONSTRAINT "release_checklist_items_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_checklist_items" ADD CONSTRAINT "release_checklist_items_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_stage_same_project_fk" FOREIGN KEY ("project_stage_id","project_id") REFERENCES "public"."project_stages"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "changes_project_created_idx" ON "changes" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "changes_project_category_idx" ON "changes" USING btree ("project_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "readiness_waivers_active_key" ON "readiness_waivers" USING btree ("project_id","blocker_key") WHERE "readiness_waivers"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "release_checklist_items_key_key" ON "release_checklist_items" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "tasks_project_status_idx" ON "tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "tasks_open_due_idx" ON "tasks" USING btree ("due_date") WHERE "tasks"."status" NOT IN ('done','cancelled') AND "tasks"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_open_critical_idx" ON "tasks" USING btree ("priority") WHERE "tasks"."priority" = 'critical' AND "tasks"."status" NOT IN ('done','cancelled');--> statement-breakpoint
CREATE INDEX "tasks_title_trgm_idx" ON "tasks" USING gin ("title" gin_trgm_ops);
