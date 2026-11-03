# 0003 — Projects copy their stage steps from the template at creation

**Context.** Stage templates are editable. If projects referenced template steps directly, renaming, reordering or removing a step would rewrite the stage history and current position of every existing project.

**Decision.** On project creation the template's steps are copied into `project_stages` (key, name, position, kind, role), keeping `template_step_id` for provenance. Template edits affect new projects only. Gate behaviour (Ready to Deploy, Live) is keyed on the step's `role`, not its name, so the operator can rename stages freely.

**Alternatives.** (a) Reference template steps directly and version templates — more machinery than one operator needs. (b) Hard-coded stage enum — blocks the "editable template" requirement.
