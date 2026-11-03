import type { Metadata } from "next";
import { CircleCheck, CircleDashed, CircleX, PlugZap, TriangleAlert } from "lucide-react";
import { ActionButton } from "@/components/forms/action-button";
import { FormMessage } from "@/components/forms/controls";
import { Details, EmptyState, PageHeader, Section } from "@/components/page";
import { IntegrationHealth, StatusPill } from "@/components/status";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth/next";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { envVarStatus, listIntegrations } from "@/server/integrations/service";
import { listWebhookDeliveries } from "@/server/integrations/webhooks";
import { jobsRunning } from "@/server/jobs/runtime";
import {
  archiveIntegrationAction,
  createIntegrationAction,
  disableIntegrationAction,
  enableIntegrationAction,
  replayDeliveryAction,
  testIntegrationAction,
  updateIntegrationAction,
} from "./actions";
import { IntegrationForm } from "./integration-form";

export const metadata: Metadata = { title: "Integrations" };

const NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  created: { tone: "success", text: "Integration added. Test the connection next." },
  saved: { tone: "success", text: "Integration saved." },
  ok: { tone: "success", text: "Connection test passed." },
  failed: { tone: "error", text: "Connection test failed. See the integration's health below." },
  replayed: { tone: "success", text: "Delivery queued for processing again." },
};

function EnvVarState({ name, set }: { name: string; set: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <code className="font-mono text-xs">{name}</code>
      {set ? (
        <StatusPill icon={CircleCheck} label="set" tone="success" />
      ) : (
        <StatusPill icon={CircleDashed} label="not set" tone="warning" />
      )}
    </span>
  );
}

