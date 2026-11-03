import { describe, expect, it } from "vitest";
import {
  checkGoLiveDeployment,
  inferTransition,
  planGoLive,
  planInitial,
  planUserTransition,
  type DeploymentFact,
  type ProjectStageState,
  type StageView,
  type TransitionContext,
} from "@/server/stages/machine";

// The seeded "Standard website project" template (spec §3.10).
const STEPS: Omit<StageView, "status">[] = [
  { id: "enquiry", key: "enquiry", name: "Enquiry", position: 0, kind: "linear", role: null },
  { id: "discovery", key: "discovery", name: "Discovery", position: 1, kind: "linear", role: null },
  { id: "design", key: "design", name: "Design", position: 2, kind: "linear", role: null },
  { id: "build", key: "build", name: "Build", position: 3, kind: "linear", role: null },
  { id: "client_review", key: "client_review", name: "Client Review", position: 4, kind: "linear", role: null },
  { id: "rtd", key: "ready_to_deploy", name: "Ready to Deploy", position: 5, kind: "linear", role: "ready_to_deploy" },
  { id: "live", key: "live", name: "Live", position: 6, kind: "linear", role: "live" },
  { id: "maintenance", key: "maintenance", name: "Maintenance", position: 7, kind: "linear", role: null },
  { id: "on_hold", key: "on_hold", name: "On Hold", position: 100, kind: "on_hold", role: null },
  { id: "archived", key: "archived", name: "Archived", position: 101, kind: "archived", role: null },
];

function stateAt(
  currentId: string,
  statuses: Record<string, StageView["status"]> = {},
  extra: Partial<ProjectStageState> = {},
): ProjectStageState {
  const currentPos = STEPS.find((s) => s.id === currentId)!.position;
  return {
    stages: STEPS.map((s) => ({
      ...s,
      status:
        statuses[s.id] ??
        (s.id === currentId ? "current" : s.kind === "linear" && s.position < currentPos ? "completed" : "upcoming"),
    })),
    heldFromId: null,
    restoreToId: null,
    ...extra,
  };
}

const noHosting: TransitionContext = { hasIntegrationBackedProductionLink: false, hasInFlightDeploymentWork: false };
const connected: TransitionContext = { ...noHosting, hasIntegrationBackedProductionLink: true };

function apply(state: ProjectStageState, plan: { updates: { id: string; status: StageView["status"] }[] }) {
  const map = Object.fromEntries(state.stages.map((s) => [s.id, s.status]));
  for (const u of plan.updates) map[u.id] = u.status;
  return map;
}

function ok(result: ReturnType<typeof planUserTransition>) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.plan;
}

describe("initial", () => {
  it("starts at the first linear stage by default", () => {
    const stages = stateAt("enquiry").stages.map((s) => ({ ...s, status: "upcoming" as const }));
    const result = planInitial(stages);
    expect(result.ok && result.plan.toId).toBe("enquiry");
  });

  it("can start at a later stage up to Ready to Deploy; earlier ones are skipped", () => {
    const stages = stateAt("enquiry").stages.map((s) => ({ ...s, status: "upcoming" as const }));
    const result = planInitial(stages, "build");
    if (!result.ok) throw new Error(result.error);
    expect(result.plan.toId).toBe("build");
    expect(result.plan.updates).toContainEqual({ id: "enquiry", status: "skipped" });
    expect(result.plan.updates).toContainEqual({ id: "design", status: "skipped" });
  });

  it.each(["live", "maintenance", "on_hold", "nonsense"])("refuses to start at %s", (key) => {
    const stages = stateAt("enquiry").stages.map((s) => ({ ...s, status: "upcoming" as const }));
    expect(planInitial(stages, key).ok).toBe(false);
  });
});

describe("advance", () => {
  it("moves to the next linear stage and completes the current one", () => {
    const state = stateAt("design");
    const plan = ok(planUserTransition(state, { kind: "advance" }, noHosting));
    expect(plan).toMatchObject({ transition: "advance", fromId: "design", toId: "build", reason: null });
    expect(apply(state, plan)).toMatchObject({ design: "completed", build: "current" });
  });

  it("refuses to advance from Ready to Deploy into Live", () => {
    const result = planUserTransition(stateAt("rtd"), { kind: "advance" }, noHosting);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/can't be moved to Live by hand/) });
  });

  it("allows advancing from Live to Maintenance", () => {
    const plan = ok(planUserTransition(stateAt("live"), { kind: "advance" }, connected));
    expect(plan.toId).toBe("maintenance");
  });

  it("refuses to advance past the last stage", () => {
    expect(planUserTransition(stateAt("maintenance"), { kind: "advance" }, noHosting).ok).toBe(false);
  });
});

