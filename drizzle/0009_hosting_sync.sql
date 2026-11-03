CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hosting_link_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"project_id" uuid,
	"provider" text NOT NULL,
	"provider_deployment_id" text,
	"environment" text NOT NULL,
	"origin" text NOT NULL,
	"kind" text DEFAULT 'deploy' NOT NULL,
	"state" text NOT NULL,
	"provider_state" text,
	"dispatch_state" text,
	"commit_sha" text,
	"branch" text,
	"deploy_url" text,
	"provider_created_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"last_confirmed_at" timestamp with time zone,
	"confirmation_source" text,
	"error_summary" text,
	"idempotency_key" uuid,
	"approval_id" uuid,
	"target_deployment_id" uuid,
	"previous_live_deployment_id" uuid,
	"initiated_by" uuid,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_provider_check" CHECK ("deployments"."provider" IN ('netlify','vercel','cloudflare','other')),
	CONSTRAINT "deployments_provider_deployment_id_length" CHECK (length("deployments"."provider_deployment_id") BETWEEN 1 AND 200),
	CONSTRAINT "deployments_environment_check" CHECK ("deployments"."environment" IN ('production','preview','staging')),
	CONSTRAINT "deployments_origin_check" CHECK ("deployments"."origin" IN ('provider_observed','sitesync_initiated','manual_record')),
	CONSTRAINT "deployments_kind_check" CHECK ("deployments"."kind" IN ('deploy','promote','rollback')),
	CONSTRAINT "deployments_state_check" CHECK ("deployments"."state" IN ('queued','building','ready','published','failed','canceled','superseded','unknown')),
	CONSTRAINT "deployments_provider_state_length" CHECK (length("deployments"."provider_state") <= 50),
	CONSTRAINT "deployments_dispatch_state_check" CHECK (("deployments"."origin" = 'sitesync_initiated') = ("deployments"."dispatch_state" IS NOT NULL) AND ("deployments"."dispatch_state" IS NULL OR "deployments"."dispatch_state" IN ('pending','dispatched','dispatch_failed','confirming','confirmed_success','confirmed_failure','timed_out'))),
	CONSTRAINT "deployments_commit_sha_format" CHECK ("deployments"."commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "deployments_branch_length" CHECK (length("deployments"."branch") <= 255),
	CONSTRAINT "deployments_deploy_url_format" CHECK (length("deployments"."deploy_url") <= 2048 AND "deployments"."deploy_url" ~ '^https://'),
	CONSTRAINT "deployments_confirmation_source_check" CHECK (("deployments"."confirmation_source" IS NULL OR "deployments"."confirmation_source" = 'provider') AND ("deployments"."origin" <> 'manual_record' OR "deployments"."confirmation_source" IS NULL)),
	CONSTRAINT "deployments_error_summary_length" CHECK (length("deployments"."error_summary") <= 2000),
	CONSTRAINT "deployments_initiated_needs_idempotency_key" CHECK ("deployments"."origin" <> 'sitesync_initiated' OR "deployments"."idempotency_key" IS NOT NULL),
	CONSTRAINT "deployments_production_needs_approval" CHECK ("deployments"."origin" <> 'sitesync_initiated' OR "deployments"."approval_id" IS NOT NULL OR "deployments"."environment" <> 'production'),
	CONSTRAINT "deployments_snapshot_size" CHECK (octet_length("deployments"."snapshot"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "hosting_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"website_id" uuid NOT NULL,
	"integration_id" uuid,
	"provider" text NOT NULL,
	"provider_project_id" text,
	"provider_project_name" text,
	"environment" text NOT NULL,
	"domain" text,
	"repository_link_id" uuid,
	"auto_publish" text DEFAULT 'unknown' NOT NULL,
	"auto_publish_checked_at" timestamp with time zone,
	"current_deployment_id" uuid,
	"last_synced_at" timestamp with time zone,
	"sync_cursor" jsonb,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosting_links_provider_check" CHECK ("hosting_links"."provider" IN ('netlify','vercel','cloudflare','other')),
	CONSTRAINT "hosting_links_provider_project_required" CHECK ("hosting_links"."integration_id" IS NULL OR "hosting_links"."provider_project_id" IS NOT NULL),
	CONSTRAINT "hosting_links_provider_project_id_length" CHECK (length("hosting_links"."provider_project_id") BETWEEN 1 AND 200),
	CONSTRAINT "hosting_links_provider_project_name_length" CHECK (length("hosting_links"."provider_project_name") <= 200),
	CONSTRAINT "hosting_links_environment_check" CHECK ("hosting_links"."environment" IN ('production','preview','staging')),
	CONSTRAINT "hosting_links_domain_format" CHECK (length("hosting_links"."domain") <= 253 AND "hosting_links"."domain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
	CONSTRAINT "hosting_links_auto_publish_check" CHECK ("hosting_links"."auto_publish" IN ('enabled','locked','disabled','unknown')),
	CONSTRAINT "hosting_links_sync_cursor_size" CHECK (octet_length("hosting_links"."sync_cursor"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT "integrations_provider_check";--> statement-breakpoint
ALTER TABLE "webhook_inbox" DROP CONSTRAINT "webhook_inbox_provider_check";--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_hosting_link_id_hosting_links_id_fk" FOREIGN KEY ("hosting_link_id") REFERENCES "public"."hosting_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_target_deployment_id_deployments_id_fk" FOREIGN KEY ("target_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_previous_live_deployment_id_deployments_id_fk" FOREIGN KEY ("previous_live_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_links" ADD CONSTRAINT "hosting_links_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_links" ADD CONSTRAINT "hosting_links_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_links" ADD CONSTRAINT "hosting_links_repository_link_id_repository_links_id_fk" FOREIGN KEY ("repository_link_id") REFERENCES "public"."repository_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_links" ADD CONSTRAINT "hosting_links_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_provider_deployment_key" ON "deployments" USING btree ("provider","provider_deployment_id") WHERE "deployments"."provider_deployment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_idempotency_key" ON "deployments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_approval_key" ON "deployments" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "deployments_link_created_idx" ON "deployments" USING btree ("hosting_link_id","provider_created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deployments_project_created_idx" ON "deployments" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deployments_commit_idx" ON "deployments" USING btree ("commit_sha");--> statement-breakpoint
CREATE INDEX "deployments_in_flight_idx" ON "deployments" USING btree ("state") WHERE "deployments"."state" IN ('queued','building');--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_links_provider_project_key" ON "hosting_links" USING btree ("integration_id","provider_project_id","environment") WHERE "hosting_links"."archived_at" IS NULL AND "hosting_links"."integration_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_links_one_production_key" ON "hosting_links" USING btree ("website_id") WHERE "hosting_links"."environment" = 'production' AND "hosting_links"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "hosting_links_website_idx" ON "hosting_links" USING btree ("website_id");--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_shipped_in_deployment_id_deployments_id_fk" FOREIGN KEY ("shipped_in_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_provider_check" CHECK ("integrations"."provider" IN ('github','netlify','vercel','cloudflare'));--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD CONSTRAINT "webhook_inbox_provider_check" CHECK ("webhook_inbox"."provider" IN ('github','netlify','vercel','cloudflare'));