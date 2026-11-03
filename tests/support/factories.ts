// Record factories for integration tests (all go through the real services).
import { setupFirstAdmin } from "@/server/auth/service";
import type { Db } from "@/server/db/client";
import type { Actor } from "@/server/records/actor";
import { createClient } from "@/server/records/clients";
import { createProject } from "@/server/records/projects";
import { createWebsite } from "@/server/records/websites";
import { deployments } from "@/server/db/schema";
import { createHostingLink } from "@/server/integrations/hosting-sync";
import { createIntegration } from "@/server/integrations/service";

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

let hostCounter = 0;

/**
 * A provider-observed, published production deployment on an integration-backed
 * Cloudflare Pages link for the website (creating the integration and link).
 */
export async function makeProductionDeployment(db: Db, actor: Actor, websiteId: string, overrides: { id?: string } = {}) {
  hostCounter++;
  const integrationId = await createIntegration(db, actor, {
    provider: "cloudflare",
    name: `Cloudflare ${hostCounter}`,
    tokenEnvVar: "TEST_CLOUDFLARE_TOKEN",
    accountRef: "0123456789abcdef0123456789abcdef",
  });
  const hostingLinkId = await createHostingLink(db, actor, websiteId, {
    integrationId,
    providerProjectId: `site-${hostCounter}`,
    environment: "production",
  });
  const [row] = await db
    .insert(deployments)
    .values({
      ...(overrides.id ? { id: overrides.id } : {}),
      hostingLinkId,
      websiteId,
      provider: "cloudflare",
      providerDeploymentId: `deploy-${hostCounter}`,
      environment: "production",
      origin: "provider_observed",
      state: "published",
      confirmationSource: "provider",
      publishedAt: new Date(),
    })
    .returning({ id: deployments.id });
  return { deploymentId: row!.id, hostingLinkId, integrationId };
}

/** A manual production hosting record (no integration): enough to clear `hosting:missing`. */
export async function makeManualProductionHost(db: Db, actor: Actor, websiteId: string) {
  return createHostingLink(db, actor, websiteId, { provider: "other", environment: "production" });
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
