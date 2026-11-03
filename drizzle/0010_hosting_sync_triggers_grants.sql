-- Phase 3b: consistency constraints, triggers and grants for hosting (spec §3.21–§3.22).

-- deployments.website_id is denormalized and must match its hosting link's website.
ALTER TABLE hosting_links ADD CONSTRAINT hosting_links_id_website_id_key UNIQUE (id, website_id);
--> statement-breakpoint
ALTER TABLE deployments ADD CONSTRAINT deployments_link_same_website_fk
  FOREIGN KEY (hosting_link_id, website_id) REFERENCES hosting_links (id, website_id) ON DELETE RESTRICT;
--> statement-breakpoint

-- A link's current deployment must be one of that link's deployments. Deferrable,
-- because the link and its first deployment can arrive in the same transaction.
ALTER TABLE deployments ADD CONSTRAINT deployments_id_hosting_link_id_key UNIQUE (id, hosting_link_id);
--> statement-breakpoint
ALTER TABLE hosting_links ADD CONSTRAINT hosting_links_current_deployment_fk
  FOREIGN KEY (current_deployment_id, id) REFERENCES deployments (id, hosting_link_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

CREATE TRIGGER hosting_links_set_updated_at BEFORE UPDATE ON hosting_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER deployments_set_updated_at BEFORE UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- Decision 0006: explicit grants. Hosting links are archived; deployments are
-- history and are never deleted (§3.22).
GRANT SELECT, INSERT, UPDATE ON hosting_links, deployments TO sitesync_app;
