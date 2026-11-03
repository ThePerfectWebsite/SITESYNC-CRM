// Projects (spec §3.11). Creating a project copies its template's steps into
// project_stages (decision 0003) and records the initial stage. Archiving and
// restoring are stage transitions (see stages/service.ts).
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx, Tx } from "../db/client";
import {
  clients,
  projects,
  projectStages,
  stageHistory,
  stageTemplates,
  stageTemplateSteps,
  websites,
} from "../db/schema";
import { databaseDeploymentFacts, type DeploymentFacts } from "../stages/deployment-facts";
import { planInitial } from "../stages/machine";
import { auditActor, type Actor } from "./actor";
import { instantiateChecklist } from "./checklist";
import { DomainError, invalidField, isUniqueViolation, notFound, parseInput, type RawInput } from "./errors";
import { appToday } from "./dates";
import { escapeLike, optionalDate, optionalText, requiredText, uuid } from "./fields";

const projectFields = {
  name: requiredText("a name", 200),
  code: optionalText(30),
  description: optionalText(20000),
  startDate: optionalDate,
  targetLaunchDate: optionalDate,
};

const datesInOrder = <T extends { startDate: string | null; targetLaunchDate: string | null }>(
  value: T,
  ctx: z.RefinementCtx,
) => {
  if (value.startDate && value.targetLaunchDate && value.targetLaunchDate < value.startDate) {
    ctx.addIssue({
      code: "custom",
      path: ["targetLaunchDate"],
      message: "The target launch date can't be before the start date.",
    });
  }
};

export const newProjectSchema = z
  .object({
    ...projectFields,
    clientId: uuid("Choose a client."),
    websiteId: uuid("Choose a website."),
    stageTemplateId: z
      .string()
      .trim()
      .nullish()
      .transform((value) => (value ? value : null))
      .pipe(z.uuid().nullable()),
    initialStageKey: z
      .string()
      .trim()
      .nullish()
      .transform((value) => (value ? value : null)),
  })
  .superRefine(datesInOrder);

export const projectSchema = z
  .object({ ...projectFields, websiteId: uuid("Choose a website.") })
  .superRefine(datesInOrder);

export type NewProjectInput = RawInput<typeof newProjectSchema>;
export type ProjectInput = RawInput<typeof projectSchema>;

const CODE_KEY = "projects_code_live_key";
const codeTaken = () => invalidField("code", "Another project uses this code.");

type ProjectRow = typeof projects.$inferSelect;

function snapshot(row: ProjectRow) {
  return {
    name: row.name,
    code: row.code,
    description: row.description,
    startDate: row.startDate,
    targetLaunchDate: row.targetLaunchDate,
    websiteId: row.websiteId,
  };
}

/** Friendly check before the composite FK would reject it (decision 0001). */
async function requireWebsiteOfClient(tx: Tx, websiteId: string, clientId: string) {
  const [website] = await tx.select().from(websites).where(eq(websites.id, websiteId)).for("share");
  if (!website) throw invalidField("websiteId", "Choose a website.");
  if (website.clientId !== clientId) {
    throw invalidField("websiteId", "This website belongs to a different client.");
  }
  if (website.archivedAt) throw invalidField("websiteId", "This website is archived.");
  return website;
}

async function resolveTemplate(tx: Tx, templateId: string | null) {
  const [template] = await tx
    .select()
    .from(stageTemplates)
    .where(
      and(
        templateId ? eq(stageTemplates.id, templateId) : eq(stageTemplates.isDefault, true),
        isNull(stageTemplates.archivedAt),
      ),
    );
  if (!template) throw invalidField("stageTemplateId", "Choose a workflow template.");
  return template;
}

export async function createProject(db: Db, actor: Actor, input: NewProjectInput): Promise<string> {
  const data = parseInput(newProjectSchema, input);
  try {
    return await db.transaction(async (tx) => {
      const [client] = await tx.select().from(clients).where(eq(clients.id, data.clientId)).for("share");
      if (!client) throw invalidField("clientId", "Choose a client.");
      if (client.archivedAt) throw invalidField("clientId", "This client is archived.");
      const website = await requireWebsiteOfClient(tx, data.websiteId, data.clientId);
      const template = await resolveTemplate(tx, data.stageTemplateId);

      const [project] = await tx
        .insert(projects)
        .values({
          clientId: client.id,
          websiteId: website.id,
          stageTemplateId: template.id,
          name: data.name,
          code: data.code,
          description: data.description,
          startDate: data.startDate,
          targetLaunchDate: data.targetLaunchDate,
        })
        .returning();

      const steps = await tx
        .select()
        .from(stageTemplateSteps)
        .where(eq(stageTemplateSteps.stageTemplateId, template.id))
        .orderBy(asc(stageTemplateSteps.position));
      const stages = await tx
        .insert(projectStages)
        .values(
          steps.map((step) => ({
            projectId: project!.id,
            templateStepId: step.id,
            key: step.key,
            name: step.name,
            position: step.position,
            kind: step.kind,
            role: step.role,
          })),
        )
        .returning();

      const initial = planInitial(
        stages.map((s) => ({ ...s, status: s.status })),
        data.initialStageKey,
      );
      if (!initial.ok) throw invalidField("initialStageKey", initial.error);
      const now = new Date();
      for (const update of initial.plan.updates) {
        await tx
          .update(projectStages)
          .set({ status: update.status, ...(update.id === initial.plan.toId ? { enteredAt: now } : {}) })
          .where(eq(projectStages.id, update.id));
      }
      const startStage = stages.find((s) => s.id === initial.plan.toId)!;
      const checklistItems = await instantiateChecklist(tx, project!.id);

      const auditEventId = await writeAudit(tx, {
        actor: auditActor(actor),
        action: "project.created",
        subjectType: "project",
        subjectId: project!.id,
        clientId: client.id,
        websiteId: website.id,
        projectId: project!.id,
        summary: `Project ${project!.name} created at ${startStage.name}`,
        after: { ...snapshot(project!), template: template.name, initialStage: startStage.key, checklistItems },
        requestId: actor.requestId,
      });
      await tx.insert(stageHistory).values({
        projectId: project!.id,
        fromProjectStageId: null,
        toProjectStageId: startStage.id,
        transition: "initial",
        actorType: "user",
        actorUserId: actor.userId,
        auditEventId,
      });
      return project!.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, CODE_KEY)) throw codeTaken();
    throw error;
  }
}

