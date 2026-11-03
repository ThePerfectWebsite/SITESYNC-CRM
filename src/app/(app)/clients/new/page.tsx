import type { Metadata } from "next";
import { PageHeader } from "@/components/page";
import { requireSession } from "@/server/auth/next";
import { createClientAction } from "../actions";
import { ClientForm } from "../client-forms";

export const metadata: Metadata = { title: "New client" };

export default async function NewClientPage() {
  await requireSession();
  return (
    <div className="grid gap-6">
      <PageHeader crumbs={[{ label: "Clients", href: "/clients" }, { label: "New client" }]} title="New client" />
      <ClientForm action={createClientAction} submitLabel="Create client" />
    </div>
  );
}
