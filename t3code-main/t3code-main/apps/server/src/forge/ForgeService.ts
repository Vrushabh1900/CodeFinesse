/**
 * ForgeService - the capability transports call: a project's live Forge
 * state, saving project decisions, starting a mission, acknowledging a
 * contract, and merging plus verifying the agents' work.
 *
 * Agents run as real T3 threads (see ForgeThreadRunnerLive); their outcomes
 * flow back through ForgeTaskReactor, so this service never claims progress
 * the event log has not recorded.
 *
 * @module ForgeService
 */
import {
  ForgeError,
  ProjectId,
  type ForgeAcknowledgeContractInput,
  type ForgeAddDecisionInput,
  type ForgeMission,
  type ForgeProjectState,
  type ForgeStartMissionInput,
  type ForgeVerifyInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import * as ForgeCoordinator from "./ForgeCoordinator.ts";
import * as ForgeEventLog from "./ForgeEventLog.ts";
import * as ForgeMemoryStore from "./ForgeMemoryStore.ts";
import * as ForgeMissionStore from "./ForgeMissionStore.ts";
import * as ForgeRouter from "./ForgeRouter.ts";
import * as ForgeWorkspace from "./ForgeWorkspace.ts";
import { overlayAddedEdges, scanImports, type GraphSnapshot } from "./graphScanner.ts";

const GRAPH_CACHE_MS = 30_000;
const ACTIVE_STATUSES: ReadonlySet<ForgeMission["status"]> = new Set([
  "created",
  "planning",
  "waiting",
  "running",
  "integrating",
  "verifying",
]);

const messageOf = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
    ? cause.message
    : "Forge could not complete the request.";

const isForgeError = Schema.is(ForgeError);

const toForgeError = (cause: unknown) =>
  isForgeError(cause) ? cause : new ForgeError({ message: messageOf(cause), cause });

export class ForgeService extends Context.Service<
  ForgeService,
  {
    readonly subscribe: (projectId: string) => Stream.Stream<ForgeProjectState, ForgeError>;
    readonly addDecision: (input: ForgeAddDecisionInput) => Effect.Effect<void, ForgeError>;
    readonly startMission: (input: ForgeStartMissionInput) => Effect.Effect<void, ForgeError>;
    readonly acknowledgeContract: (
      input: ForgeAcknowledgeContractInput,
    ) => Effect.Effect<void, ForgeError>;
    /** Merges the task worktrees and starts the test run; the result arrives through `subscribe`. */
    readonly integrateAndVerify: (input: ForgeVerifyInput) => Effect.Effect<void, ForgeError>;
  }
>()("t3/forge/ForgeService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectService.ProjectService;
  const coordinator = yield* ForgeCoordinator.ForgeCoordinator;
  const log = yield* ForgeEventLog.ForgeEventLog;
  const missions = yield* ForgeMissionStore.ForgeMissionStore;
  const memories = yield* ForgeMemoryStore.ForgeMemoryStore;
  const router = yield* ForgeRouter.ForgeRouter;
  const workspace = yield* ForgeWorkspace.ForgeWorkspace;
  // Verification can take minutes; it runs in the service's scope, not the request's.
  const serviceScope = yield* Effect.scope;
  const graphCache = new Map<
    string,
    { readonly graph: GraphSnapshot; readonly truncated: boolean; readonly atMs: number }
  >();

  const requireProjectRoot = Effect.fn("ForgeService.requireProjectRoot")(function* (projectId: string) {
    const project = yield* projects.getById(ProjectId.make(projectId)).pipe(Effect.mapError(toForgeError));
    if (Option.isNone(project)) {
      return yield* new ForgeError({ message: `Project ${projectId} was not found.` });
    }
    return project.value.workspaceRoot;
  });

  const requireMissionOf = Effect.fn("ForgeService.requireMissionOf")(function* (
    projectId: string,
    missionId: string,
  ) {
    const mission = yield* missions.getMission(missionId).pipe(Effect.mapError(toForgeError));
    if (Option.isNone(mission) || mission.value.projectId !== projectId) {
      return yield* new ForgeError({ message: "That mission does not belong to this project." });
    }
    return mission.value;
  });

  const baseGraph = Effect.fn("ForgeService.baseGraph")(function* (projectId: string, root: string) {
    const now = yield* Clock.currentTimeMillis;
    const cached = graphCache.get(projectId);
    if (cached !== undefined && now - cached.atMs < GRAPH_CACHE_MS) return cached;
    const scanned = yield* workspace.scan(root);
    const entry = { graph: scanImports(scanned.files), truncated: scanned.truncated, atMs: now };
    graphCache.set(projectId, entry);
    return entry;
  });

  const state = Effect.fn("ForgeService.state")(function* (projectId: string) {
    const root = yield* requireProjectRoot(projectId);
    const latest = (yield* missions.listMissions(projectId).pipe(Effect.mapError(toForgeError)))[0];
    const events =
      latest === undefined ? [] : yield* log.list({ missionId: latest.id }).pipe(Effect.mapError(toForgeError));
    const base = yield* baseGraph(projectId, root);
    const graph = overlayAddedEdges(base.graph, events);
    return {
      projectId,
      jevConfigured: router.jevConfigured,
      mission: latest ?? null,
      tasks:
        latest === undefined ? [] : yield* missions.listTasks(latest.id).pipe(Effect.mapError(toForgeError)),
      events,
      memories: yield* memories.list(projectId).pipe(Effect.mapError(toForgeError)),
      graph: {
        nodes: graph.nodes,
        edges: graph.edges,
        addedEdgeIds: graph.addedEdgeIds,
        truncated: base.truncated,
      },
    } satisfies ForgeProjectState;
  });

  const subscribe: ForgeService["Service"]["subscribe"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the first snapshot so a change in between is not lost.
        const changes = yield* log.subscribeChanges;
        return Stream.concat(
          Stream.fromEffect(state(projectId)),
          Stream.fromSubscription(changes).pipe(Stream.mapEffect(() => state(projectId))),
        );
      }),
    );

  const addDecision: ForgeService["Service"]["addDecision"] = Effect.fn("ForgeService.addDecision")(
    function* (input) {
      yield* requireProjectRoot(input.projectId);
      yield* memories
        .add({
          id: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
          projectId: input.projectId,
          title: input.title,
          body: input.body,
          global: input.global ?? false,
          now: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.mapError(toForgeError));
      yield* log.notifyChanged;
    },
  );

  const startMission: ForgeService["Service"]["startMission"] = Effect.fn("ForgeService.startMission")(
    function* (input) {
      yield* requireProjectRoot(input.projectId);
      const latest = (yield* missions.listMissions(input.projectId).pipe(Effect.mapError(toForgeError)))[0];
      if (latest !== undefined && ACTIVE_STATUSES.has(latest.status)) {
        return yield* new ForgeError({
          message: "A mission is already in progress for this project. Finish or verify it first.",
        });
      }
      graphCache.delete(input.projectId);
      yield* coordinator
        .startMission({
          projectId: input.projectId,
          title: input.title,
          description: input.description,
          parallelismAvailable: true,
          plan: [
            { role: "backend", title: "Backend", instruction: input.backendInstruction },
            {
              role: "frontend",
              title: "Frontend",
              instruction: input.frontendInstruction,
              dependsOnRoles: ["backend"],
            },
          ],
        })
        .pipe(Effect.mapError(toForgeError));
    },
  );

  const acknowledgeContract: ForgeService["Service"]["acknowledgeContract"] = Effect.fn(
    "ForgeService.acknowledgeContract",
  )(function* (input) {
    yield* requireMissionOf(input.projectId, input.missionId);
    yield* coordinator
      .acknowledgeContract({
        missionId: input.missionId,
        contractEventId: input.contractEventId,
        acknowledgedBy: "user",
      })
      .pipe(Effect.mapError(toForgeError));
  });

  const integrateAndVerify: ForgeService["Service"]["integrateAndVerify"] = Effect.fn(
    "ForgeService.integrateAndVerify",
  )(function* (input) {
    const root = yield* requireProjectRoot(input.projectId);
    const mission = yield* requireMissionOf(input.projectId, input.missionId);
    if (mission.status !== "integrating") {
      return yield* new ForgeError({ message: "Every agent has to finish before Forge can merge and verify." });
    }
    const tasks = yield* missions.listTasks(mission.id).pipe(Effect.mapError(toForgeError));
    const worktrees = tasks.flatMap((task) => (task.worktreePath === undefined ? [] : [task.worktreePath]));
    // A single agent that worked in the project root has nothing to merge.
    const merged =
      worktrees.length === 0
        ? { dir: root, applied: [] as ReadonlyArray<string>, conflicts: [] as ReadonlyArray<string> }
        : yield* workspace.integrate({ projectRoot: root, worktrees }).pipe(Effect.mapError(toForgeError));
    const label = ForgeWorkspace.VERIFICATION_COMMANDS[input.command].label;
    yield* coordinator
      .startVerification({
        missionId: mission.id,
        command: label,
        cwd: merged.dir,
        detail: { applied: merged.applied, conflicts: merged.conflicts },
      })
      .pipe(Effect.mapError(toForgeError));

    const runAndRecord = workspace.verify({ cwd: merged.dir, command: input.command }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          command: label,
          cwd: merged.dir,
          exitCode: -1,
          durationMs: 0,
          output: error.message,
        }),
      ),
      Effect.flatMap((outcome) => coordinator.finishVerification({ missionId: mission.id, ...outcome })),
      Effect.catchCause((cause) => Effect.logWarning("Forge verification could not be recorded", cause)),
    );
    yield* Effect.forkIn(runAndRecord, serviceScope);
  });

  return ForgeService.of({ subscribe, addDecision, startMission, acknowledgeContract, integrateAndVerify });
});

export const layer = Layer.effect(ForgeService, make);
