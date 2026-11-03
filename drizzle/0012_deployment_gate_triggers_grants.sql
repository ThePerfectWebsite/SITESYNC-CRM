-- Phase 4: integrity, terminal-state trigger and grants for production approvals
-- (spec §3.23, §5.4; decision 0011).

-- An approval's website matches its hosting link's website.
ALTER TABLE production_approvals ADD CONSTRAINT production_approvals_link_same_website_fk
  FOREIGN KEY (hosting_link_id, website_id) REFERENCES hosting_links (id, website_id) ON DELETE RESTRICT;
--> statement-breakpoint

-- A promote/rollback target is one of that hosting link's deployments.
ALTER TABLE production_approvals ADD CONSTRAINT production_approvals_target_same_link_fk
  FOREIGN KEY (target_deployment_id, hosting_link_id) REFERENCES deployments (id, hosting_link_id) ON DELETE RESTRICT;
--> statement-breakpoint

-- §5.4: every state except awaiting_confirmation is terminal, and what was
-- approved (target, snapshot, hash, reason, expiry) never changes.
CREATE OR REPLACE FUNCTION production_approvals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'awaiting_confirmation' THEN
    RAISE EXCEPTION 'production approval % is %, a terminal state', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.project_id, NEW.website_id, NEW.hosting_link_id, NEW.provider, NEW.provider_project_id, NEW.environment,
      NEW.action, NEW.target_deployment_id, NEW.target_provider_deployment_id, NEW.target_commit_sha,
      NEW.production_branch, NEW.expected_current_provider_deployment_id, NEW.preflight_hash, NEW.reason,
      NEW.approved_by, NEW.approved_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.project_id, OLD.website_id, OLD.hosting_link_id, OLD.provider, OLD.provider_project_id, OLD.environment,
      OLD.action, OLD.target_deployment_id, OLD.target_provider_deployment_id, OLD.target_commit_sha,
      OLD.production_branch, OLD.expected_current_provider_deployment_id, OLD.preflight_hash, OLD.reason,
      OLD.approved_by, OLD.approved_at, OLD.expires_at)
     OR NEW.preflight_snapshot::text IS DISTINCT FROM OLD.preflight_snapshot::text THEN
    RAISE EXCEPTION 'what production approval % approved cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER production_approvals_guard BEFORE UPDATE ON production_approvals
  FOR EACH ROW EXECUTE FUNCTION production_approvals_guard();
--> statement-breakpoint
CREATE TRIGGER production_approvals_set_updated_at BEFORE UPDATE ON production_approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- Approvals are history: never deleted (decision 0006 explicit grants).
GRANT SELECT, INSERT, UPDATE ON production_approvals TO sitesync_app;
