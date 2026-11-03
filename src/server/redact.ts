// Central redaction (spec §4). Applied to logs, error strings, audit JSON,
// provider snapshots and webhook bodies. Pure — safe to import anywhere.

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|api[-_]?key|signature|session)/i;
const SENSITIVE_QUERY_PARAMS = new Set(["access_token", "token", "code", "sig"]);
const MAX_DEPTH = 20;

// Known token shapes. Vercel token format is re-checked against provider docs in Phase 3b.
const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub classic / OAuth / app tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bnfp_[A-Za-z0-9]{20,}\b/g, // Netlify personal access token
  /\bvc[pkia]_[A-Za-z0-9]{20,}\b/g, // Vercel prefixed tokens
  /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, // JWT
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, // auth header values
];

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = url.username ? "REDACTED" : "";
    url.password = url.password ? "REDACTED" : "";
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) || SENSITIVE_KEY.test(key)) {
      url.searchParams.set(key, "REDACTED");
      changed = true;
    }
  }
  return changed ? url.toString() : raw;
}

export function redactString(value: string): string {
  let out = value.replace(URL_PATTERN, (match) => redactUrl(match));
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Returns a deep copy with sensitive keys removed and token-shaped strings masked. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return "[BINARY]";
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(inner, depth + 1);
  }
  return out;
}

/** Redacted, single-line description of an unknown error, safe to log or store. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return redactString(`${error.name}: ${error.message}`);
  return redactString(String(error));
}
