import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type { ForgeEvent } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ForgeCoordinator from "./ForgeCoordinator.ts";
import * as ForgeEventLog from "./ForgeEventLog.ts";
import * as ForgeMemoryStore from "./ForgeMemoryStore.ts";
import * as ForgeMissionStore from "./ForgeMissionStore.ts";
import * as ForgeRouter from "./ForgeRouter.ts";
import * as ForgeThreadRunner from "./ForgeThreadRunner.ts";
import type { JevConfig } from "./jevClient.ts";

const launches: ForgeThreadRunner.ForgeThreadLaunch[] = [];
let launchCounter = 0;

const FakeRunner = Layer.succeed(
  ForgeThreadRunner.ForgeThreadRunner,
  ForgeThreadRunner.ForgeThreadRunner.of({
    launch: (input) =>
      Effect.sync(() => {
        launches.push(input);
        launchCounter += 1;
        return {
          threadId: `thread-${launchCounter}`,
          ...(input.isolatedWorktree ? { worktreePath: `/wt/${input.role}` } : {}),
        };
      }),
  }),
);

const jevConfig: JevConfig = { baseUrl: "https://jev.test", apiKey: "k", model: "m", timeoutMs: 500 };
const jevSays = (choice: string, p: number) =>
  (async () =>
    new Response(
      JSON.stringify({
        model: "jev-test",
        answers: {
          route: {
            type: "choice",
            choice,
            probabilities: { single_agent: 1 - p, parallel_agents: p, [choice]: p },
          },
        },
      }),
    )) as unknown as typeof fetch;

const layerFor = (router: Layer.Layer<ForgeRouter.ForgeRouter>) => {
  const base = Layer.mergeAll(
    ForgeEventLog.layer,
    ForgeMissionStore.layer,
    ForgeMemoryStore.layer,
  ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
  return ForgeCoordinator.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(router, FakeRunner, NodeCrypto.layer)),
    Layer.provideMerge(base),
  );
};

const plan = [
  { role: "backend", title: "Backend", instruction: "Add POST /auth/google-mock returning a JWT." },
  {
    role: "frontend",
    title: "Frontend",
    instruction: "Add a mock Google sign-in button.",
    dependsOnRoles: ["backend"],
  },
] as const;

const setup = Effect.gen(function* () {
  launches.length = 0;
  launchCounter = 0;
  yield* runMigrations();
  const memories = yield* ForgeMemoryStore.ForgeMemoryStore;
  yield* memories.add({
    id: "mem-auth",
    projectId: "p1",
    title: "Reuse the existing auth service",
    body: "Do not introduce Auth0; extend the existing JWT auth service.",
    global: false,
    now: "2026-10-09T00:00:00.000Z",
  });
  return yield* ForgeCoordinator.ForgeCoordinator;
});

const start = (coordinator: ForgeCoordinator.ForgeCoordinator["Service"]) =>
  coordinator.startMission({
    projectId: "p1",
    title: "Add mock Google OAuth-style sign-in using the existing auth",
    description: "Reuse existing authentication patterns.",
    plan,
  });

const transitionReason = (error: ForgeCoordinator.ForgeCoordinatorError) =>
  error._tag === "ForgeTransitionError" ? error.reason : error._tag;

const seqOf =(events: ReadonlyArray<ForgeEvent>, type: string, taskId?: string) =>
  events.find((e) => e.type === type && (taskId === undefined || e.taskId === taskId))?.seq;

it.effect("a Jev parallel decision creates two tasks and starts only the unblocked one", () =>
  Effect.gen(function* () {
    const coordinator = yield* setup;
    const result = yield* start(coordinator);

    assert.equal(result.decision.provider, "jev");
    assert.equal(result.decision.selection, "parallel_agents");
    assert.deepEqual(result.tasks.map((t) => [t.role, t.status]), [
      ["backend", "running"],
      ["frontend", "blocked"],
    ]);
    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.role, "backend");
    assert.isTrue(launches[0]!.isolatedWorktree);
    assert.equal(result.tasks[0]!.worktreePath, "/wt/backend");
    assert.equal(result.mission.status, "running");
  }).pipe(
    Effect.provide(layerFor(Layer.succeed(ForgeRouter.ForgeRouter, ForgeRouter.makeWithConfig(jevConfig, jevSays("parallel_agents", 0.93))))),
  ),
);