export async function updateProject(
  db: Db,
  actor: Actor,
  id: string,
  input: ProjectInput,
  facts: DeploymentFacts = databaseDeploymentFacts,
): Promise<void> {
  const data = parseInput(projectSchema, input);
  try {
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
      if (!before) throw notFound("Project");
      if (before.archivedAt) throw new DomainError("conflict", "Restore this project before editing it.");
      if (data.websiteId !== before.websiteId) {
        await requireWebsiteOfClient(tx, data.websiteId, before.clientId);
        if (await facts.hasDeployments(tx, id)) {
          throw invalidField(
            "websiteId",
            "This project has deployments, so its website can no longer change.",
          );
        }
      }
      const [after] = await tx
        .update(projects)
        .set({
          name: data.name,
          code: data.code,
          description: data.description,
          startDate: data.startDate,
          targetLaunchDate: data.targetLaunchDate,
          websiteId: data.websiteId,
        })
        .where(eq(projects.id, id))
        .returning();
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "project.updated",
        subjectType: "project",
        subjectId: id,
        clientId: before.clientId,
        websiteId: after!.websiteId,
        projectId: id,
        summary: `Project ${after!.name} updated`,
        before: snapshot(before),
        after: snapshot(after!),
        requestId: actor.requestId,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, CODE_KEY)) throw codeTaken();
    throw error;
  }
}

// --- Queries -----------------------------------------------------------------

const currentStageJoin = and(eq(projectStages.projectId, projects.id), eq(projectStages.status, "current"));

/** True while the project's Live stage hasn't been reached (still upcoming). */
const liveNotReached = sql<boolean>`EXISTS (
  SELECT 1 FROM ${projectStages} ls
  WHERE ls.project_id = ${projects.id} AND ls.role = 'live' AND ls.status = 'upcoming'
)`;

export type ProjectFilters = {
  q?: string | null;
  clientId?: string | null;
  websiteId?: string | null;
  stageKey?: string | null;
  overdue?: boolean;
  includeArchived?: boolean;
  today?: string;
};

export async function listProjects(db: DbOrTx, filters: ProjectFilters = {}) {
  const today = filters.today ?? (await appToday(db));
  const overdue = sql<boolean>`(${projects.targetLaunchDate} < ${today}::date AND ${projects.archivedAt} IS NULL AND ${liveNotReached})`;
  const conditions: SQL[] = [];
  if (!filters.includeArchived) conditions.push(isNull(projects.archivedAt));
  if (filters.clientId) conditions.push(eq(projects.clientId, filters.clientId));
  if (filters.websiteId) conditions.push(eq(projects.websiteId, filters.websiteId));
  if (filters.stageKey) conditions.push(eq(projectStages.key, filters.stageKey));
  if (filters.overdue) conditions.push(overdue);
  const q = filters.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conditions.push(or(ilike(projects.name, like), ilike(projects.code, like))!);
  }
  return db
    .select({
      id: projects.id,
      name: projects.name,
      code: projects.code,
      targetLaunchDate: projects.targetLaunchDate,
      archivedAt: projects.archivedAt,
      clientId: clients.id,
      clientName: clients.name,
      websiteId: websites.id,
      websiteName: websites.name,
      stageKey: projectStages.key,
      stageName: projectStages.name,
      stageKind: projectStages.kind,
      stageRole: projectStages.role,
      overdue,
    })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .innerJoin(websites, eq(websites.id, projects.websiteId))
    .innerJoin(projectStages, currentStageJoin)
    .where(and(...conditions))
    .orderBy(sql`${projects.targetLaunchDate} ASC NULLS LAST`, asc(projects.name))
    .limit(500);
}

export async function getProject(db: DbOrTx, id: string) {
  const [row] = await db
    .select({
      project: projects,
      clientName: clients.name,
      websiteName: websites.name,
      websiteDomain: websites.primaryDomain,
      templateName: stageTemplates.name,
    })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .innerJoin(websites, eq(websites.id, projects.websiteId))
    .innerJoin(stageTemplates, eq(stageTemplates.id, projects.stageTemplateId))
    .where(eq(projects.id, id));
  return row ?? null;
}

/** Live projects per current stage, in workflow order (dashboard). */
export async function projectCountsByStage(db: DbOrTx) {
  return db
    .select({
      key: projectStages.key,
      name: projectStages.name,
      position: sql<number>`min(${projectStages.position})`.mapWith(Number),
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(projects)
    .innerJoin(projectStages, currentStageJoin)
    .where(isNull(projects.archivedAt))
    .groupBy(projectStages.key, projectStages.name)
    .orderBy(sql`min(${projectStages.position})`);
}

/** Distinct stage keys across projects, for the list filter. */
export async function stageFilterOptions(db: DbOrTx) {
  return db
    .select({
      key: projectStages.key,
      name: sql<string>`min(${projectStages.name})`,
      position: sql<number>`min(${projectStages.position})`.mapWith(Number),
    })
    .from(projectStages)
    .groupBy(projectStages.key)
    .orderBy(sql`min(${projectStages.position})`);
}
