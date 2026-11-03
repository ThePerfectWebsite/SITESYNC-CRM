// Display formatting (en-GB). Dates from Postgres `date` columns arrive as YYYY-MM-DD strings.

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return dateFormat.format(new Date(`${value}T00:00:00Z`));
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return dateTimeFormat.format(typeof value === "string" ? new Date(value) : value);
}

export const CLIENT_STATUS_LABELS = {
  prospect: "Prospect",
  active: "Active",
  paused: "Paused",
  former: "Former",
} as const;

export const WEBSITE_STATUS_LABELS = {
  planned: "Planned",
  in_development: "In development",
  live: "Live",
  retired: "Retired",
} as const;

export function optionsFrom<T extends Record<string, string>>(labels: T) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