it.effect("retrieved project decisions reach the agent prompt", () =>
  Effect.gen(function* () {
    const coordinator = yield* setup;
    const result = yield* start(coordinator);
    assert.deepEqual(result.memories.map((m) => m.id), ["mem-auth"]);
    assert.include(launches[0]!.prompt, "Reuse the existing auth service");
    assert.include(launches[0]!.prompt, "Do not introduce Auth0");
    const log = yield* ForgeEventLog.ForgeEventLog;
    const memoryEvent = (yield* log.list({ missionId: result.mission.id })).find(
      (e) => e.type === "MEMORY_RETRIEVED",
    );
    assert.deepEqual(memoryEvent?.payload.memoryIds, ["mem-auth"]);
  }).pipe(Effect.provide(layerFor(ForgeRouter.layerFromEnv({})))),
);

it.effect("a rules fallback collapses to one task and is labelled as a fallback", () =>
  Effect.gen(function* () {
    const coordinator = yield* setup;
    const result = yield* coordinator.startMission({
      projectId: "p1",
      title: "Tweak button text",
      description: "tiny",
      plan,
      parallelismAvailable: false,
    });
    assert.equal(result.decision.provider, "rules_fallback");
    assert.equal(result.decision.fallbackReason, "jev_not_configured");
    assert.deepEqual(result.tasks.map((t) => [t.role, t.status]), [["single", "running"]]);
    assert.isFalse(launches[0]!.isolatedWorktree);
    assert.include(launches[0]!.prompt, "POST /auth/google-mock");
    assert.include(launches[0]!.prompt, "mock Google sign-in button");
  }).pipe(Effect.provide(layerFor(ForgeRouter.layerFromEnv({})))),
);

it.effect("the frontend task starts only after a recorded acknowledgment, and gets the contract", () =>
  Effect.gen(function* () {
    const coordinator = yield* setup;
    const log = yield* ForgeEventLog.ForgeEventLog;
    const { mission, tasks } = yield* start(coordinator);
    const [backend, frontend] = tasks;

    const contract = { endpoint: "POST /auth/google-mock", response: { token: "string" } };
    const proposed = yield* coordinator.proposeContract({
      missionId: mission.id,
      taskId: backend!.id,
      contract,
    });
    assert.equal(launches.length, 1, "proposal alone must not start the frontend");

    const acked = yield* coordinator.acknowledgeContract({
      missionId: mission.id,
      contractEventId: proposed.id,
      acknowledgedBy: `task:${frontend!.id}`,
    });
    assert.equal(launches.length, 2);
    assert.equal(launches[1]!.role, "frontend");
    assert.include(launches[1]!.prompt, "POST /auth/google-mock");
    assert.include(launches[1]!.prompt, "mock Google sign-in button");

    const events = yield* log.list({ missionId: mission.id });
    const ackSeq = seqOf(events, "CONTRACT_ACKNOWLEDGED")!;
    const unblockedSeq = seqOf(events, "TASK_UNBLOCKED", frontend!.id)!;
    const startedSeq = seqOf(events, "TASK_STARTED", frontend!.id)!;
    assert.isTrue(proposed.seq < ackSeq && ackSeq < unblockedSeq && unblockedSeq < startedSeq);
    assert.equal(acked.causedByEventId, proposed.id);
    assert.equal(events.find((e) => e.type === "TASK_UNBLOCKED")?.causedByEventId, acked.id);
    assert.equal(
      (yield* ForgeMissionStore.ForgeMissionStore.pipe(
        Effect.flatMap((store) => store.getTask(frontend!.id)),
      ))._tag === "Some",
      true,
    );
  }).pipe(
    Effect.provide(layerFor(Layer.succeed(ForgeRouter.ForgeRouter, ForgeRouter.makeWithConfig(jevConfig, jevSays("parallel_agents", 0.93))))),
  ),
);

