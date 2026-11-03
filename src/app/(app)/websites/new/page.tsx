import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { clientOptions } from "@/server/records/clients";
import { createWebsiteAction } from "../actions";
import { WebsiteForm } from "../website-form";

export const metadata: Metadata = { title: "New website" };

export default async function NewWebsitePage({ searchParams }: PageProps<"/websites/new">) {
  await requireSession();
  const { clientId } = await searchParams;
  const clients = await clientOptions(db());
  const preselected = isUuid(clientId) && clients.some((c) => c.id === clientId) ? clientId : "";
  const client = clients.find((c) => c.id === preselected);

  return (
    <div className="grid gap-6">
      <PageHeader
        crumbs={
          client
            ? [
                { label: "Clients", href: "/clients" },
                { label: client.name, href: `/clients/${client.id}` },
                { label: "New website" },
              ]
            : [{ label: "New website" }]
        }
        title="New website"
      />
      {clients.length ? (
        <WebsiteForm
          action={createWebsiteAction}
          clients={clients}
          submitLabel="Create website"
          initial={{ clientId: preselected, name: "", primaryDomain: "", status: "planned", notes: "" }}
        />
      ) : (
        <EmptyState
          icon={Building2}
          title="Add a client first"
          action={
            <Button asChild className="h-9">
              <Link href="/clients/new">New client</Link>
            </Button>
          }
        >
          Every website belongs to a client.
        </EmptyState>
      )}
    </div>
  );
}
