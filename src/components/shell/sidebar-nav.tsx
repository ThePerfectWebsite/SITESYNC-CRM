"use client";

import {
  Activity,
  Building2,
  FolderKanban,
  LayoutDashboard,
  PlugZap,
  Settings,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { label: string; href: string; icon: LucideIcon; available: boolean };

// Sections not built yet are listed (so the shape of the app is visible) but not linked.
const NAV: NavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard, available: true },
  { label: "Clients", href: "/clients", icon: Building2, available: true },
  { label: "Projects", href: "/projects", icon: FolderKanban, available: true },
  { label: "Integrations", href: "/integrations", icon: PlugZap, available: false },
  { label: "Activity", href: "/activity", icon: Activity, available: false },
  { label: "Settings", href: "/settings", icon: Settings, available: true },
];

export function SidebarNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="grid gap-0.5">
        {NAV.map(({ label, href, icon: Icon, available }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          if (!available) {
            return (
              <li key={href}>
                <span
                  aria-disabled="true"
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-sidebar-foreground/60"
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                  <span className="ml-auto text-[0.7rem] tracking-wide uppercase">Soon</span>
                </span>
              </li>
            );
          }
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-sidebar-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground"
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