describe("skip_forward", () => {
  it("requires a reason", () => {
    const result = planUserTransition(stateAt("enquiry"), { kind: "skip_forward", targetId: "build", reason: " " }, noHosting);
    expect(result).toMatchObject({ ok: false, field: "reason" });
  });

  it("marks intermediate stages skipped", () => {
    const state = stateAt("enquiry");
    const plan = ok(planUserTransition(state, { kind: "skip_forward", targetId: "build", reason: "Brief already agreed" }, noHosting));
    expect(apply(state, plan)).toMatchObject({ enquiry: "completed", discovery: "skipped", design: "skipped", build: "current" });
  });

  it("refuses a one-step skip (that's an advance)", () => {
    const result = planUserTransition(stateAt("enquiry"), { kind: "skip_forward", targetId: "discovery", reason: "why not" }, noHosting);
    expect(result.ok).toBe(false);
  });

  it("never lands on Live", () => {
    for (const context of [noHosting, connected]) {
      const result = planUserTransition(stateAt("build"), { kind: "skip_forward", targetId: "live", reason: "launched" }, context);
      expect(result).toMatchObject({ ok: false, field: "targetId" });
    }
  });

  it("can skip over Live when the website has no integration-backed production link; Live is skipped, not completed", () => {
    const state = stateAt("rtd");
    const plan = ok(
      planUserTransition(state, { kind: "skip_forward", targetId: "maintenance", reason: "Deployed by hand" }, noHosting),
    );
    expect(apply(state, plan)).toMatchObject({ rtd: "completed", live: "skipped", maintenance: "current" });
  });

  it("refuses to skip over Live when an integration-backed production link exists (decision 0004)", () => {
    const result = planUserTransition(
      stateAt("rtd"),
      { kind: "skip_forward", targetId: "maintenance", reason: "Deployed by hand" },
      connected,
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/connected production host/) });
  });
});

describe("move_back", () => {
  it("requires a reason and resets later stages to upcoming", () => {
    const state = stateAt("client_review");
    expect(planUserTransition(state, { kind: "move_back", targetId: "design", reason: "" }, noHosting).ok).toBe(false);
    const plan = ok(planUserTransition(state, { kind: "move_back", targetId: "design", reason: "Client wants changes" }, noHosting));
    expect(apply(state, plan)).toMatchObject({ design: "current", build: "upcoming", client_review: "upcoming", enquiry: "completed" });
  });

  it("can move back out of Live and Maintenance", () => {
    expect(ok(planUserTransition(stateAt("live"), { kind: "move_back", targetId: "build", reason: "Phase two" }, connected)).toId).toBe(
      "build",
    );
    expect(
      ok(planUserTransition(stateAt("maintenance"), { kind: "move_back", targetId: "design", reason: "Redesign" }, connected)).toId,
    ).toBe("design");
  });

  it("can't move back onto Live", () => {
    const result = planUserTransition(stateAt("maintenance"), { kind: "move_back", targetId: "live", reason: "relaunch" }, noHosting);
    expect(result).toMatchObject({ ok: false, field: "targetId" });
  });

  it("refuses a forward target", () => {
    expect(planUserTransition(stateAt("design"), { kind: "move_back", targetId: "build", reason: "oops" }, noHosting).ok).toBe(false);
  });
});

describe("hold and resume", () => {
  it("hold needs a reason and records where the project was", () => {
    const state = stateAt("build");
    expect(planUserTransition(state, { kind: "hold", reason: "" }, noHosting).ok).toBe(false);
    const plan = ok(planUserTransition(state, { kind: "hold", reason: "Waiting on content" }, noHosting));
    expect(plan).toMatchObject({ transition: "hold", toId: "on_hold", heldFromId: "build" });
    expect(apply(state, plan)).toMatchObject({ build: "upcoming", on_hold: "current" });
  });

  it("only resume or archive are allowed while on hold", () => {
    const held = stateAt("on_hold", { build: "upcoming" }, { heldFromId: "build" });
    expect(planUserTransition(held, { kind: "advance" }, noHosting)).toMatchObject({ ok: false, error: /on hold/ });
    expect(planUserTransition(held, { kind: "archive", reason: "Cancelled" }, noHosting).ok).toBe(true);
  });

  it("resumes to the held stage without a reason", () => {
    const held = stateAt("on_hold", { build: "upcoming" }, { heldFromId: "build" });
    const plan = ok(planUserTransition(held, { kind: "resume" }, noHosting));
    expect(plan).toMatchObject({ transition: "resume", toId: "build", heldFromId: null });
    expect(apply(held, plan)).toMatchObject({ on_hold: "upcoming", build: "current" });
  });

  it("resuming elsewhere needs a reason and can't target Live", () => {
    const held = stateAt("on_hold", { build: "upcoming" }, { heldFromId: "build" });
    expect(planUserTransition(held, { kind: "resume", targetId: "design" }, noHosting)).toMatchObject({ ok: false, field: "reason" });
    expect(ok(planUserTransition(held, { kind: "resume", targetId: "design", reason: "Rethink" }, noHosting)).toId).toBe("design");
    expect(planUserTransition(held, { kind: "resume", targetId: "live", reason: "Launched" }, noHosting).ok).toBe(false);
  });
});

