CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"token_env_var" text NOT NULL,
	"account_ref" text,
	"webhook_enabled" boolean DEFAULT false NOT NULL,
	"webhook_secret_env_var" text,
	"health" text DEFAULT 'unconfigured' NOT NULL,
	"health_detail" text,
	"last_tested_at" timestamp with time zone,
	"last_sync_started_at" timestamp with time zone,
	"last_sync_succeeded_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"rate_limit_remaining" integer,
	"rate_limit_limit" integer,
	"rate_limit_reset_at" timestamp with time zone,
	"poll_enabled" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_provider_check" CHECK ("integrations"."provider" IN ('github','netlify','vercel')),
	CONSTRAINT "integrations_name_length" CHECK (length("integrations"."name") BETWEEN 1 AND 100),
	CONSTRAINT "integrations_token_env_var_format" CHECK ("integrations"."token_env_var" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "integrations_account_ref_length" CHECK (length("integrations"."account_ref") <= 200),
	CONSTRAINT "integrations_webhook_secret_env_var_format" CHECK ("integrations"."webhook_secret_env_var" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "integrations_webhook_secret_required" CHECK (NOT "integrations"."webhook_enabled" OR "integrations"."webhook_secret_env_var" IS NOT NULL),
	CONSTRAINT "integrations_health_check" CHECK ("integrations"."health" IN ('unconfigured','ok','degraded','error','disabled')),
	CONSTRAINT "integrations_health_detail_length" CHECK (length("integrations"."health_detail") <= 1000),
	CONSTRAINT "integrations_last_error_length" CHECK (length("integrations"."last_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "repository_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_link_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"source" text NOT NULL,
	"commit_sha" text,
	"ref" text,
	"title" text,
	"author_login" text,
	"state" text,
	"conclusion" text,
	"html_url" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_events_type_check" CHECK ("repository_events"."event_type" IN ('commit','pull_request','check_run','check_suite','push','branch_protection')),
	CONSTRAINT "repository_events_provider_event_id_length" CHECK (length("repository_events"."provider_event_id") BETWEEN 1 AND 200),
	CONSTRAINT "repository_events_source_check" CHECK ("repository_events"."source" IN ('poll','webhook')),
	CONSTRAINT "repository_events_commit_sha_format" CHECK ("repository_events"."commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "repository_events_ref_length" CHECK (length("repository_events"."ref") <= 255),
	CONSTRAINT "repository_events_title_length" CHECK (length("repository_events"."title") <= 300),
	CONSTRAINT "repository_events_author_length" CHECK (length("repository_events"."author_login") <= 100),
	CONSTRAINT "repository_events_state_length" CHECK (length("repository_events"."state") <= 30),
	CONSTRAINT "repository_events_conclusion_length" CHECK (length("repository_events"."conclusion") <= 30),
	CONSTRAINT "repository_events_html_url_format" CHECK (length("repository_events"."html_url") <= 2048 AND "repository_events"."html_url" ~ '^https://'),
	CONSTRAINT "repository_events_snapshot_size" CHECK (octet_length("repository_events"."snapshot"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "repository_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"website_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"provider_repo_id" text,
	"production_branch" text NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_cursor" jsonb,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_links_owner_format" CHECK ("repository_links"."owner" ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'),
	CONSTRAINT "repository_links_repo_format" CHECK ("repository_links"."repo" ~ '^[A-Za-z0-9._-]{1,100}$'),
	CONSTRAINT "repository_links_branch_format" CHECK (length("repository_links"."production_branch") BETWEEN 1 AND 255 AND "repository_links"."production_branch" !~ '(\.\.|[[:cntrl:] ~^:?*\[\\]|@\{|^/|/$|\.lock$|^-)'),
	CONSTRAINT "repository_links_sync_cursor_size" CHECK (octet_length("repository_links"."sync_cursor"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"integration_id" uuid,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"body" jsonb NOT NULL,
	"body_sha256" "bytea" NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_inbox_provider_check" CHECK ("webhook_inbox"."provider" IN ('github','netlify','vercel')),
	CONSTRAINT "webhook_inbox_delivery_id_length" CHECK (length("webhook_inbox"."delivery_id") BETWEEN 1 AND 200),
	CONSTRAINT "webhook_inbox_event_type_length" CHECK (length("webhook_inbox"."event_type") BETWEEN 1 AND 100),
	CONSTRAINT "webhook_inbox_body_size" CHECK (octet_length("webhook_inbox"."body"::text) <= 262144),
	CONSTRAINT "webhook_inbox_status_check" CHECK ("webhook_inbox"."status" IN ('received','processing','processed','ignored','failed','dead_lettered')),
	CONSTRAINT "webhook_inbox_attempts_check" CHECK ("webhook_inbox"."attempts" >= 0),
	CONSTRAINT "webhook_inbox_last_error_length" CHECK (length("webhook_inbox"."last_error") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_events" ADD CONSTRAINT "repository_events_repository_link_id_repository_links_id_fk" FOREIGN KEY ("repository_link_id") REFERENCES "public"."repository_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_links" ADD CONSTRAINT "repository_links_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_links" ADD CONSTRAINT "repository_links_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_links" ADD CONSTRAINT "repository_links_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD CONSTRAINT "webhook_inbox_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_name_live_key" ON "integrations" USING btree ("provider","name") WHERE "integrations"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "repository_events_identity_key" ON "repository_events" USING btree ("repository_link_id","event_type","provider_event_id");--> statement-breakpoint
CREATE INDEX "repository_events_link_type_idx" ON "repository_events" USING btree ("repository_link_id","event_type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "repository_events_commit_idx" ON "repository_events" USING btree ("commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_links_one_primary_key" ON "repository_links" USING btree ("website_id") WHERE "repository_links"."is_primary" AND "repository_links"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "repository_links_repo_live_key" ON "repository_links" USING btree ("website_id",lower("owner"),lower("repo")) WHERE "repository_links"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "repository_links_integration_idx" ON "repository_links" USING btree ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_inbox_delivery_key" ON "webhook_inbox" USING btree ("provider","delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_inbox_status_idx" ON "webhook_inbox" USING btree ("status","next_attempt_at");