// Facts about hosting and deployments that the stage and project services need
// (decision 0007). hosting_links, deployments and production_approvals arrive
// in Phases 3b/4; until then there are none, so every answer is "no".
import type { DbOrTx } from "../db/client";
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
