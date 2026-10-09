/**
 * Minimal client for the Jev `POST /v1/systemone` wire protocol, limited to the
 * one `choice` question Forge asks. It never throws: every failure is returned
 * as `{ ok: false, reason }` so the caller can fall back to a labelled rule.
 */
import { redactText } from "./redact.ts";

export interface JevConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export interface JevChoiceQuestion {
  readonly id: string;
  readonly instructions: string;
  /** option id -> description the model reads */
  readonly criteria: Readonly<Record<string, string>>;
}

export type JevChoiceResult =
  | {
      readonly ok: true;
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly modelId: string;
      readonly latencyMs: number;
    }
  | { readonly ok: false; readonly reason: string; readonly latencyMs: number };

export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_TIMEOUT_MS = 8_000;

/** Reads JEV_* settings; absent key means Jev is not configured (not an error). */
export function readJevConfig(env: Readonly<Record<string, string | undefined>>): JevConfig | null {
  const apiKey = env.JEV_API_KEY?.trim();
  if (!apiKey) return null;
  const timeout = Number(env.JEV_TIMEOUT_MS);
  return {
    apiKey,
    baseUrl: (env.JEV_BASE_URL?.trim() || DEFAULT_JEV_BASE_URL).replace(/\/+$/, ""),
    model: env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_JEV_TIMEOUT_MS,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function askJevChoice(
  config: JevConfig,
  state: string,
  question: JevChoiceQuestion,
  fetchImpl: typeof fetch = fetch,
): Promise<JevChoiceResult> {
  const started = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  const fail = (reason: string): JevChoiceResult => ({
    ok: false,
    reason: redactText(reason).slice(0, 200),
    latencyMs: elapsed(),
  });

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        state,
        questions: {
          [question.id]: {
            type: "choice",
            instructions: question.instructions,
            criteria: question.criteria,
          },
        },
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return fail(timedOut ? "timeout" : "network_error");
  }

  if (!response.ok) return fail(`http_${response.status}`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fail("invalid_json");
  }

  const answer = isRecord(body) && isRecord(body.answers) ? body.answers[question.id] : undefined;
  if (!isRecord(answer) || answer.type !== "choice" || typeof answer.choice !== "string") {
    return fail("unexpected_response_shape");
  }
  const probabilities: Record<string, number> = {};
  if (isRecord(answer.probabilities)) {
    for (const [option, p] of Object.entries(answer.probabilities)) {
      if (typeof p === "number" && Number.isFinite(p)) probabilities[option] = p;
    }
  }
  return {
    ok: true,
    choice: answer.choice,
    probabilities,
    modelId: isRecord(body) && typeof body.model === "string" ? body.model : config.model,
    latencyMs: elapsed(),
  };
}