describe("archive and restore", () => {
  it("archive needs a reason and is refused while deployment work is in flight", () => {
    expect(planUserTransition(stateAt("build"), { kind: "archive", reason: "" }, noHosting).ok).toBe(false);
    expect(
      planUserTransition(stateAt("build"), { kind: "archive", reason: "Cancelled" }, { ...noHosting, hasInFlightDeploymentWork: true }),
    ).toMatchObject({ ok: false, error: /in flight/ });
    expect(ok(planUserTransition(stateAt("build"), { kind: "archive", reason: "Cancelled" }, noHosting))).toMatchObject({
      toId: "archived",
      archive: "set",
    });
  });

  it("an archived project only accepts restore, which returns to the stage it was archived from", () => {
    const archived = stateAt("archived", { build: "upcoming" }, { restoreToId: "build" });
    expect(planUserTransition(archived, { kind: "advance" }, noHosting)).toMatchObject({ ok: false, error: /archived/ });
    const plan = ok(planUserTransition(archived, { kind: "restore", reason: "Back on" }, noHosting));
    expect(plan).toMatchObject({ toId: "build", archive: "clear" });
  });
});

describe("go_live (system only)", () => {
  const goodDeployment: DeploymentFact = {
    id: "d1",
    projectId: "p1",
    environment: "production",
    origin: "provider_observed",
    state: "published",
    confirmationSource: "provider",
    hostingLinkHasIntegration: true,
  };

  it("accepts only a provider-confirmed, published production deploy on an integration-backed link", () => {
    expect(checkGoLiveDeployment("p1", goodDeployment)).toBeNull();
    expect(checkGoLiveDeployment("p1", null)).toMatch(/not found/);
    expect(checkGoLiveDeployment("p1", { ...goodDeployment, projectId: "p2" })).toMatch(/another project/);
    expect(checkGoLiveDeployment("p1", { ...goodDeployment, environment: "preview" })).toMatch(/not a production/);
    expect(checkGoLiveDeployment("p1", { ...goodDeployment, origin: "manual_record" })).toMatch(/manual/);
    expect(checkGoLiveDeployment("p1", { ...goodDeployment, state: "ready" })).toMatch(/not published/);
    expect(checkGoLiveDeployment("p1", { ...goodDeployment, confirmationSource: null })).toMatch(/not confirmed/);
    expect(checkGoLiveDeployment("p1", { ...goodDeployment, hostingLinkHasIntegration: false })).toMatch(/no integration/);
  });

  it("moves Ready to Deploy → Live", () => {
    const result = planGoLive(stateAt("rtd"));
    expect(result).toMatchObject({ ok: true, plan: { transition: "go_live", fromId: "rtd", toId: "live" } });
  });

  it("is a no-op from Live or later (re-deploys)", () => {
    expect(planGoLive(stateAt("live"))).toEqual({ ok: true, plan: null });
    expect(planGoLive(stateAt("maintenance"))).toEqual({ ok: true, plan: null });
  });

  it("is refused before Ready to Deploy, on hold or archived", () => {
    expect(planGoLive(stateAt("build")).ok).toBe(false);
    expect(planGoLive(stateAt("on_hold", {}, { heldFromId: "rtd" })).ok).toBe(false);
    expect(planGoLive(stateAt("archived")).ok).toBe(false);
  });
});

describe("inferTransition", () => {
  it("maps a target stage to the transition the UI means", () => {
    expect(inferTransition(stateAt("design"), "build")).toBe("advance");
    expect(inferTransition(stateAt("design"), "client_review")).toBe("skip_forward");
    expect(inferTransition(stateAt("design"), "enquiry")).toBe("move_back");
    expect(inferTransition(stateAt("design"), "on_hold")).toBe("hold");
    expect(inferTransition(stateAt("design"), "archived")).toBe("archive");
    expect(inferTransition(stateAt("design"), "design")).toBeNull();
    expect(inferTransition(stateAt("on_hold", {}, { heldFromId: "design" }), "design")).toBe("resume");
    expect(inferTransition(stateAt("archived"), "design")).toBe("restore");
  });
});
