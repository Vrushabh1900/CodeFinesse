/**
 * ForgeRouter - answers Decision A (single agent or parallel agents).
 *
 * Wraps the Jev call and its labelled rules fallback. It never fails: a
 * missing key, timeout or bad response becomes a `rules_fallback` decision
 * that records why.
 *
 * @module ForgeRouter
 */
import type { ForgeDecision } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { decideExecutionRoute, type ExecutionRouteInput } from "./executionRoute.ts";
import { askJevChoice, readJevConfig, type JevConfig } from "./jevClient.ts";

export class ForgeRouter extends Context.Service<
  ForgeRouter,
  {
    /** Whether a Jev key is configured; false means every decision is a rules fallback. */
    readonly jevConfigured: boolean;
    readonly decideRoute: (input: ExecutionRouteInput) => Effect.Effect<ForgeDecision>;
  }
>()("t3/forge/ForgeRouter") {}

/** Configuration is a parameter: `null` means Jev is not configured. */
export const makeWithConfig = (config: JevConfig | null, fetchImpl: typeof fetch = fetch) =>
  ForgeRouter.of({
    jevConfigured: config !== null,
    decideRoute: (input) =>
      Effect.promise(() =>
        decideExecutionRoute(
          input,
          config === null
            ? null
            : (state, question) => askJevChoice(config, state, question, fetchImpl),
        ),
      ),
  });

export const layerFromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  Layer.succeed(ForgeRouter, makeWithConfig(readJevConfig(env)));

const optional = (name: string) => Config.String(name).pipe(Config.withDefault(""));

/** Reads JEV_API_KEY, JEV_BASE_URL, JEV_MODEL and JEV_TIMEOUT_MS from the server's configuration. */
export const layer = Layer.effect(
  ForgeRouter,
  Effect.gen(function* () {
    const env = {
      JEV_API_KEY: yield* optional("JEV_API_KEY"),
      JEV_BASE_URL: yield* optional("JEV_BASE_URL"),
      JEV_MODEL: yield* optional("JEV_MODEL"),
      JEV_TIMEOUT_MS: yield* optional("JEV_TIMEOUT_MS"),
    };
    return makeWithConfig(readJevConfig(env));
  }).pipe(Effect.orElseSucceed(() => makeWithConfig(null))),
);
