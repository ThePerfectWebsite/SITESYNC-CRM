import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { auditEvents, projects, projectStages, stageHistory, stageTemplateSteps } from "@/server/db/schema";
import type { Actor } from "@/server/records/actor";
import { DomainError } from "@/server/records/errors";
import { createProject, getProject, listProjects, updateProject } from "@/server/records/projects";
import { updateTemplateStep } from "@/server/records/templates";
import { noDeploymentsYet, type DeploymentFacts } from "@/server/stages/deployment-facts";
import type { DeploymentFact, UserTransitionRequest } from "@/server/stages/machine";
import { loadStages, systemGoLive, transitionStage } from "@/server/stages/service";
import { createAdmin, makeClient, makeProductionDeployment, makeProject, makeWebsite } from "../support/factories";
import { appDb, ownerClient, resetTestDatabase } from "../support/test-db";

let db: Db;
let pool: pg.Pool;
let owner: pg.Client;
let actor: Actor;

beforeAll(async () => {
  await resetTestDatabase();
  ({ db, pool } = appDb());
  owner = await ownerClient();
  actor = await createAdmin(db);
});

afterAll(async () => {
  await pool?.end();
  await owner?.end();
});

async function stagesByKey(projectId: string) {
  const stages = await loadStages(db, projectId);
  return Object.fromEntries(stages.map((s) => [s.key, s]));
}

async function current(projectId: string) {
  const stages = await loadStages(db, projectId);
  return stages.find((s) => s.status === "current")!;
}

/** Moves a project via the service, using its current stage as the expected one. */
async function move(projectId: string, request: UserTransitionRequest, facts?: DeploymentFacts) {
  const from = await current(projectId);
  return transitionStage(db, actor, { projectId, expectedCurrentStageId: from.id, request }, { facts });
}

async function skipTo(projectId: string, key: string) {
  const target = (await stagesByKey(projectId))[key]!;
  return move(projectId, { kind: "skip_forward", targetId: target.id, reason: "test setup" });
}

const history = (projectId: string) =>
  db.select().from(stageHistory).where(eq(stageHistory.projectId, projectId));

describe("composite FK: a project's website belongs to its client (decision 0001)", () => {
  it("the database rejects a cross-client website", async () => {
    const { projectId, clientId } = await makeProject(db, actor);
    const otherClient = await makeClient(db, actor);
    const otherWebsite = await makeWebsite(db, actor, otherClient);
    await expect(
      pool.query("UPDATE projects SET website_id = $1 WHERE id = $2", [otherWebsite, projectId]),
    ).rejects.toMatchObject({ code: "23503", constraint: "projects_website_same_client_fk" });
    const project = await getProject(db, projectId);
    expect(project?.project.clientId).toBe(clientId);
  });

  it("the service refuses it with a friendly field error, on create and on update", async () => {
    const clientA = await makeClient(db, actor);
    const clientB = await makeClient(db, actor);
    const websiteB = await makeWebsite(db, actor, clientB);
    await expect(
      createProject(db, actor, { name: "Cross", clientId: clientA, websiteId: websiteB }),
    ).rejects.toMatchObject({ fieldErrors: { websiteId: "This website belongs to a different client." } });

    const { projectId } = await makeProject(db, actor, { clientId: clientA });
    await expect(
      updateProject(db, actor, projectId, { name: "Moved", websiteId: websiteB }),
    ).rejects.toMatchObject({ fieldErrors: { websiteId: "This website belongs to a different client." } });
  });

  it("a website can change to another of the same client's, but not once deployments exist", async () => {
    const { projectId, clientId } = await makeProject(db, actor);
    const second = await makeWebsite(db, actor, clientId);
    const withDeployments: DeploymentFacts = { ...noDeploymentsYet, hasDeployments: async () => true };
    await expect(
      updateProject(db, actor, projectId, { name: "P", websiteId: second }, withDeployments),
    ).rejects.toMatchObject({ fieldErrors: { websiteId: expect.stringMatching(/deployments/) } });
    await updateProject(db, actor, projectId, { name: "P", websiteId: second });
    expect((await getProject(db, projectId))?.project.websiteId).toBe(second);
  });
});

