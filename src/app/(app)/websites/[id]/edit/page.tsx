import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { getWebsite } from "@/server/records/websites";
import { updateWebsiteAction } from "../../actions";
import { WebsiteForm } from "../../website-form";

export const metadata: Metadata = { title: "Edit website" };

export default async function EditWebsitePage({ params }: PageProps<"/websites/[id]/edit">) {
  await requireSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const row = await getWebsite(db(), id);
  if (!row) notFound();
  const { website, clientName } = row;
  if (website.archivedAt) redirect(`/websites/${id}`);
  return (
    <div className="grid gap-6">
      <PageHeader
        crumbs={[
          { label: "Clients", href: "/clients" },
          { label: clientName, href: `/clients/${website.clientId}` },
          { label: website.name, href: `/websites/${id}` },
          { label: "Edit" },
        ]}
        title={`Edit ${website.name}`}
      />
      <WebsiteForm
        action={updateWebsiteAction.bind(null, id)}
        submitLabel="Save changes"
        initial={{
          name: website.name,
          primaryDomain: website.primaryDomain ?? "",
          status: website.status,
          notes: website.notes ?? "",
        }}
      />
    </div>
  );
}