it.effect("rejects contract misuse: unknown event, double acknowledgment, proposing from a blocked task", () =>
  Effect.gen(function* () {
    const coordinator = yield* setup;
    const { mission, tasks } = yield* start(coordinator);
    const [backend, frontend] = tasks;

    const blocked = yield* Effect.flip(
      coordinator.proposeContract({ missionId: mission.id, taskId: frontend!.id, contract: {} }),
    );
    assert.equal(transitionReason(blocked), "task_not_running");

    const unknown = yield* Effect.flip(
      coordinator.acknowledgeContract({
        missionId: mission.id,
        contractEventId: "nope",
        acknowledgedBy: "human",
      }),
    );
    assert.equal(transitionReason(unknown), "not_a_contract");

    const proposed = yield* coordinator.proposeContract({
      missionId: mission.id,
      taskId: backend!.id,
      contract: { a: 1 },
    });
    yield* coordinator.acknowledgeContract({
      missionId: mission.id,
      contractEventId: proposed.id,
      acknowledgedBy: "human",
    });
    const again = yield* Effect.flip(
      coordinator.acknowledgeContract({
        missionId: mission.id,
        contractEventId: proposed.id,
        acknowledgedBy: "human",
      }),
    );
    assert.equal(transitionReason(again), "already_acknowledged");
    assert.equal(launches.length, 2);
  }).pipe(
    Effect.provide(layerFor(Layer.succeed(ForgeRouter.ForgeRouter, ForgeRouter.makeWithConfig(jevConfig, jevSays("parallel_agents", 0.93))))),
  ),
);

it.effect("a mission is integrating only after every task completed, and a failure fails it", () =>
  Effect.gen(function* () {
    const coordinator = yield* setup;
    const store = yield* ForgeMissionStore.ForgeMissionStore;
    const { mission, tasks } = yield* start(coordinator);
    const [backend, frontend] = tasks;

    const early = yield* Effect.flip(
      coordinator.completeTask({ missionId: mission.id, taskId: frontend!.id }),
    );
    assert.equal(transitionReason(early), "task_not_running");

    const proposed = yield* coordinator.proposeContract({
      missionId: mission.id,
      taskId: backend!.id,
      contract: {},
    });
    yield* coordinator.acknowledgeContract({
      missionId: mission.id,
      contractEventId: proposed.id,
      acknowledgedBy: "human",
    });
    yield* coordinator.completeTask({ missionId: mission.id, taskId: backend!.id });
    const stillRunning = yield* store.getMission(mission.id);
    assert.equal(stillRunning._tag === "Some" && stillRunning.value.status, "running");

    yield* coordinator.completeTask({
      missionId: mission.id,
      taskId: frontend!.id,
      changedFiles: ["src/Login.tsx"],
    });
    const done = yield* store.getMission(mission.id);
    assert.equal(done._tag === "Some" && done.value.status, "integrating");
  }).pipe(
    Effect.provide(layerFor(Layer.succeed(ForgeRouter.ForgeRouter, ForgeRouter.makeWithConfig(jevConfig, jevSays("parallel_agents", 0.93))))),
  ),
);

