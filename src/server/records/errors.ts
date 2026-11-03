// Errors the record services raise for the UI to show. Messages are written
// for the operator; anything else is a bug and surfaces as a 500.
import type { z } from "zod";

export type DomainErrorCode = "not_found" | "invalid" | "conflict" | "stale";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const notFound = (what: string) => new DomainError("not_found", `${what} not found.`);

export const invalidField = (field: string, message: string) =>
  new DomainError("invalid", message, { [field]: message });

export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    errors[key] ??= issue.message;
  }
  return errors;
}

/** Parses input with a schema, raising DomainError("invalid") with per-field messages. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainError("invalid", "Check the highlighted fields.", fieldErrorsFrom(result.error));
  }
  return result.data;
}

type PgError = { code?: string; constraint?: string };

/** The underlying node-postgres error, if any (Drizzle wraps it in `cause`). */
export function pgError(error: unknown): PgError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as PgError & { cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) return candidate;
    current = candidate.cause;
  }
  return null;
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pg = pgError(error);
  return pg?.code === "23505" && pg.constraint === constraint;
}

/** Service input before validation: any of the schema's fields, any values (forms send strings). */
export type RawInput<S extends z.ZodType> = { [K in keyof z.input<S>]?: unknown };