// Screen 17 (basic): integrations with health, last sync and errors, test and
// enable/disable, plus the webhook inbox with replay for dead letters.
export default async function IntegrationsPage({ searchParams }: PageProps<"/integrations">) {
  await requireSession();
  const params = await searchParams;
  const database = db();
  const [rows, deliveries] = await Promise.all([listIntegrations(database), listWebhookDeliveries(database, 50)]);
  const notice = NOTICES[String(params.created ? "created" : params.saved ? "saved" : params.tested ?? (params.replayed ? "replayed" : ""))];
  const origin = env().appOrigin;

  return (
    <div className="grid gap-8">
      <PageHeader crumbs={[{ label: "Integrations" }]} title="Integrations" />
      {notice ? <FormMessage tone={notice.tone} message={notice.text} /> : null}

      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          <strong>SiteSync can&apos;t stop a hosting provider from auto-deploying to production on push or merge.</strong> If
          auto-publishing is on, code merged to the production branch can go live without SiteSync&apos;s approval. Lock
          auto-publishing on the provider to make the approval gate meaningful (Netlify and Vercel arrive in the next phase).
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        GitHub is read only: SiteSync reads commits, pull requests and checks and never writes to your repositories.
        Background jobs are {jobsRunning() ? "running" : "not running in this process, so refreshes run immediately instead"}.
      </p>

      <Section title="GitHub">
        {rows.length === 0 ? (
          <EmptyState icon={PlugZap} title="No integrations yet">
            Everything works without one. Add GitHub to show commits, pull requests and checks, and to count failing
            checks in release readiness.
          </EmptyState>
        ) : (
          <ul className="grid gap-4">
            {rows.map((row) => {
              const vars = envVarStatus(row);
              const disabled = row.health === "disabled";
              return (
                <li key={row.id} id={`integration-${row.id}`}>
                  <Card>
                    <CardContent className="grid gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold">{row.name}</h3>
                        <IntegrationHealth health={row.health} />
                      </div>
                      {row.healthDetail ? <p className="text-sm text-muted-foreground">{row.healthDetail}</p> : null}
                      <Details
                        items={[
                          ["Token", <EnvVarState key="t" name={row.tokenEnvVar} set={vars.tokenSet} />],
                          ["Account", row.accountRef ?? "—"],
                          ["Last test", formatDateTime(row.lastTestedAt)],
                          ["Last successful sync", formatDateTime(row.lastSyncSucceededAt)],
                          ["Last error", row.lastError ? `${formatDateTime(row.lastErrorAt)}: ${row.lastError}` : "—"],
                          [
                            "Rate limit",
                            row.rateLimitRemaining !== null
                              ? `${row.rateLimitRemaining} of ${row.rateLimitLimit ?? "?"} left${row.rateLimitResetAt ? `, resets ${formatDateTime(row.rateLimitResetAt)}` : ""}`
                              : "—",
                          ],
                          ["Polling", row.pollEnabled ? "On" : "Off"],
                          [
                            "Webhooks",
                            row.webhookEnabled ? (
                              <span key="w" className="grid gap-1">
                                <code className="font-mono text-xs break-all">{`${origin}/api/webhooks/github/${row.id}`}</code>
                                {row.webhookSecretEnvVar ? (
                                  <EnvVarState name={row.webhookSecretEnvVar} set={Boolean(vars.webhookSecretSet)} />
                                ) : null}
                              </span>
                            ) : (
                              "Off"
                            ),
                          ],
                        ]}
                      />
                      <div className="flex flex-wrap gap-2">
                        {disabled ? null : (
                          <ActionButton action={testIntegrationAction.bind(null, row.id)} label="Test connection" pendingLabel="Testing…" />
                        )}
                        {disabled ? (
                          <ActionButton action={enableIntegrationAction.bind(null, row.id)} label="Enable" />
                        ) : (
                          <ActionButton action={disableIntegrationAction.bind(null, row.id)} label="Disable" variant="ghost" />
                        )}
                        <ActionButton action={archiveIntegrationAction.bind(null, row.id)} label="Archive" variant="ghost" />
                      </div>
                      <details>
                        <summary className="cursor-pointer text-sm text-primary hover:underline">Edit settings</summary>
                        <div className="mt-3">
                          <IntegrationForm
                            idPrefix={`integration-${row.id}`}
                            action={updateIntegrationAction.bind(null, row.id)}
                            submitLabel="Save integration"
                            initial={{
                              name: row.name,
                              tokenEnvVar: row.tokenEnvVar,
                              accountRef: row.accountRef ?? "",
                              webhookSecretEnvVar: row.webhookSecretEnvVar ?? "",
                              pollEnabled: row.pollEnabled,
                              webhookEnabled: row.webhookEnabled,
                            }}
                          />
                        </div>
                      </details>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
        <details className="rounded-lg border bg-card p-4" open={rows.length === 0}>
          <summary className="cursor-pointer text-sm font-medium text-primary">Add a GitHub integration</summary>
          <div className="mt-4">
            <IntegrationForm idPrefix="new-integration" action={createIntegrationAction} submitLabel="Add integration" />
          </div>
        </details>
      </Section>

      <Section title="Webhook deliveries">
        {deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No webhook deliveries received.</p>
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader className="bg-card lg:sticky lg:top-14 lg:z-[1]">
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Last error</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{formatDateTime(d.receivedAt)}</TableCell>
                    <TableCell>
                      {d.eventType}
                      <span className="block text-xs text-muted-foreground">{d.integrationName}</span>
                    </TableCell>
                    <TableCell>
                      {d.status === "dead_lettered" || d.status === "failed" ? (
                        <StatusPill icon={CircleX} label={d.status === "failed" ? "Failed, will retry" : "Dead-lettered"} tone="danger" />
                      ) : (
                        <StatusPill icon={d.status === "processed" ? CircleCheck : CircleDashed} label={d.status} tone={d.status === "processed" ? "success" : "muted"} />
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">{d.attempts}</TableCell>
                    <TableCell className="max-w-72 text-xs whitespace-normal text-muted-foreground">{d.lastError ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {d.status === "dead_lettered" ? (
                        <ActionButton
                          action={replayDeliveryAction.bind(null, d.id)}
                          label="Replay"
                          accessibleLabel={`Replay ${d.eventType} delivery from ${formatDateTime(d.receivedAt)}`}
                        />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </div>
  );
}
