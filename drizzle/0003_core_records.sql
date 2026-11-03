CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_name_length" CHECK (length("clients"."name") BETWEEN 1 AND 200),
	CONSTRAINT "clients_slug_format" CHECK ("clients"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("clients"."slug") <= 100),
	CONSTRAINT "clients_status_check" CHECK ("clients"."status" IN ('prospect','active','paused','former')),
	CONSTRAINT "clients_notes_length" CHECK (length("clients"."notes") <= 20000)
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" "citext",
	"phone" text,
	"role_title" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_name_length" CHECK (length("contacts"."name") BETWEEN 1 AND 200),
	CONSTRAINT "contacts_email_length" CHECK (length("contacts"."email") <= 254),
	CONSTRAINT "contacts_phone_length" CHECK (length("contacts"."phone") <= 50),
	CONSTRAINT "contacts_role_title_length" CHECK (length("contacts"."role_title") <= 200),
	CONSTRAINT "contacts_notes_length" CHECK (length("contacts"."notes") <= 5000)
);
--> statement-breakpoint
CREATE TABLE "project_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"template_step_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"entered_at" timestamp with time zone,
	"exited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_stages_key_format" CHECK ("project_stages"."key" ~ '^[a-z][a-z0-9_]{0,49}$'),
	CONSTRAINT "project_stages_name_length" CHECK (length("project_stages"."name") BETWEEN 1 AND 100),
	CONSTRAINT "project_stages_position_check" CHECK ("project_stages"."position" >= 0),
	CONSTRAINT "project_stages_kind_check" CHECK ("project_stages"."kind" IN ('linear','on_hold','archived')),
	CONSTRAINT "project_stages_role_check" CHECK ("project_stages"."role" IS NULL OR ("project_stages"."role" IN ('ready_to_deploy','live') AND "project_stages"."kind" = 'linear')),
	CONSTRAINT "project_stages_status_check" CHECK ("project_stages"."status" IN ('upcoming','current','completed','skipped'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"stage_template_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"start_date" date,
	"target_launch_date" date,
	"held_from_project_stage_id" uuid,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_length" CHECK (length("projects"."name") BETWEEN 1 AND 200),
	CONSTRAINT "projects_code_length" CHECK (length("projects"."code") BETWEEN 1 AND 30),
	CONSTRAINT "projects_description_length" CHECK (length("projects"."description") <= 20000),
	CONSTRAINT "projects_dates_order" CHECK ("projects"."target_launch_date" IS NULL OR "projects"."start_date" IS NULL OR "projects"."target_launch_date" >= "projects"."start_date")
);
--> statement-breakpoint
CREATE TABLE "stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_project_stage_id" uuid,
	"to_project_stage_id" uuid NOT NULL,
	"transition" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"deployment_id" uuid,
	"audit_event_id" uuid NOT NULL,
	CONSTRAINT "stage_history_transition_check" CHECK ("stage_history"."transition" IN ('initial','advance','skip_forward','move_back','hold','resume','archive','restore','go_live')),
	CONSTRAINT "stage_history_actor_type_check" CHECK ("stage_history"."actor_type" IN ('user','system')),
	CONSTRAINT "stage_history_actor_user_check" CHECK ("stage_history"."actor_type" <> 'user' OR "stage_history"."actor_user_id" IS NOT NULL),
	CONSTRAINT "stage_history_reason_length" CHECK (length("stage_history"."reason") BETWEEN 3 AND 2000),
	CONSTRAINT "stage_history_reason_required" CHECK ("stage_history"."transition" NOT IN ('skip_forward','move_back','hold','archive','restore') OR "stage_history"."reason" IS NOT NULL),
	CONSTRAINT "stage_history_go_live_check" CHECK (("stage_history"."transition" = 'go_live') = ("stage_history"."actor_type" = 'system') AND ("stage_history"."transition" <> 'go_live' OR "stage_history"."deployment_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "stage_template_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage_template_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text DEFAULT 'linear' NOT NULL,
	"role" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_template_steps_key_format" CHECK ("stage_template_steps"."key" ~ '^[a-z][a-z0-9_]{0,49}$'),
	CONSTRAINT "stage_template_steps_name_length" CHECK (length("stage_template_steps"."name") BETWEEN 1 AND 100),
	CONSTRAINT "stage_template_steps_position_check" CHECK ("stage_template_steps"."position" >= 0),
	CONSTRAINT "stage_template_steps_kind_check" CHECK ("stage_template_steps"."kind" IN ('linear','on_hold','archived')),
	CONSTRAINT "stage_template_steps_role_check" CHECK ("stage_template_steps"."role" IS NULL OR ("stage_template_steps"."role" IN ('ready_to_deploy','live') AND "stage_template_steps"."kind" = 'linear')),
	CONSTRAINT "stage_template_steps_description_length" CHECK (length("stage_template_steps"."description") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "stage_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_templates_name_length" CHECK (length("stage_templates"."name") BETWEEN 1 AND 200),
	CONSTRAINT "stage_templates_description_length" CHECK (length("stage_templates"."description") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "websites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"primary_domain" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "websites_id_client_id_key" UNIQUE("id","client_id"),
	CONSTRAINT "websites_name_length" CHECK (length("websites"."name") BETWEEN 1 AND 200),
	CONSTRAINT "websites_primary_domain_format" CHECK (length("websites"."primary_domain") <= 253 AND "websites"."primary_domain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
	CONSTRAINT "websites_status_check" CHECK ("websites"."status" IN ('planned','in_development','live','retired')),
	CONSTRAINT "websites_notes_length" CHECK (length("websites"."notes") <= 20000)
);
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_template_step_id_stage_template_steps_id_fk" FOREIGN KEY ("template_step_id") REFERENCES "public"."stage_template_steps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_stage_template_id_stage_templates_id_fk" FOREIGN KEY ("stage_template_id") REFERENCES "public"."stage_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_held_from_project_stage_id_project_stages_id_fk" FOREIGN KEY ("held_from_project_stage_id") REFERENCES "public"."project_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_website_same_client_fk" FOREIGN KEY ("website_id","client_id") REFERENCES "public"."websites"("id","client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_from_project_stage_id_project_stages_id_fk" FOREIGN KEY ("from_project_stage_id") REFERENCES "public"."project_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_to_project_stage_id_project_stages_id_fk" FOREIGN KEY ("to_project_stage_id") REFERENCES "public"."project_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_audit_event_id_audit_events_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."audit_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_template_steps" ADD CONSTRAINT "stage_template_steps_stage_template_id_stage_templates_id_fk" FOREIGN KEY ("stage_template_id") REFERENCES "public"."stage_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_templates" ADD CONSTRAINT "stage_templates_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "websites_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "websites_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_slug_live_key" ON "clients" USING btree ("slug") WHERE "clients"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "clients_name_trgm_idx" ON "clients" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_client_idx" ON "contacts" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_one_primary_key" ON "contacts" USING btree ("client_id") WHERE "contacts"."is_primary" AND "contacts"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_stages_key_key" ON "project_stages" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_stages_position_key" ON "project_stages" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "project_stages_one_current_key" ON "project_stages" USING btree ("project_id") WHERE "project_stages"."status" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "projects_code_live_key" ON "projects" USING btree ("code") WHERE "projects"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "projects_client_idx" ON "projects" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "projects_website_idx" ON "projects" USING btree ("website_id");--> statement-breakpoint
CREATE INDEX "projects_name_trgm_idx" ON "projects" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "stage_history_project_idx" ON "stage_history" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "stage_template_steps_key_key" ON "stage_template_steps" USING btree ("stage_template_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_template_steps_role_key" ON "stage_template_steps" USING btree ("stage_template_id","role") WHERE "stage_template_steps"."role" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stage_templates_name_live_key" ON "stage_templates" USING btree ("name") WHERE "stage_templates"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stage_templates_one_default_key" ON "stage_templates" USING btree ("is_default") WHERE "stage_templates"."is_default" AND "stage_templates"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "websites_primary_domain_live_key" ON "websites" USING btree ("primary_domain") WHERE "websites"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "websites_client_idx" ON "websites" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "websites_name_trgm_idx" ON "websites" USING gin ("name" gin_trgm_ops);