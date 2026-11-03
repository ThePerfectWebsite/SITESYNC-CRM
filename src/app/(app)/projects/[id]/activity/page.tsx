import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/page";
import { ActivityFeed } from "@/components/records";
import { isUuid } from "@/lib/ids";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { listActivity } from "@/server/records/activity";

export const metadata: Metadata = { title: "Project activity" };

function reasonOf(metadata: unknown): string | null {
  if (metadata && typeof metadata === "object" && "reason" in metadata) {
    const reason = (metadata as { reason: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  }
  return null;
}

/** Stage history and every audited change to the project (screen 12). */
export default async function ProjectActivityPage({ params }: PageProps<"/projects/[id]/activity">) {
  await requireSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const events = await listActivity(db(), { projectId: id }, 200);
  return (
    <Section title="Activity">
      <ActivityFeed
        items={events.map((event) => ({ ...event, reason: reasonOf(event.metadata) }))}
        empty="No activity recorded for this project."
      />
    </Section>
  );
}
