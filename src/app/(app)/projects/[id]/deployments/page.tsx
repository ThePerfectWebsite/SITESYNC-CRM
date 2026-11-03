import type { Metadata } from "next";
import Link from "next/link";
import { Rocket } from "lucide-react";
import { DeploymentsTable } from "@/components/deployments";
import { EmptyState, Section } from "@/components/page";
import { listDeploymentsForWebsite } from "@/server/integrations/hosting-sync";
import { loadProjectTab } from "../load";

export const metadata: Metadata = { title: "Project deployments" };

// Screen 13: deploys of the project's website, newest first. Deploys the
// operator attributed to this project (e.g. via "mark Live") are labelled.
export default async function ProjectDeploymentsPage({ params }: PageProps<"/projects/[id]/deployments">) {
  const { id, database, row } = await loadProjectTab(params);
  const rows = await listDeploymentsForWebsite(database, row.project.websiteId, 50);
  return (
    <Section title="Deployments">
      <p className="text-sm text-muted-foreground">
        Deploys of{" "}
        <Link href={`/websites/${row.project.websiteId}`} className="text-primary hover:underline">
          {row.websiteName}
        </Link>
        , as last reported by its host. SiteSync never deploys anything itself in this version.
      </p>
      {rows.length ? (
        <DeploymentsTable rows={rows} highlightProjectId={id} />
      ) : (
        <EmptyState icon={Rocket} title="No deployments">
          Link this website to Cloudflare Pages, Netlify or Vercel on its page to see deploys here.
        </EmptyState>
      )}
    </Section>
  );
}
