// Facts about hosting and deployments that the stage and project services need
// (decision 0007). `databaseDeploymentFacts` reads them from hosting_links and
// deployments (Phase 3b); `noDeploymentsYet` remains for tests that need a
// world with no hosting at all.
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { deployments, hostingLinks, integrations } from "../db/schema";
import type { DeploymentFact } from "./machine";

export interface DeploymentFacts {
  /** The website has a production hosting link backed by an integration. */
  hasIntegrationBackedProductionLink(db: DbOrTx, websiteId: string): Promise<boolean>;
  /** An approval is awaiting confirmation, or a SiteSync deploy is in flight. */
  hasInFlightDeploymentWork(db: DbOrTx, projectId: string): Promise<boolean>;
  /** The project has any deployments row (its website can then no longer change). */
  hasDeployments(db: DbOrTx, projectId: string): Promise<boolean>;
  findDeployment(db: DbOrTx, deploymentId: string): Promise<DeploymentFact | null>;
}

export const noDeploymentsYet: DeploymentFacts = {
  hasIntegrationBackedProductionLink: async () => false,
  hasInFlightDeploymentWork: async () => false,
  hasDeployments: async () => false,
  findDeployment: async () => null,
};

export const databaseDeploymentFacts: DeploymentFacts = {
  async hasIntegrationBackedProductionLink(db, websiteId) {
    const [row] = await db
      .select({ id: hostingLinks.id })
      .from(hostingLinks)
      .innerJoin(integrations, eq(integrations.id, hostingLinks.integrationId))
      .where(
        and(
          eq(hostingLinks.websiteId, websiteId),
          eq(hostingLinks.environment, "production"),
          isNull(hostingLinks.archivedAt),
          isNull(integrations.archivedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  },

  // Approvals arrive in Phase 4; until then, only SiteSync dispatches can be in flight.
  async hasInFlightDeploymentWork(db, projectId) {
    const [row] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, projectId),
          eq(deployments.origin, "sitesync_initiated"),
          inArray(deployments.dispatchState, ["pending", "dispatched", "confirming"]),
        ),
      )
      .limit(1);
    return Boolean(row);
  },

  async hasDeployments(db, projectId) {
    return (await db.$count(deployments, eq(deployments.projectId, projectId))) > 0;
  },

  async findDeployment(db, deploymentId) {
    const [row] = await db
      .select({
        id: deployments.id,
        projectId: deployments.projectId,
        environment: deployments.environment,
        origin: deployments.origin,
        state: deployments.state,
        confirmationSource: deployments.confirmationSource,
        hostingLinkHasIntegration: sql<boolean>`${hostingLinks.integrationId} IS NOT NULL`,
      })
      .from(deployments)
      .innerJoin(hostingLinks, eq(hostingLinks.id, deployments.hostingLinkId))
      .where(and(eq(deployments.id, deploymentId), isNotNull(deployments.id)));
    return row ?? null;
  },
};
