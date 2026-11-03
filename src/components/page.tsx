import type { LucideIcon } from "lucide-react";
import { Breadcrumbs, type Crumb } from "@/components/shell/breadcrumbs";
import { Card, CardContent } from "@/components/ui/card";

export function PageHeader({
  crumbs,
  title,
  meta,
  actions,
}: {
  crumbs: Crumb[];
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <Breadcrumbs items={crumbs} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {meta}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
        <Icon className="size-8 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-base font-semibold">{title}</h2>
        {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </CardContent>
    </Card>
  );
}

export function Section({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="grid content-start gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Definition list for record details. */
export function Details({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
      {items.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-words">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
