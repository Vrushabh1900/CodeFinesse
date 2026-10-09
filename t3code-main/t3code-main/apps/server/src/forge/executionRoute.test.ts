import { assert, it } from "@effect/vitest";

import { decideExecutionRoute, type ExecutionRouteInput } from "./executionRoute.ts";
import type { JevChoiceResult } from "./jevClient.ts";

const input: ExecutionRouteInput = {
  missionId: "m1",
  title: "Add mock OAuth sign-in",
  description: "Reuse the existing auth service.",
  affectedAreas: 2,
  independentSubtasks: 2,
  parallelismAvailable: true,
};

const answer = (choice: string, p: number): (() => Promise<JevChoiceResult>) => {
  return async () => ({
    ok: true,
    choice,
    probabilities: { single_agent: 1 - p, parallel_agents: p, [choice]: p },
    modelId: "jev-test",
    latencyMs: 12,
  });
};

it("records a real Jev answer as provider jev and uses it", async () => {
  const decision = await decideExecutionRoute(input, answer("parallel_agents", 0.93));
  assert.equal(decision.provider, "jev");
  assert.equal(decision.selection, "parallel_agents");
  assert.equal(decision.modelId, "jev-test");
  assert.equal(decision.fallbackReason, undefined);
});

it("labels a failed Jev call as a rules fallback with the reason", async () => {
  const decision = await decideExecutionRoute(input, async () => ({
    ok: false,
    reason: "timeout",
    latencyMs: 8000,
  }));
  assert.equal(decision.provider, "rules_fallback");
  assert.equal(decision.fallbackReason, "timeout");
  assert.equal(decision.selection, "parallel_agents");
  assert.equal(decision.modelId, undefined);
});

it("falls back when Jev is not configured", async () => {
  const decision = await decideExecutionRoute({ ...input, affectedAreas: 1 }, null);
  assert.equal(decision.provider, "rules_fallback");
  assert.equal(decision.fallbackReason, "jev_not_configured");
  assert.equal(decision.selection, "single_agent");
});

it("does not trust a low-probability answer", async () => {
  const decision = await decideExecutionRoute(input, answer("parallel_agents", 0.55));
  assert.equal(decision.provider, "rules_fallback");
  assert.equal(decision.fallbackReason, "low_confidence");
});

it("rejects a choice outside the offered options", async () => {
  const decision = await decideExecutionRoute(input, answer("three_agents", 0.99));
  assert.equal(decision.provider, "rules_fallback");
  assert.equal(decision.fallbackReason, "unknown_choice");
});

it("never lets Jev start parallel agents the environment cannot run", async () => {
  const decision = await decideExecutionRoute(
    { ...input, parallelismAvailable: false },
    answer("parallel_agents", 0.95),
  );
  assert.equal(decision.provider, "rules_fallback");
  assert.equal(decision.fallbackReason, "parallelism_unavailable");
  assert.equal(decision.selection, "single_agent");
});

it("sends a bounded, redacted summary to Jev", async () => {
  let sent = "";
  await decideExecutionRoute(
    { ...input, description: `token=abcdef123456 ${"x".repeat(5000)}` },
    async (state) => {
      sent = state;
      return { ok: false, reason: "network_error", latencyMs: 1 };
    },
  );
  assert.isTrue(sent.length <= 1200);
  assert.isFalse(sent.includes("abcdef123456"));
});
