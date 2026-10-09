/**
 * Scrubs credentials from text and event payloads before they are persisted,
 * broadcast or sent to a decision provider. Redaction is lossy by design: a
 * false positive hides a harmless string, a false negative leaks a secret.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(api[-_]?key|secret|token|password|passwd|authorization|credential|cookie)/i;

// Order matters: the Bearer form must run before the generic long-token form.
const TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [
    /\b([A-Za-z0-9_]*(?:API[-_]?KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)\s*[=:]\s*["']?[^\s"']{4,}/gi,
    `$1=${REDACTED}`,
  ],
  [/\b(?:sk|pk|apik|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, REDACTED],
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Values under a sensitive key that describe a field rather than hold one, as in an API contract
// (`"token": "string"`, `"token": "JWT signed by the auth service"`). These stay readable.
const TYPE_WORDS = new Set([
  "string", "number", "integer", "boolean", "object", "array", "null", "jwt", "uuid", "bearer", "redacted",
]);

/** A value under a sensitive key is hidden unless it is clearly a description, not a credential. */
function looksLikeCredential(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (/\s/.test(trimmed)) return false; // prose describes a field; credentials have no spaces
  return !TYPE_WORDS.has(trimmed.toLowerCase().replace(/[<>[\]"'`]/g, ""));
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      SENSITIVE_KEY.test(key) && typeof entry === "string" && looksLikeCredential(entry)
        ? REDACTED
        : redactValue(entry, depth + 1);
  }
  return out;
}

export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactValue(payload) as Record<string, unknown>;
}
