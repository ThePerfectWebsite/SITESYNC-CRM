-- Phase 2: triggers, grants and the checklist template seed (spec §3.14–§3.17).

CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER changes_set_updated_at BEFORE UPDATE ON changes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER release_checklist_items_set_updated_at BEFORE UPDATE ON release_checklist_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER readiness_waivers_set_updated_at BEFORE UPDATE ON readiness_waivers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- Decision 0006: explicit grants. Archive (or revoke), don't delete: no DELETE.
GRANT SELECT, INSERT, UPDATE ON tasks, changes, release_checklist_items, readiness_waivers TO sitesync_app;
--> statement-breakpoint

-- §3.16 default release checklist template, only if none is stored yet.
INSERT INTO app_settings (key, value) VALUES ('release_checklist.template', '[
  {"key": "dns_ssl", "label": "DNS & SSL verified", "required": true},
  {"key": "analytics", "label": "Analytics installed", "required": true},
  {"key": "forms_tested", "label": "Forms tested", "required": true},
  {"key": "not_found_page", "label": "404 page", "required": true},
  {"key": "redirects", "label": "Redirects mapped", "required": true},
  {"key": "metadata", "label": "Favicon, metadata and Open Graph tags", "required": true},
  {"key": "accessibility", "label": "Accessibility smoke check", "required": true},
  {"key": "performance", "label": "Performance check", "required": true},
  {"key": "backups", "label": "Backups and restore path known", "required": true},
  {"key": "client_signoff", "label": "Client sign-off received", "required": true}
]'::jsonb)
ON CONFLICT (key) DO NOTHING;
