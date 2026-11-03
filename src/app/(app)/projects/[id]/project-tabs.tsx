"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Overview", path: "", available: true },
  { label: "Tasks", path: "/tasks", available: true },
  { label: "Changes", path: "/changes", available: true },
  { label: "Deployments", path: "/deployments", available: true },
  { label: "Activity", path: "/activity", available: true },
  { label: "Settings", path: "/settings", available: true },
];

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}`;
  return (
    <nav aria-label="Project sections" className="border-b">
      <ul className="-mb-px flex flex-wrap gap-1">
        {TABS.map((tab) => {
          const href = `${base}${tab.path}`;
          if (!tab.available) {
            return (
              <li key={tab.label}>
                <span
                  aria-disabled="true"
                  title="Arrives in a later phase"
                  className="inline-block border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground/70"
                >
                  {tab.label}
                </span>
              </li>
            );
          }
          const active = tab.path ? pathname.startsWith(href) : pathname === href;
          return (
            <li key={tab.label}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className="inline-block rounded-t-md border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground"
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
