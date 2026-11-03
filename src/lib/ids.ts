const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params are untrusted text; anything that isn't a UUID is a 404, not a DB error. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