describe("project creation", () => {
  it("copies the template's steps and records the initial stage in history and audit", async () => {
    const { projectId } = await makeProject(db, actor);
    const stages = await loadStages(db, projectId);
    expect(stages.map((s) => s.key)).toEqual([
      "enquiry", "discovery", "design", "build", "client_review", "ready_to_deploy", "live", "maintenance", "on_hold", "archived",
    ]);
    expect(stages.filter((s) => s.status === "current").map((s) => s.key)).toEqual(["enquiry"]);
    const rows = await history(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ transition: "initial", fromProjectStageId: null, actorType: "user" });
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.id, rows[0]!.auditEventId));
    expect(audit).toMatchObject({ action: "project.created", projectId });
  });

  it("can start at a later stage, but not past Ready to Deploy", async () => {
    const { projectId } = await makeProject(db, actor, { initialStageKey: "build" });
    expect((await current(projectId)).key).toBe("build");
    await expect(makeProject(db, actor, { initialStageKey: "live" })).rejects.toBeInstanceOf(DomainError);
  });
});

describe("stage transitions", () => {
  it("advance updates statuses, timestamps, history and audit together", async () => {
    const { projectId } = await makeProject(db, actor);
    await move(projectId, { kind: "advance" });
    const stages = await stagesByKey(projectId);
    expect(stages.enquiry!.status).toBe("completed");
    expect(stages.discovery!.status).toBe("current");
    const [row] = await db
      .select()
      .from(projectStages)
      .where(and(eq(projectStages.projectId, projectId), eq(projectStages.key, "discovery")));
    expect(row!.enteredAt).toBeInstanceOf(Date);

    const rows = await history(projectId);
    const advance = rows.find((r) => r.transition === "advance")!;
    expect(advance).toMatchObject({ fromProjectStageId: stages.enquiry!.id, toProjectStageId: stages.discovery!.id, actorUserId: actor.userId });
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.id, advance.auditEventId));
    expect(audit).toMatchObject({ action: "project.stage_changed", metadata: { transition: "advance", from: "enquiry", to: "discovery" } });
  });

  it("refuses a stale expected stage (optimistic concurrency)", async () => {
    const { projectId } = await makeProject(db, actor);
    const before = await current(projectId);
    await move(projectId, { kind: "advance" });
    await expect(
      transitionStage(db, actor, { projectId, expectedCurrentStageId: before.id, request: { kind: "advance" } }),
    ).rejects.toMatchObject({ code: "stale" });
  });

  it("refuses invalid transitions without changing anything", async () => {
    const { projectId } = await makeProject(db, actor);
    const stages = await stagesByKey(projectId);
    await expect(move(projectId, { kind: "move_back", targetId: stages.enquiry!.id, reason: "back" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(move(projectId, { kind: "skip_forward", targetId: stages.build!.id, reason: "" })).rejects.toMatchObject({
      fieldErrors: { reason: expect.any(String) },
    });
    expect((await current(projectId)).key).toBe("enquiry");
    expect(await history(projectId)).toHaveLength(1);
  });

  it("a user can never move a project to Live, by any transition", async () => {
    const { projectId } = await makeProject(db, actor, { initialStageKey: "ready_to_deploy" });
    const live = (await stagesByKey(projectId)).live!;
    await expect(move(projectId, { kind: "advance" })).rejects.toBeInstanceOf(DomainError);
    await expect(move(projectId, { kind: "skip_forward", targetId: live.id, reason: "go live" })).rejects.toBeInstanceOf(
      DomainError,
    );
    await skipTo(projectId, "maintenance");
    // Moving *back* onto Live from Maintenance is refused too.
    await expect(move(projectId, { kind: "move_back", targetId: live.id, reason: "go live" })).rejects.toMatchObject({
      fieldErrors: { targetId: expect.stringMatching(/Live can't be chosen/) },
    });
    // Holding at Maintenance and resuming elsewhere can't land on Live either.
    await move(projectId, { kind: "hold", reason: "Pause" });
    await expect(move(projectId, { kind: "resume", targetId: live.id, reason: "resume at live" })).rejects.toBeInstanceOf(
      DomainError,
    );
    expect((await stagesByKey(projectId)).live!.status).toBe("skipped");
  });

  it("skipping over Live: allowed without an integration-backed production link (Live becomes skipped), refused with one", async () => {
    const a = await makeProject(db, actor, { initialStageKey: "ready_to_deploy" });
    await skipTo(a.projectId, "maintenance");
    const stagesA = await stagesByKey(a.projectId);
    expect(stagesA.live!.status).toBe("skipped");
    expect(stagesA.maintenance!.status).toBe("current");

    const b = await makeProject(db, actor, { initialStageKey: "ready_to_deploy" });
    const connected: DeploymentFacts = { ...noDeploymentsYet, hasIntegrationBackedProductionLink: async () => true };
    const maintenance = (await stagesByKey(b.projectId)).maintenance!;
    await expect(
      move(b.projectId, { kind: "skip_forward", targetId: maintenance.id, reason: "Deployed by hand" }, connected),
    ).rejects.toMatchObject({ message: expect.stringMatching(/connected production host/) });
  });

  it("hold records the held-from stage; resume returns to it", async () => {
    const { projectId } = await makeProject(db, actor, { initialStageKey: "build" });
    await move(projectId, { kind: "hold", reason: "Waiting on content" });
    const build = (await stagesByKey(projectId)).build!;
    expect((await current(projectId)).key).toBe("on_hold");
    expect((await getProject(db, projectId))?.project.heldFromProjectStageId).toBe(build.id);
    await move(projectId, { kind: "resume" });
    expect((await current(projectId)).key).toBe("build");
    expect((await getProject(db, projectId))?.project.heldFromProjectStageId).toBeNull();
  });
});

describe("Live via the system path only (decision 0004)", () => {
  const deployment = (projectId: string, overrides: Partial<DeploymentFact> = {}): DeploymentFact => ({
    id: "00000000-0000-4000-8000-000000000001",
    projectId,
    environment: "production",
    origin: "provider_observed",
    state: "published",
    confirmationSource: "provider",
    hostingLinkHasIntegration: true,
    ...overrides,
  });
  const factsWith = (fact: DeploymentFact): DeploymentFacts => ({ ...noDeploymentsYet, findDeployment: async () => fact });

  it("with Phase 1's facts (no deployments exist) go_live is always refused", async () => {
    const { projectId } = await makeProject(db, actor, { initialStageKey: "ready_to_deploy" });
    await expect(
      systemGoLive(db, { projectId, deploymentId: "00000000-0000-4000-8000-000000000001" }),
    ).rejects.toMatchObject({ message: /deployment not found/ });
  });

  it("refuses manual-record and non-provider-confirmed deployments", async () => {
    const { projectId } = await makeProject(db, actor, { initialStageKey: "ready_to_deploy" });
    const id = "00000000-0000-4000-8000-000000000001";
    for (const fact of [
      deployment(projectId, { origin: "manual_record", confirmationSource: null }),
      deployment(projectId, { confirmationSource: null }),
      deployment(projectId, { hostingLinkHasIntegration: false }),
      deployment(projectId, { state: "failed" }),
    ]) {
      await expect(systemGoLive(db, { projectId, deploymentId: id }, { facts: factsWith(fact) })).rejects.toBeInstanceOf(
        DomainError,
      );
    }
    expect((await current(projectId)).key).toBe("ready_to_deploy");
  });

  it("a provider-confirmed production deploy moves Ready to Deploy → Live, as the system, with the deployment recorded", async () => {
    const { projectId, websiteId } = await makeProject(db, actor, { initialStageKey: "ready_to_deploy" });
    const { deploymentId } = await makeProductionDeployment(db, actor, websiteId);
    const fact = deployment(projectId, { id: deploymentId });
    await expect(systemGoLive(db, { projectId, deploymentId: fact.id }, { facts: factsWith(fact) })).resolves.toEqual({
      moved: true,
    });
    const stages = await stagesByKey(projectId);
    expect(stages.ready_to_deploy!.status).toBe("completed");
    expect(stages.live!.status).toBe("current");
    const goLive = (await history(projectId)).find((r) => r.transition === "go_live");
    expect(goLive).toMatchObject({ actorType: "system", actorUserId: null, deploymentId: fact.id });

    // A later re-deploy confirms without moving the stage.
    await expect(systemGoLive(db, { projectId, deploymentId: fact.id }, { facts: factsWith(fact) })).resolves.toEqual({
      moved: false,
    });
  });

  it("the database refuses a go_live history row from a user, or any user row without a user id", async () => {
    const { projectId } = await makeProject(db, actor);
    const [row] = await history(projectId);
    const insert = (transition: string, actorType: string, actorUserId: string | null, deploymentId: string | null) =>
      pool.query(
        `INSERT INTO stage_history (project_id, to_project_stage_id, transition, actor_type, actor_user_id, deployment_id, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [projectId, row!.toProjectStageId, transition, actorType, actorUserId, deploymentId, row!.auditEventId],
      );
    await expect(insert("go_live", "user", actor.userId, "00000000-0000-4000-8000-000000000001")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insert("go_live", "system", null, null)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("advance", "system", null, null)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("atomicity", () => {
  it("a failure after the history insert leaves stages, audit and history untouched", async () => {
    const { projectId } = await makeProject(db, actor);
    const before = await loadStages(db, projectId);
    const auditCount = await db.$count(auditEvents, eq(auditEvents.projectId, projectId));
    const from = before.find((s) => s.status === "current")!;
    await expect(
      transitionStage(
        db,
        actor,
        { projectId, expectedCurrentStageId: from.id, request: { kind: "advance" } },
        {
          afterHistoryInsert: async () => {
            throw new Error("injected failure");
          },
        },
      ),
    ).rejects.toThrow("injected failure");
    expect(await loadStages(db, projectId)).toEqual(before);
    expect(await db.$count(auditEvents, eq(auditEvents.projectId, projectId))).toBe(auditCount);
    expect(await history(projectId)).toHaveLength(1);
  });

  it("the same holds for the system go_live path", async () => {
    const { projectId, websiteId } = await makeProject(db, actor, { initialStageKey: "ready_to_deploy" });
    const before = await loadStages(db, projectId);
    const { deploymentId } = await makeProductionDeployment(db, actor, websiteId);
    const fact = {
      id: deploymentId,
      projectId,
      environment: "production" as const,
      origin: "provider_observed" as const,
      state: "published",
      confirmationSource: "provider" as const,
      hostingLinkHasIntegration: true,
    };
    await expect(
      systemGoLive(
        db,
        { projectId, deploymentId: fact.id },
        {
          facts: { ...noDeploymentsYet, findDeployment: async () => fact },
          afterHistoryInsert: async () => {
            throw new Error("injected failure");
          },
        },
      ),
    ).rejects.toThrow("injected failure");
    expect(await loadStages(db, projectId)).toEqual(before);
  });
});

describe("exactly one current stage", () => {
  it("the unique index rejects a second current stage", async () => {
    const { projectId } = await makeProject(db, actor);
    await expect(
      pool.query("UPDATE project_stages SET status = 'current' WHERE project_id = $1 AND key = 'design'", [projectId]),
    ).rejects.toMatchObject({ code: "23505", constraint: "project_stages_one_current_key" });
  });

  it("the deferred trigger rejects a project with no current stage at commit", async () => {
    const { projectId } = await makeProject(db, actor);
    await expect(
      pool.query("UPDATE project_stages SET status = 'upcoming' WHERE project_id = $1 AND status = 'current'", [projectId]),
    ).rejects.toThrow(/must have exactly one current stage/);
    expect((await current(projectId)).key).toBe("enquiry");
  });
});

describe("stage_history is append-only", () => {
  it("rejects UPDATE, DELETE and TRUNCATE by trigger (owner) and by grants (runtime role)", async () => {
    const { projectId } = await makeProject(db, actor);
    await expect(owner.query("UPDATE stage_history SET reason = 'x' WHERE project_id = $1", [projectId])).rejects.toThrow(
      /append-only table: UPDATE is not permitted/,
    );
    await expect(owner.query("DELETE FROM stage_history WHERE project_id = $1", [projectId])).rejects.toThrow(
      /append-only table: DELETE is not permitted/,
    );
    await expect(owner.query("TRUNCATE stage_history CASCADE")).rejects.toThrow(/append-only table: TRUNCATE/);
    await expect(pool.query("UPDATE stage_history SET reason = 'x'")).rejects.toThrow(/permission denied/);
    await expect(pool.query("DELETE FROM stage_history")).rejects.toThrow(/permission denied/);
  });

  it("the runtime role can't delete core records either (archive, don't delete)", async () => {
    await expect(pool.query("DELETE FROM projects")).rejects.toThrow(/permission denied/);
    await expect(pool.query("DELETE FROM clients")).rejects.toThrow(/permission denied/);
  });
});

describe("archive and restore", () => {
  it("archiving hides the project by default; restoring returns it to the stage it left", async () => {
    const { projectId } = await makeProject(db, actor, { initialStageKey: "design", code: "ARCH-1" });
    await move(projectId, { kind: "archive", reason: "Client paused indefinitely" });
    const archived = await getProject(db, projectId);
    expect(archived?.project.archivedAt).toBeInstanceOf(Date);
    expect(archived?.project.archivedBy).toBe(actor.userId);
    expect((await listProjects(db)).map((p) => p.id)).not.toContain(projectId);
    expect((await listProjects(db, { includeArchived: true })).map((p) => p.id)).toContain(projectId);
    await expect(updateProject(db, actor, projectId, { name: "x", websiteId: archived!.project.websiteId })).rejects.toMatchObject({
      code: "conflict",
    });

    await move(projectId, { kind: "restore", reason: "Client is back" });
    expect((await current(projectId)).key).toBe("design");
    expect((await getProject(db, projectId))?.project.archivedAt).toBeNull();
  });

  it("archiving from On Hold restores back to On Hold with the held-from stage intact", async () => {
    const { projectId } = await makeProject(db, actor, { initialStageKey: "build" });
    await move(projectId, { kind: "hold", reason: "Budget review" });
    await move(projectId, { kind: "archive", reason: "Cancelled" });
    await move(projectId, { kind: "restore", reason: "Uncancelled" });
    expect((await current(projectId)).key).toBe("on_hold");
    await move(projectId, { kind: "resume" });
    expect((await current(projectId)).key).toBe("build");
  });

  it("restore is refused if another live project took the code meanwhile", async () => {
    const first = await makeProject(db, actor, { code: "DUP-1" });
    await move(first.projectId, { kind: "archive", reason: "Replaced" });
    await makeProject(db, actor, { code: "DUP-1" });
    await expect(move(first.projectId, { kind: "restore", reason: "Oops" })).rejects.toMatchObject({ code: "conflict" });
    expect((await current(first.projectId)).key).toBe("archived");
  });
});

describe("templates", () => {
  it("editing a template step doesn't change existing projects (decision 0003)", async () => {
    const { projectId: existing } = await makeProject(db, actor);
    const [step] = await db.select().from(stageTemplateSteps).where(eq(stageTemplateSteps.key, "build"));
    await updateTemplateStep(db, actor, step!.id, { name: "Development" });

    expect((await stagesByKey(existing)).build!.name).toBe("Build");
    const { projectId: fresh } = await makeProject(db, actor);
    expect((await stagesByKey(fresh)).build!.name).toBe("Development");
    await updateTemplateStep(db, actor, step!.id, { name: "Build" });
  });

  it("the deferred trigger refuses a template without a Live step", async () => {
    await expect(owner.query("UPDATE stage_template_steps SET role = NULL WHERE role = 'live'")).rejects.toThrow(
      /stage template .* is invalid/,
    );
  });

  it("the seed created exactly one default template", async () => {
    const result = await owner.query("SELECT count(*)::int AS n FROM stage_templates WHERE is_default");
    expect(result.rows[0].n).toBe(1);
  });
});

describe("project list", () => {
  it("filters by stage, client and overdue", async () => {
    const { projectId: late, clientId } = await makeProject(db, actor, { targetLaunchDate: "2020-01-31", startDate: "2020-01-01" });
    const { projectId: onTime } = await makeProject(db, actor, { targetLaunchDate: "2999-01-01" });
    const { projectId: lateButLive } = await makeProject(db, actor, {
      targetLaunchDate: "2020-01-31",
      initialStageKey: "ready_to_deploy",
    });
    await skipTo(lateButLive, "maintenance");

    const overdue = (await listProjects(db, { overdue: true, today: "2026-11-03" })).map((p) => p.id);
    expect(overdue).toContain(late);
    expect(overdue).not.toContain(onTime);
    expect(overdue).not.toContain(lateButLive);

    expect((await listProjects(db, { clientId })).map((p) => p.id)).toEqual([late]);
    const inMaintenance = await listProjects(db, { stageKey: "maintenance" });
    expect(inMaintenance.map((p) => p.id)).toContain(lateButLive);
    expect(inMaintenance.every((p) => p.stageKey === "maintenance")).toBe(true);
    expect(await db.select().from(projects).where(eq(projects.id, late))).toHaveLength(1);
  });
});
