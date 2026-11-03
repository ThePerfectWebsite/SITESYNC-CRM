import Link from "next/link";
import { CircleAlert, CircleCheck, ShieldCheck } from "lucide-react";
import { ActionButton } from "@/components/forms/action-button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import type { Blocker, Readiness } from "@/server/records/readiness";
import { revokeWaiverAction, waiveBlockerAction } from "../work-actions";
import { WaiveForm } from "./waive-form";

function blockerHref(projectId: string, blocker: Blocker): string {
  if (blocker.type === "critical_task") return `/projects/${projectId}/tasks/${blocker.key.slice("task:".length)}`;
  return `/projects/${projectId}/settings#checklist`;
}

/** Readiness summary for the overview (spec §6, screen 9). */
export function ReadinessPanel({
  projectId,
  readiness,
  readOnly,
}: {
  projectId: string;
  readiness: Readiness;
  readOnly: boolean;
}) {
  const waive = waiveBlockerAction.bind(null, projectId);
  return (
    <div className="grid gap-4">
      <div
        role="status"
        className={
          readiness.ready
            ? "flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900"
            : "flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950"
        }
      >
        {readiness.ready ? (
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        ) : (
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        )}
        <p>
          {readiness.ready
            ? `Ready to release${readiness.waived.length ? `, with ${readiness.waived.length} waived blocker${readiness.waived.length === 1 ? "" : "s"}` : ""}.`
            : `Not ready: ${readiness.blockers.length} blocker${readiness.blockers.length === 1 ? "" : "s"}.`}{" "}
          <span className="text-muted-foreground">
            Covers critical tasks and the release checklist; provider checks join when hosting and GitHub are connected.
          </span>
        </p>
      </div>

      {readiness.blockers.length ? (
        <Card>
          <CardContent>
            <ul aria-label="Readiness blockers" className="grid gap-3">
              {readiness.blockers.map((blocker) => (
                <li key={blocker.key} className="grid gap-2 border-b pb-3 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={blockerHref(projectId, blocker)} className="text-sm text-primary hover:underline">
                      {blocker.label}
                    </Link>
                  </div>
                  {readOnly || !blocker.waivable ? null : (
                    <details>
                      <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                        Waive this blocker
                      </summary>
                      <div className="mt-3">
                        <WaiveForm action={waive} blockerKey={blocker.key} idPrefix={`waive-${blocker.key.replace(/[^a-z0-9]/gi, "-")}`} />
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {readiness.waived.length || readiness.inactiveWaivers.length ? (
        <Card>
          <CardContent className="grid gap-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <ShieldCheck className="size-4" aria-hidden="true" />
              Waivers
            </h3>
            <ul className="grid gap-3">
              {[
                ...readiness.waived.map(({ blocker, waiver }) => ({ waiver, label: blocker.label, active: true })),
                ...readiness.inactiveWaivers.map((waiver) => {
                  const snapshotLabel = (waiver.blockerSnapshot as { label?: unknown } | null)?.label;
                  return { waiver, label: typeof snapshotLabel === "string" ? snapshotLabel : waiver.blockerKey, active: false };
                }),
              ].map(({ waiver, label, active }) => (
                <li key={waiver.id} className="grid gap-1 text-sm">
                  <p>
                    {label}
                    {active ? null : (
                      <span className="text-muted-foreground">
                        {" "}
                        ({waiver.commitSha ? "only for another commit" : "blocker no longer present"})
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground">Reason: {waiver.reason}</p>
                  <p className="text-xs text-muted-foreground">
                    {waiver.waivedByName ?? "Operator"}, {formatDateTime(waiver.createdAt)}
                    {waiver.commitSha ? <> · commit <code className="font-mono">{waiver.commitSha.slice(0, 12)}</code></> : null}
                  </p>
                  {readOnly ? null : (
                    <div>
                      <ActionButton
                        action={revokeWaiverAction.bind(null, projectId, waiver.id)}
                        label="Revoke waiver"
                        variant="ghost"
                        accessibleLabel={`Revoke waiver: ${label}`}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
