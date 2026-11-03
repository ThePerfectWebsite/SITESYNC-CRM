CREATE TABLE "production_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"hosting_link_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_project_id" text NOT NULL,
	"environment" text NOT NULL,
	"action" text NOT NULL,
	"target_deployment_id" uuid,
	"target_provider_deployment_id" text,
	"target_commit_sha" text NOT NULL,
	"production_branch" text,
	"expected_current_provider_deployment_id" text,
	"preflight_snapshot" jsonb NOT NULL,
	"preflight_hash" "bytea" NOT NULL,
	"reason" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'awaiting_confirmation' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"refusal_reason" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_approvals_provider_check" CHECK ("production_approvals"."provider" IN ('netlify','vercel','cloudflare')),
	CONSTRAINT "production_approvals_provider_project_id_length" CHECK (length("production_approvals"."provider_project_id") BETWEEN 1 AND 200),
	CONSTRAINT "production_approvals_environment_check" CHECK ("production_approvals"."environment" = 'production'),
	CONSTRAINT "production_approvals_action_check" CHECK ("production_approvals"."action" IN ('promote','rollback','build_from_ref')),
	CONSTRAINT "production_approvals_target_required" CHECK ("production_approvals"."action" = 'build_from_ref' OR ("production_approvals"."target_provider_deployment_id" IS NOT NULL AND "production_approvals"."target_deployment_id" IS NOT NULL)),
	CONSTRAINT "production_approvals_branch_required" CHECK ("production_approvals"."action" <> 'build_from_ref' OR "production_approvals"."production_branch" IS NOT NULL),
	CONSTRAINT "production_approvals_target_id_length" CHECK (length("production_approvals"."target_provider_deployment_id") BETWEEN 1 AND 200),
	CONSTRAINT "production_approvals_target_commit_format" CHECK ("production_approvals"."target_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "production_approvals_branch_length" CHECK (length("production_approvals"."production_branch") BETWEEN 1 AND 255),
	CONSTRAINT "production_approvals_expected_id_length" CHECK (length("production_approvals"."expected_current_provider_deployment_id") BETWEEN 1 AND 200),
	CONSTRAINT "production_approvals_snapshot_size" CHECK (octet_length("production_approvals"."preflight_snapshot"::text) <= 65536),
	CONSTRAINT "production_approvals_hash_length" CHECK (octet_length("production_approvals"."preflight_hash") = 32),
	CONSTRAINT "production_approvals_reason_length" CHECK (length("production_approvals"."reason") BETWEEN 3 AND 2000),
	CONSTRAINT "production_approvals_expiry" CHECK ("production_approvals"."expires_at" = "production_approvals"."approved_at" + interval '30 minutes'),
	CONSTRAINT "production_approvals_status_check" CHECK ("production_approvals"."status" IN ('awaiting_confirmation','consumed','expired','revoked','refused')),
	CONSTRAINT "production_approvals_consumed" CHECK (("production_approvals"."status" = 'consumed') = ("production_approvals"."consumed_at" IS NOT NULL)),
	CONSTRAINT "production_approvals_revoked" CHECK (("production_approvals"."status" = 'revoked') = ("production_approvals"."revoked_at" IS NOT NULL)),
	CONSTRAINT "production_approvals_refusal_length" CHECK (length("production_approvals"."refusal_reason") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "production_approvals" ADD CONSTRAINT "production_approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_approvals" ADD CONSTRAINT "production_approvals_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_approvals" ADD CONSTRAINT "production_approvals_hosting_link_id_hosting_links_id_fk" FOREIGN KEY ("hosting_link_id") REFERENCES "public"."hosting_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_approvals" ADD CONSTRAINT "production_approvals_target_deployment_id_deployments_id_fk" FOREIGN KEY ("target_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_approvals" ADD CONSTRAINT "production_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_approvals" ADD CONSTRAINT "production_approvals_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_approvals_one_awaiting_key" ON "production_approvals" USING btree ("hosting_link_id") WHERE "production_approvals"."status" = 'awaiting_confirmation';--> statement-breakpoint
CREATE INDEX "production_approvals_project_idx" ON "production_approvals" USING btree ("project_id","approved_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "production_approvals_status_idx" ON "production_approvals" USING btree ("status");--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_approval_id_production_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."production_approvals"("id") ON DELETE restrict ON UPDATE no action;