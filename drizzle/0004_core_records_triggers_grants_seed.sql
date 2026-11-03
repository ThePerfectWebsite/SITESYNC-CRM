-- Phase 1: what drizzle-kit can't express for the core records (spec §3.6–§3.13).

-- §3.10: (template, position) is unique but deferrable, so steps can be reordered in one transaction.
ALTER TABLE stage_template_steps
  ADD CONSTRAINT stage_template_steps_position_key UNIQUE (stage_template_id, position)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

CREATE TRIGGER clients_set_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER contacts_set_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER websites_set_updated_at BEFORE UPDATE ON websites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER stage_templates_set_updated_at BEFORE UPDATE ON stage_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER stage_template_steps_set_updated_at BEFORE UPDATE ON stage_template_steps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER project_stages_set_updated_at BEFORE UPDATE ON project_stages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- Decision 0002: stage_history is append-only.
CREATE TRIGGER stage_history_reject_update_delete BEFORE UPDATE OR DELETE ON stage_history
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stage_history_reject_truncate BEFORE TRUNCATE ON stage_history
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- §3.10: a template has exactly one on_hold step, one archived step, one
-- ready_to_deploy step and one live step, with live after ready_to_deploy.
-- Checked at commit so a template can be built or edited step by step.
CREATE FUNCTION check_stage_template_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  template uuid;
  on_hold_count int;
  archived_count int;
  rtd_position int;
  live_position int;
BEGIN
  IF TG_TABLE_NAME = 'stage_templates' THEN
    template := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    template := OLD.stage_template_id;
  ELSE
    template := NEW.stage_template_id;
  END IF;

  -- The template row itself may be gone (never in practice: FKs restrict).
  IF NOT EXISTS (SELECT 1 FROM stage_templates WHERE id = template) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) FILTER (WHERE kind = 'on_hold'),
         count(*) FILTER (WHERE kind = 'archived'),
         max(position) FILTER (WHERE role = 'ready_to_deploy'),
         max(position) FILTER (WHERE role = 'live')
    INTO on_hold_count, archived_count, rtd_position, live_position
    FROM stage_template_steps
   WHERE stage_template_id = template;

  IF on_hold_count <> 1 OR archived_count <> 1 OR rtd_position IS NULL OR live_position IS NULL
     OR live_position <= rtd_position THEN
    RAISE EXCEPTION 'stage template % is invalid: it needs exactly one On Hold step, one Archived step, and Ready to Deploy before Live', template
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stage_templates_shape AFTER INSERT ON stage_templates
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_stage_template_shape();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stage_template_steps_shape AFTER INSERT OR UPDATE OR DELETE ON stage_template_steps
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_stage_template_shape();
--> statement-breakpoint

-- §3.12: the unique partial index allows at most one current stage; this makes
-- it exactly one, checked at commit.
CREATE FUNCTION check_project_current_stage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  project uuid;
  current_count int;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    project := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    project := OLD.project_id;
  ELSE
    project := NEW.project_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM projects WHERE id = project) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO current_count
    FROM project_stages
   WHERE project_id = project AND status = 'current';

  IF current_count <> 1 THEN
    RAISE EXCEPTION 'project % must have exactly one current stage (found %)', project, current_count
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER projects_one_current_stage AFTER INSERT ON projects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_project_current_stage();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER project_stages_one_current_stage AFTER INSERT OR UPDATE OR DELETE ON project_stages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_project_current_stage();
--> statement-breakpoint

-- Decision 0006: explicit grants. Nothing in Phase 1 is ever deleted (archive,
-- don't delete), so the runtime role gets no DELETE on these tables.
GRANT SELECT, INSERT, UPDATE ON clients, contacts, websites, stage_templates,
  stage_template_steps, projects, project_stages TO sitesync_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON stage_history TO sitesync_app;
--> statement-breakpoint

-- §3.10 seed, once, only if no template exists.
DO $$
DECLARE
  template uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM stage_templates) THEN
    RETURN;
  END IF;

  INSERT INTO stage_templates (name, is_default, description)
  VALUES ('Standard website project', true, 'The default workflow for a website build.')
  RETURNING id INTO template;

  INSERT INTO stage_template_steps (stage_template_id, position, key, name, kind, role) VALUES
    (template, 0, 'enquiry', 'Enquiry', 'linear', NULL),
    (template, 1, 'discovery', 'Discovery', 'linear', NULL),
    (template, 2, 'design', 'Design', 'linear', NULL),
    (template, 3, 'build', 'Build', 'linear', NULL),
    (template, 4, 'client_review', 'Client Review', 'linear', NULL),
    (template, 5, 'ready_to_deploy', 'Ready to Deploy', 'linear', 'ready_to_deploy'),
    (template, 6, 'live', 'Live', 'linear', 'live'),
    (template, 7, 'maintenance', 'Maintenance', 'linear', NULL),
    (template, 100, 'on_hold', 'On Hold', 'on_hold', NULL),
    (template, 101, 'archived', 'Archived', 'archived', NULL);
END;
$$;
