import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { getClient } from "@/server/records/clients";
import { updateClientAction } from "../../actions";
import { ClientForm } from "../../client-forms";

export const metadata: Metadata = { title: "Edit client" };

export default async function EditClientPage({ params }: PageProps<"/clients/[id]/edit">) {
  await requireSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const client = await getClient(db(), id);
  if (!client) notFound();
  if (client.archivedAt) redirect(`/clients/${id}`);
  return (
    <div className="grid gap-6">
      <PageHeader
        crumbs={[
          { label: "Clients", href: "/clients" },
          { label: client.name, href: `/clients/${id}` },
          { label: "Edit" },
        ]}
        title={`Edit ${client.name}`}
      />
      <ClientForm
        action={updateClientAction.bind(null, id)}
        submitLabel="Save changes"
        initial={{ name: client.name, slug: client.slug, status: client.status, notes: client.notes ?? "" }}
      />
    </div>
  );
}
