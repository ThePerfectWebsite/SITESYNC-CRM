// Status is always text + icon (spec §9), never colour alone.
import {
  Archive,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleSlash,
  Hammer,
  Rocket,
  type LucideIcon,
} from "lucide-react";
import { CLIENT_STATUS_LABELS, WEBSITE_STATUS_LABELS } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "info" | "success" | "warning" | "muted";

const TONES: Record<Tone, string> = {
  neutral: "border-border bg-card text-foreground",
  info: "border-blue-200 bg-blue-50 text-blue-800",
  success: "border-green-200 bg-green-50 text-green-800",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  muted: "border-border bg-muted text-muted-foreground",
};

export function StatusPill({ icon: Icon, label, tone = "neutral" }: { icon: LucideIcon; label: string; tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

export function ArchivedPill() {
  return <StatusPill icon={Archive} label="Archived" tone="muted" />;
}

export function ClientStatus({ status }: { status: keyof typeof CLIENT_STATUS_LABELS }) {
  const config: Record<typeof status, [LucideIcon, Tone]> = {
    prospect: [CircleDashed, "info"],
    active: [CircleDot, "success"],
    paused: [CirclePause, "warning"],
    former: [CircleSlash, "muted"],
  };
  const [icon, tone] = config[status];
  return <StatusPill icon={icon} label={CLIENT_STATUS_LABELS[status]} tone={tone} />;
}

export function WebsiteStatus({ status }: { status: keyof typeof WEBSITE_STATUS_LABELS }) {
  const config: Record<typeof status, [LucideIcon, Tone]> = {
    planned: [CircleDashed, "info"],
    in_development: [Hammer, "warning"],
    live: [Rocket, "success"],
    retired: [CircleSlash, "muted"],
  };
  const [icon, tone] = config[status];
  return <StatusPill icon={icon} label={WEBSITE_STATUS_LABELS[status]} tone={tone} />;
}

export function StagePill({
  name,
  kind,
  role,
}: {
  name: string;
  kind: "linear" | "on_hold" | "archived";
  role: "ready_to_deploy" | "live" | null;
}) {
  if (kind === "on_hold") return <StatusPill icon={CirclePause} label={name} tone="warning" />;
  if (kind === "archived") return <StatusPill icon={Archive} label={name} tone="muted" />;
  if (role === "live") return <StatusPill icon={Rocket} label={name} tone="success" />;
  if (role === "ready_to_deploy") return <StatusPill icon={CircleCheck} label={name} tone="info" />;
  return <StatusPill icon={CircleDot} label={name} tone="neutral" />;
}
