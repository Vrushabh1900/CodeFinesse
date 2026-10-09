/**
 * Composes Forge for the T3 server: one shared set of stores (the event log's
 * change signal must be a single instance), the coordinator with the Jev
 * router and the live thread runner, the transport-facing ForgeService, and
 * the background reactor that follows each agent's thread.
 *
 * Needs ThreadLaunchService, ThreadManagementService and ProjectService from
 * the orchestration runtime, plus SQL, filesystem, process and crypto services.
 *
 * @module ForgeRuntime
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ForgeCoordinator from "./ForgeCoordinator.ts";
import * as ForgeEventLog from "./ForgeEventLog.ts";
import * as ForgeMemoryStore from "./ForgeMemoryStore.ts";
import * as ForgeMissionStore from "./ForgeMissionStore.ts";
import * as ForgeRouter from "./ForgeRouter.ts";
import * as ForgeService from "./ForgeService.ts";
import * as ForgeTaskReactor from "./ForgeTaskReactor.ts";
import * as ForgeThreadRunnerLive from "./ForgeThreadRunnerLive.ts";
import * as ForgeWorkspace from "./ForgeWorkspace.ts";

const layerStores = Layer.mergeAll(
  ForgeEventLog.layer,
  ForgeMissionStore.layer,
  ForgeMemoryStore.layer,
);

const layerCore = ForgeCoordinator.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(ForgeRouter.layer, ForgeThreadRunnerLive.layer(), ForgeWorkspace.layer),
  ),
  Layer.provideMerge(layerStores),
);

const layerReactorStarted = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* ForgeTaskReactor.ForgeTaskReactor;
    yield* reactor.start;
  }),
).pipe(Layer.provide(ForgeTaskReactor.layer));

export const layer = Layer.mergeAll(ForgeService.layer, layerReactorStarted).pipe(
  Layer.provideMerge(layerCore),
);
