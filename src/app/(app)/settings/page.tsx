import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import packageJson from "../../../../package.json";
import { FormMessage } from "@/components/forms/controls";
import { Details, PageHeader, Section } from "@/components/page";
import { StagePill } from "@/components/status";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth/next";
import { getSessionPolicy } from "@/server/auth/policy";
import { db } from "@/server/db";
import { appSettings } from "@/server/db/schema";
import { env } from "@/server/env";
import { getChecklistTemplate } from "@/server/records/checklist";
import { getAppTimeZone } from "@/server/records/dates";
import { listTemplates } from "@/server/records/templates";
import { saveChecklistTemplateAction, saveTimeZoneAction } from "./actions";
import { ChecklistTemplateForm, TimeZoneForm } from "./settings-forms";

export const metadata: Metadata = { title: "Settings" };

function lastBackup(value: unknown): { at: string; file: string } | null {
  if (value && typeof value === "object" && "at" in value && "file" in value) {
    const { at, file } = value as { at: unknown; file: unknown };
    if (typeof at === "string" && typeof file === "string") return { at, file };
  }
  return null;
}

// Screen 19: workflow templates (read-only until a later phase), the release
// checklist template, time zone, and system information.
export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  await requireSession();
  const database = db();
  const { saved } = await searchParams;
  const [templates, policy, backupRows, checklistTemplate, timeZone] = await Promise.all([
    listTemplates(database),
    getSessionPolicy(database),
    database.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "backup.last_run")),
    getChecklistTemplate(database),
    getAppTimeZone(database),
  ]);
  const backup = lastBackup(backupRows[0]?.value);
  const config = env();

  return (
    <div className="grid gap-8">
      <PageHeader crumbs={[{ label: "Settings" }]} title="Settings" />
      {saved === "checklist" ? <FormMessage tone="success" message="Release checklist template saved." /> : null}
      {saved === "timezone" ? <FormMessage tone="success" message="Time zone saved." /> : null}

      <Section title="Workflow templates">
        <p className="text-sm text-muted-foreground">
          New projects copy their template&apos;s stages, so changing a template never alters existing projects. Editing
          templates arrives in a later phase.
        </p>
        {templates.map((template) => (
          <Card key={template.id}>
            <CardContent className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{template.name}</h3>
                {template.isDefault ? <span className="text-xs text-muted-foreground">Default</span> : null}
              </div>
              {template.description ? <p className="text-sm text-muted-foreground">{template.description}</p> : null}
              <ol className="flex flex-wrap gap-1.5" aria-label={`${template.name} stages`}>
                {template.steps.map((step) => (
                  <li key={step.id}>
                    <StagePill name={step.name} kind={step.kind} role={step.role} />
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        ))}
      </Section>

      <Section title="System">
        <Card>
          <CardContent>
            <Details
              items={[
                ["Version", packageJson.version],
                [
                  "Network mode",
                  config.lanMode
                    ? `LAN mode via ${config.appOrigin} (HTTPS reverse proxy)`
                    : "Local only (127.0.0.1)",
                ],
                ["Session lifetime", `${policy.idleMinutes / 60} h idle, ${policy.absoluteHours} h maximum`],
                ["Last backup", backup ? `${formatDateTime(backup.at)} (${backup.file})` : "Never. Run npm run db:backup."],
              ]}
            />
          </CardContent>
        </Card>
      </Section>

      <Section title="Release checklist template">
        <Card>
          <CardContent>
            <ChecklistTemplateForm action={saveChecklistTemplateAction} items={checklistTemplate} />
          </CardContent>
        </Card>
      </Section>

      <Section title="Time zone">
        <TimeZoneForm action={saveTimeZoneAction} current={timeZone} />
      </Section>
    </div>
  );
}
