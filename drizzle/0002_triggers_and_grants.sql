-- Spec §2.2 / decision 0002: updated_at triggers, append-only enforcement, runtime grants.

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER login_attempts_set_updated_at BEFORE UPDATE ON login_attempts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER app_settings_set_updated_at BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER audit_events_reject_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_reject_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- Runtime role: DML only, no DDL, no TRUNCATE anywhere.
GRANT USAGE ON SCHEMA public TO sitesync_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, login_attempts, app_settings TO sitesync_app;
--> statement-breakpoint
-- Append-only: insert and read only (the trigger is the enforcement; this is defence in depth).
GRANT SELECT, INSERT ON audit_events TO sitesync_app;
--> statement-breakpoint
-- /health reads applied migrations.
GRANT USAGE ON SCHEMA drizzle TO sitesync_app;
--> statement-breakpoint
GRANT SELECT ON drizzle.__drizzle_migrations TO sitesync_app;
