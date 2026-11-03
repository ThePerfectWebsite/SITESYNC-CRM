-- Phase 3a: triggers and grants for the GitHub sync tables (spec §3.18–§3.20, §3.24).

CREATE TRIGGER integrations_set_updated_at BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER repository_links_set_updated_at BEFORE UPDATE ON repository_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER repository_events_set_updated_at BEFORE UPDATE ON repository_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER webhook_inbox_set_updated_at BEFORE UPDATE ON webhook_inbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- Decision 0006: explicit grants. Integrations and links are archived; repository
-- events are upserted snapshots (history), so none of these get DELETE.
GRANT SELECT, INSERT, UPDATE ON integrations, repository_links, repository_events TO sitesync_app;
--> statement-breakpoint
-- The inbox is a queue, not history: processed/ignored rows are pruned after 30 days (§3.24).
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_inbox TO sitesync_app;