it.effect("verification passes only on a real zero exit code, in order, from integrating", () =>
  Effect.gen(function* () {
    const coordinator = yield* setup;
    const store = yield* ForgeMissionStore.ForgeMissionStore;
    const log = yield* ForgeEventLog.ForgeEventLog;
    const { mission, tasks } = yield* coordinator.startMission({
      projectId: "p1",
      title: "Tiny",
      description: "tiny",
      plan,
      parallelismAvailable: false,
    });
    const status = () =>
      store.getMission(mission.id).pipe(
        Effect.map((m) => (m._tag === "Some" ? m.value.status : "missing")),
      );

    const tooEarly = yield* Effect.flip(
      coordinator.startVerification({ missionId: mission.id, command: "node --test", cwd: "/x" }),
    );
    assert.equal(transitionReason(tooEarly), "not_integrating");

    yield* coordinator.completeTask({ missionId: mission.id, taskId: tasks[0]!.id });
    assert.equal(yield* status(), "integrating");

    yield* coordinator.startVerification({ missionId: mission.id, command: "node --test", cwd: "/x" });
    assert.equal(yield* status(), "verifying");
    yield* coordinator.finishVerification({
      missionId: mission.id,
      command: "node --test",
      cwd: "/x",
      exitCode: 1,
      durationMs: 42,
      output: "1 failing JEV_API_KEY=apik_abcdefghijklmnop1234",
    });
    assert.equal(yield* status(), "failed");

    const events = yield* log.list({ missionId: mission.id });
    const finished = events.find((e) => e.type === "VERIFICATION_FINISHED")!;
    assert.equal(finished.payload.exitCode, 1);
    assert.equal(finished.payload.status, "failed");
    assert.equal(finished.causedByEventId, events.find((e) => e.type === "VERIFICATION_STARTED")!.id);
    // The verifier's output is stored through the redactor.
    assert.isFalse(String(finished.payload.output).includes("abcdefghijklmnop1234"));
  }).pipe(Effect.provide(layerFor(ForgeRouter.layerFromEnv({})))),
);

it.effect("graph edges are recorded once, with evidence, linked to the completed task", () =>
  Effect.gen(function* () {
    const coordinator = yield* setup;
    const log = yield* ForgeEventLog.ForgeEventLog;
    const { mission, tasks } = yield* coordinator.startMission({
      projectId: "p1",
      title: "Tiny",
      description: "tiny",
      plan,
      parallelismAvailable: false,
    });
    const completed = yield* coordinator.completeTask({ missionId: mission.id, taskId: tasks[0]!.id });
    const edge = {
      id: "imports:file:a.js->file:b.js",
      from: "file:a.js",
      to: "file:b.js",
      relation: "imports" as const,
      evidenceRef: "a.js:1",
      status: "verified" as const,
    };
    const first = yield* coordinator.recordGraphEdges({
      missionId: mission.id,
      taskId: tasks[0]!.id,
      edges: [edge],
    });
    const second = yield* coordinator.recordGraphEdges({
      missionId: mission.id,
      taskId: tasks[0]!.id,
      edges: [edge],
    });
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(first[0]!.evidenceRef, "a.js:1");
    assert.equal(first[0]!.causedByEventId, completed.id);
    assert.equal((yield* log.list({ missionId: mission.id })).filter((e) => e.type === "GRAPH_EDGE_ADDED").length, 1);
  }).pipe(Effect.provide(layerFor(ForgeRouter.layerFromEnv({})))),
);

it.effect("a single-agent mission writes exactly the expected causal chain to the database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const coordinator = yield* setup;
    const { mission } = yield* coordinator.startMission({
      projectId: "p1",
      title: "Add mock Google OAuth-style sign-in using the existing auth",
      description: "Reuse existing authentication patterns.",
      plan,
      parallelismAvailable: false,
    });
    const rows = yield* sql<{
      readonly id: string;
      readonly type: string;
      readonly caused_by_event_id: string | null;
    }>`
      SELECT id, type, caused_by_event_id FROM forge_events
      WHERE mission_id = ${mission.id} ORDER BY seq
    `;
    assert.deepEqual(rows.map((r) => r.type), [
      "MISSION_CREATED",
      "MEMORY_RETRIEVED",
      "DECISION_MADE",
      "TASK_CREATED",
      "TASK_STARTED",
    ]);
    // Each event after the first names the one that caused it.
    assert.equal(rows[0]!.caused_by_event_id, null);
    assert.equal(rows[1]!.caused_by_event_id, rows[0]!.id);
    assert.equal(rows[2]!.caused_by_event_id, rows[1]!.id);
    assert.equal(rows[3]!.caused_by_event_id, rows[2]!.id);
    assert.equal(rows[4]!.caused_by_event_id, rows[3]!.id);
  }).pipe(Effect.provide(layerFor(ForgeRouter.layerFromEnv({})))),
);
