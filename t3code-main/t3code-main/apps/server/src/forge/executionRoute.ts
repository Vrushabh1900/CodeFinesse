/**
 * Decision A: run a mission with one agent or with two coordinated agents.
 *
 * Jev is advisory. Its answer is used only when the call succeeds, names a
 * known option and clears `MIN_JEV_PROBABILITY`; anything else is answered by
 * a deterministic rule and recorded as `rules_fallback` with the reason, so an
 * audit reader can never mistake a rule for inference.
 */
import type { ForgeDecision } from "@t3tools/contracts";

import type { JevChoiceQuestion, JevChoiceResult } from "./jevClient.ts";
import { redactText } from "./redact.ts";

export const EXECUTION_ROUTES = ["single_agent", "parallel_agents"] as const;
export type ExecutionRoute = (typeof EXECUTION_ROUTES)[number];

/** Gated on the chosen option's probability, which means the same on every Jev-compatible server. */
export const MIN_JEV_PROBABILITY = 0.6;

const MAX_SUMMARY_CHARS = 1_200;

export interface ExecutionRouteInput {
  readonly missionId: string;
  readonly title: string;
  readonly description: string;
  /** Scanner estimate of distinct areas (e.g. frontend, backend) the mission touches. */
  readonly affectedAreas: number;
  /** Subtasks that can proceed without waiting on another subtask. */
  readonly independentSubtasks: number;
  /** Whether a second concurrent agent session can actually be started. */
  readonly parallelismAvailable: boolean;
}

const QUESTION: JevChoiceQuestion = {
  id: "route",
  instructions: "Should this mission run as one coding agent or as two coordinated parallel agents?",
  criteria: {
    single_agent: "Small or tightly coupled change best done sequentially by one agent",
    parallel_agents:
      "Independent frontend and backend work that two agents can do at once after a shared contract",
  },
};

/** Compact, bounded, redacted summary: the only mission text that leaves the machine. */
export function summarizeForRouting(input: ExecutionRouteInput): string {
  const summary = [
    `Mission: ${input.title}. ${input.description}`,
    `Affected areas: ${input.affectedAreas}.`,
    `Independent subtasks: ${input.independentSubtasks}.`,
    `Parallel agents available: ${input.parallelismAvailable ? "yes" : "no"}.`,
  ].join(" ");
  return redactText(summary).slice(0, MAX_SUMMARY_CHARS);
}

export function ruleBasedRoute(input: ExecutionRouteInput): ExecutionRoute {
  // Dependent subtasks are fine in parallel: the contract gate orders them.
  return input.parallelismAvailable && input.affectedAreas >= 2 ? "parallel_agents" : "single_agent";
}

export async function decideExecutionRoute(
  input: ExecutionRouteInput,
  ask: ((state: string, question: JevChoiceQuestion) => Promise<JevChoiceResult>) | null,
): Promise<ForgeDecision> {
  const inputSummary = summarizeForRouting(input);
  const base = {
    missionId: input.missionId,
    kind: "execution_route" as const,
    alternatives: [...EXECUTION_ROUTES],
    inputSummary,
  };
  const fallback = (reason: string, latencyMs?: number): ForgeDecision => ({
    ...base,
    provider: "rules_fallback",
    selection: ruleBasedRoute(input),
    fallbackReason: reason,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  });

  if (ask === null) return fallback("jev_not_configured");

  const result = await ask(inputSummary, QUESTION);
  if (!result.ok) return fallback(result.reason, result.latencyMs);

  const probability = result.probabilities[result.choice];
  if (!EXECUTION_ROUTES.includes(result.choice as ExecutionRoute)) {
    return fallback("unknown_choice", result.latencyMs);
  }
  if (probability === undefined || probability < MIN_JEV_PROBABILITY) {
    return fallback("low_confidence", result.latencyMs);
  }
  // A model may not start a second agent the environment cannot run.
  if (result.choice === "parallel_agents" && !input.parallelismAvailable) {
    return fallback("parallelism_unavailable", result.latencyMs);
  }
  return {
    ...base,
    provider: "jev",
    selection: result.choice,
    probabilities: result.probabilities,
    modelScore: probability,
    latencyMs: result.latencyMs,
    modelId: result.modelId,
  };
}
