/**
 * The API contract one agent publishes for another. Agents write it to
 * `CONTRACT_FILE` in their workspace; Forge accepts it only when it names a
 * single `METHOD /path` endpoint, and records it as `CONTRACT_PROPOSED`.
 */
export const CONTRACT_FILE = ".forge/contract.json";

export interface Contract {
  readonly endpoint: string;
  readonly request?: unknown;
  readonly response?: unknown;
}

/** Accepts a contract only if it names one `METHOD /path` endpoint; anything else is null. */
export function parseContract(value: unknown): Contract | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "endpoint" in value &&
    typeof value.endpoint === "string" &&
    /^[A-Z]+ \/[\w/:{}.-]*$/.test(value.endpoint)
  ) {
    return value as Contract;
  }
  return null;
}
