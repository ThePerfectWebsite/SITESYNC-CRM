// Workflow (stage) templates (spec §3.9–§3.10). Edits affect new projects only
// (decision 0003). The full template editor is Phase 5; Phase 1 can rename steps.
import { asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx } from "../db/client";
import { stageTemplates, stageTemplateSteps } from "../db/schema";
import { auditActor, type Actor } from "./actor";
import { notFound, parseInput } from "./errors";
import { optionalText, requiredText } from "./fields";

export async function listTemplates(db: DbOrTx) {
  const templates = await db
    .select()
    .from(stageTemplates)
    .where(isNull(stageTemplates.archivedAt))
    .orderBy(asc(stageTemplates.name));
  const steps = await db.select().from(stageTemplateSteps).orderBy(asc(stageTemplateSteps.position));
  return templates.map((template) => ({
    ...template,
    steps: steps.filter((step) => step.stageTemplateId === template.id),
  }));
}

export async function defaultTemplateSteps(db: DbOrTx) {
  return db
    .select({ key: stageTemplateSteps.key, name: stageTemplateSteps.name, kind: stageTemplateSteps.kind, role: stageTemplateSteps.role, position: stageTemplateSteps.position })
    .from(stageTemplateSteps)
    .innerJoin(stageTemplates, eq(stageTemplates.id, stageTemplateSteps.stageTemplateId))
    .where(eq(stageTemplates.isDefault, true))
    .orderBy(asc(stageTemplateSteps.position));
}

export const templateStepSchema = z.object({
  name: requiredText("a name", 100),
  description: optionalText(2000),
});

export async function updateTemplateStep(
  db: Db,
  actor: Actor,
  stepId: string,
  input: z.input<typeof templateStepSchema>,
): Promise<void> {
  const data = parseInput(templateStepSchema, input);
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(stageTemplateSteps)
      .where(eq(stageTemplateSteps.id, stepId))
      .for("update");
    if (!before) throw notFound("Template step");
    await tx.update(stageTemplateSteps).set(data).where(eq(stageTemplateSteps.id, stepId));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "stage_template.step_updated",
      subjectType: "stage_template",
      subjectId: before.stageTemplateId,
      summary: `Workflow step ${before.name} renamed to ${data.name}`,
      before: { name: before.name, description: before.description },
      after: data,
      metadata: { stepId, key: before.key },
      requestId: actor.requestId,
    });
  });
}
