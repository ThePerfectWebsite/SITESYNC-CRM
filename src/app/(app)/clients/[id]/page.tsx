import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Globe, Mail, Pencil, Phone, Plus, Star } from "lucide-react";
import { ActionButton } from "@/components/forms/action-button";
import { Details, PageHeader, Section } from "@/components/page";
import { ActivityFeed, ProjectsTable } from "@/components/records";
import { ArchivedPill, ClientStatus, WebsiteStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { listActivity } from "@/server/records/activity";
import { getClient } from "@/server/records/clients";
import { listContacts } from "@/server/records/contacts";
import { listProjects } from "@/server/records/projects";
import { listWebsitesForClient } from "@/server/records/websites";
import {
  archiveClientAction,
  archiveContactAction,
  createContactAction,
  restoreClientAction,
  restoreContactAction,
  updateContactAction,
} from "../actions";
import { ContactForm } from "../client-forms";

export async function generateMetadata({ params }: PageProps<"/clients/[id]">): Promise<Metadata> {
  const { id } = await params;
  const client = isUuid(id) ? await getClient(db(), id) : null;
  return { title: client?.name ?? "Client" };
}

export default async function ClientPage({ params }: PageProps<"/clients/[id]">) {
  await requireSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const database = db();
  const client = await getClient(database, id);
  if (!client) notFound();

  const [contacts, websites, projects, activity] = await Promise.all([
    listContacts(database, id, true),
    listWebsitesForClient(database, id, true),
    listProjects(database, { clientId: id, includeArchived: true }),
    listActivity(database, { clientId: id }, 20),
  ]);
  const archived = Boolean(client.archivedAt);
  const liveContacts = contacts.filter((c) => !c.archivedAt);
  const archivedContacts = contacts.filter((c) => c.archivedAt);

  return (
    <div className="grid gap-8">
      <PageHeader
        crumbs={[{ label: "Clients", href: "/clients" }, { label: client.name }]}
        title={client.name}
        meta={
          <>
            <ClientStatus status={client.status} />
            {archived ? <ArchivedPill /> : null}
          </>
        }
        actions={
          archived ? (
            <ActionButton action={restoreClientAction.bind(null, id)} label="Restore client" pendingLabel="Restoring…" />
          ) : (
            <>
              <Button asChild variant="outline" className="h-9">
                <Link href={`/clients/${id}/edit`}>
                  <Pencil aria-hidden="true" />
                  Edit
                </Link>
              </Button>
              <ActionButton action={archiveClientAction.bind(null, id)} label="Archive client" pendingLabel="Archiving…" />
            </>
          )
        }
      />

      <Card>
        <CardContent>
          <Details
            items={[
              ["Slug", client.slug],
              ["Notes", client.notes ? <span className="whitespace-pre-wrap">{client.notes}</span> : "—"],
            ]}
          />
        </CardContent>
      </Card>

      <div id="contacts">
        <Section title="Contacts">
          {liveContacts.length ? (
            <ul className="grid gap-3 md:grid-cols-2">
              {liveContacts.map((contact) => (
                <li key={contact.id}>
                  <Card>
                    <CardContent className="grid gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{contact.name}</p>
                        {contact.isPrimary ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-teal">
                            <Star className="size-3.5" aria-hidden="true" />
                            Primary
                          </span>
                        ) : null}
                      </div>
                      {contact.roleTitle ? <p className="text-sm text-muted-foreground">{contact.roleTitle}</p> : null}
                      {contact.email ? (
                        <p className="flex items-center gap-1.5 text-sm">
                          <Mail className="size-3.5 text-muted-foreground" aria-hidden="true" />
                          <a href={`mailto:${contact.email}`} className="hover:underline">
                            {contact.email}
                          </a>
                        </p>
                      ) : null}
                      {contact.phone ? (
                        <p className="flex items-center gap-1.5 text-sm">
                          <Phone className="size-3.5 text-muted-foreground" aria-hidden="true" />
                          {contact.phone}
                        </p>
                      ) : null}
                      {contact.notes ? <p className="text-sm whitespace-pre-wrap text-muted-foreground">{contact.notes}</p> : null}
                      {archived ? null : (
                        <details className="group">
                          <summary className="cursor-pointer text-sm text-primary hover:underline">Edit contact</summary>
                          <div className="mt-3 grid gap-3">
                            <ContactForm
                              idPrefix={`contact-${contact.id}`}
                              action={updateContactAction.bind(null, id, contact.id)}
                              submitLabel="Save contact"
                              initial={{
                                name: contact.name,
                                email: contact.email ?? "",
                                phone: contact.phone ?? "",
                                roleTitle: contact.roleTitle ?? "",
                                notes: contact.notes ?? "",
                                isPrimary: contact.isPrimary,
                              }}
                            />
                            <ActionButton
                              action={archiveContactAction.bind(null, id, contact.id)}
                              label="Archive contact"
                              variant="ghost"
                            />
                          </div>
                        </details>
                      )}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No contacts yet.</p>
          )}
          {archived ? null : (
            <details className="rounded-lg border bg-card p-4">
              <summary className="cursor-pointer text-sm font-medium text-primary">Add a contact</summary>
              <div className="mt-4">
                <ContactForm idPrefix="new-contact" action={createContactAction.bind(null, id)} submitLabel="Add contact" />
              </div>
            </details>
          )}
          {archivedContacts.length ? (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Archived contacts ({archivedContacts.length})
              </summary>
              <ul className="mt-2 grid gap-2">
                {archivedContacts.map((contact) => (
                  <li key={contact.id} className="flex flex-wrap items-center gap-3 text-sm">
                    {contact.name}
                    {archived ? null : (
                      <ActionButton action={restoreContactAction.bind(null, id, contact.id)} label="Restore" variant="ghost" />
                    )}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Section>
      </div>

      <Section
        title="Websites"
        actions={
          archived ? null : (
            <Button asChild variant="outline" className="h-9">
              <Link href={`/websites/new?clientId=${id}`}>
                <Plus aria-hidden="true" />
                Add website
              </Link>
            </Button>
          )
        }
      >
        {websites.length ? (
          <ul className="grid gap-2">
            {websites.map((website) => (
              <li key={website.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-2.5">
                <Globe className="size-4 text-muted-foreground" aria-hidden="true" />
                <Link href={`/websites/${website.id}`} className="font-medium text-primary hover:underline">
                  {website.name}
                </Link>
                {website.primaryDomain ? <span className="text-sm text-muted-foreground">{website.primaryDomain}</span> : null}
                <span className="ml-auto flex gap-1">
                  <WebsiteStatus status={website.status} />
                  {website.archivedAt ? <ArchivedPill /> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No websites yet.</p>
        )}
      </Section>

      <Section
        title="Projects"
        actions={
          archived || !websites.some((w) => !w.archivedAt) ? null : (
            <Button asChild variant="outline" className="h-9">
              <Link href={`/projects/new?clientId=${id}`}>
                <Plus aria-hidden="true" />
                New project
              </Link>
            </Button>
          )
        }
      >
        {projects.length ? (
          <ProjectsTable rows={projects} hideClient />
        ) : (
          <p className="text-sm text-muted-foreground">
            No projects yet.{websites.length ? "" : " Add a website first: every project targets one."}
          </p>
        )}
      </Section>

      <Section title="Activity">
        <ActivityFeed items={activity} />
      </Section>
    </div>
  );
}
