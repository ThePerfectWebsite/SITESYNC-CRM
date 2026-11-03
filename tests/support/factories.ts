// Record factories for integration tests (all go through the real services).
import { setupFirstAdmin } from "@/server/auth/service";
import type { Db } from "@/server/db/client";
import type { Actor } from "@/server/records/actor";
import { createClient } from "@/server/records/clients";
import { createProject } from "@/server/records/projects";
import { createWebsite } from "@/server/records/websites";

let counter = 0;
const next = () => ++counter;

export async function createAdmin(db: Db): Promise<Actor> {
  const { userId } = await setupFirstAdmin(db, {
    email: "operator@example.test",
    displayName: "Test Operator",
    password: "a long enough test passphrase",
    confirmPassword: "a long enough test passphrase",
  });
  return { userId };
}

export async function makeClient(db: Db, actor: Actor, name = `Client ${next()}`) {
  return createClient(db, actor, { name });
}

export async function makeWebsite(db: Db, actor: Actor, clientId: string, name = `Website ${next()}`) {
  return createWebsite(db, actor, { clientId, name });
}

type ProjectOverrides = Partial<
  Record<"clientId" | "websiteId" | "name" | "code" | "initialStageKey" | "startDate" | "targetLaunchDate", string>
>;

/** A client, its website and a project on the default template. */
export async function makeProject(db: Db, actor: Actor, overrides: ProjectOverrides = {}) {
  const clientId = overrides.clientId ?? (await makeClient(db, actor));
  const websiteId = overrides.websiteId ?? (await makeWebsite(db, actor, clientId));
  const projectId = await createProject(db, actor, {
    name: `Project ${next()}`,
    ...overrides,
    clientId,
    websiteId,
  });
  return { clientId, websiteId, projectId };
}
