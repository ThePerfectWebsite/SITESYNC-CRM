import type { Metadata } from "next";
import Link from "next/link";
import { Globe } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { clientOptions } from "@/server/records/clients";
import { defaultTemplateSteps } from "@/server/records/templates";
import { websiteOptions } from "@/server/records/websites";
import { createProjectAction } from "../actions";
import { ProjectForm } from "../project-form";

export const metadata: Metadata = { title: "New project" };

export default async function NewProjectPage({ searchParams }: PageProps<"/projects/new">) {
  await requireSession();
  const params = await searchParams;
  const database = db();
  const [clients, websites, steps] = await Promise.all([
    clientOptions(database),
    websiteOptions(database),
    defaultTemplateSteps(database),
  ]);
  const rtd = steps.find((s) => s.role === "ready_to_deploy");
  const initialStages = steps.filter((s) => s.kind === "linear" && rtd && s.position <= rtd.position);
  const clientId = isUuid(params.clientId) ? params.clientId : "";
  const websiteId = isUuid(params.websiteId) ? params.websiteId : "";

  return (
    <div className="grid gap-6">
      <PageHeader crumbs={[{ label: "Projects", href: "/projects" }, { label: "New project" }]} title="New project" />
      {websites.length ? (
        <ProjectForm
          action={createProjectAction}
          submitLabel="Create project"
          clients={clients.filter((c) => websites.some((w) => w.clientId === c.id))}
          websites={websites}
          initialStages={initialStages}
          initial={{
            clientId,
            websiteId,
            name: "",
            code: "",
            description: "",
            startDate: "",
            targetLaunchDate: "",
          }}
        />
      ) : (
        <EmptyState
          icon={Globe}
          title="Add a website first"
          action={
            <Button asChild className="h-9">
              <Link href={clients.length ? "/websites/new" : "/clients/new"}>
                {clients.length ? "New website" : "New client"}
              </Link>
            </Button>
          }
        >
          Every project targets one of a client&apos;s websites.
        </EmptyState>
      )}
    </div>
  );
}
