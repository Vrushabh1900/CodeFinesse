import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ForgeCoordinator from "./ForgeCoordinator.ts";
import * as ForgeEventLog from "./ForgeEventLog.ts";
import * as ForgeMemoryStore from "./ForgeMemoryStore.ts";
import * as ForgeMissionStore from "./ForgeMissionStore.ts";
import * as ForgeRouter from "./ForgeRouter.ts";
import * as ForgeTaskReactor from "./ForgeTaskReactor.ts";
import * as ForgeThreadRunner from "./ForgeThreadRunner.ts";
import * as ForgeWorkspace from "./ForgeWorkspace.ts";

/** What the fake T3 reports per thread: its worktree (once provisioned) and its latest run status. */
const threadState = new Map<string, { worktreePath: string | null; status: string | null }>();
let projectRoot = "";

const FakeThreads = Layer.succeed(
  ThreadManagementService.ThreadManagementService,
  {
    getThreadShell: (threadId: string) =>
      Effect.succeed(
        threadState.has(threadId) ? { worktreePath: threadState.get(threadId)!.worktreePath } : null,
      ),
    waitForThread: (input: { readonly threadId: string }) =>
      Effect.succeed({
        threadId: input.threadId,
        run:
          threadState.get(input.threadId)?.status == null
            ? null
            : { status: threadState.get(input.threadId)!.status },
        timedOut: true,
      }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"],
);

const FakeProjects = Layer.succeed(
  ProjectService.ProjectService,
  {
    getById: () => Effect.sync(() => Option.some({ workspaceRoot: projectRoot })),
  } as unknown as ProjectService.ProjectService["Service"],
);

// T3 provisions worktrees asynchronously, so a fresh launch reports none.
const FakeRunner = Layer.succeed(
  ForgeThreadRunner.ForgeThreadRunner,
  ForgeThreadRunner.ForgeThreadRunner.of({
    launch: (input) =>
      Effect.sync(() => {
        const threadId = `thread-${input.role}`;
        threadState.set(threadId, { worktreePath: null, status: "running" });
        return { threadId };
      }),
  }),
);

const TestLayer = ForgeTaskReactor.layer.pipe(
  Layer.provideMerge(
    ForgeCoordinator.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(ForgeRouter.layerFromEnv({}), FakeRunner, ForgeWorkspace.layer, FakeThreads, FakeProjects),
      ),
      Layer.provideMerge(
        Layer.mergeAll(ForgeEventLog.layer, ForgeMissionStore.layer, ForgeMemoryStore.layer),
      ),
    ),
  ),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  Layer.provideMerge(NodeServices.layer),
);

const setup = Effect.gen(function* () {
  threadState.clear();
  yield* runMigrations();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "forge-reactor-" });
  projectRoot = path.join(root, "project");
  const worktree = path.join(root, "wt-backend");
  for (const dir of [projectRoot, path.join(worktree, ".forge"), path.join(worktree, "server")]) {
    yield* fs.makeDirectory(dir, { recursive: true });
  }
  yield* fs.writeFileString(path.join(projectRoot, "auth.js"), "module.exports = {};\n");
  const coordinator = yield* ForgeCoordinator.ForgeCoordinator;
  const { mission, tasks } = yield* coordinator.startMission({
    projectId: "p1",
    title: "Mock sign-in",
    description: "Two areas",
    plan: [
      { role: "backend", title: "Backend", instruction: "route" },
      { role: "frontend", title: "Frontend", instruction: "button", dependsOnRoles: ["backend"] },
    ],
  });
  return {
    fs,
    path,
    worktree,
    mission,
    backend: tasks.find((t) => t.role === "backend")!,
    frontend: tasks.find((t) => t.role === "frontend")!,
    coordinator,
    reactor: yield* ForgeTaskReactor.ForgeTaskReactor,
    log: yield* ForgeEventLog.ForgeEventLog,
    store: yield* ForgeMissionStore.ForgeMissionStore,
  };
});

it.effect("follows a real thread: worktree, contract proposal, completion with graph evidence", () =>
  Effect.gen(function* () {
    const { fs, path, worktree, mission, backend, frontend, coordinator, reactor, log, store } =
      yield* setup;
    const types = () => log.list({ missionId: mission.id }).pipe(Effect.map((es) => es.map((e) => e.type)));

    yield* reactor.tick;
    assert.isUndefined(
      Option.getOrUndefined(yield* store.getTask(backend.id))?.worktreePath,
      "no worktree is recorded before T3 provisions one",
    );

    threadState.set("thread-backend", { worktreePath: worktree, status: "running" });
    yield* reactor.tick;
    assert.equal(Option.getOrUndefined(yield* store.getTask(backend.id))?.worktreePath, worktree);
    assert.notInclude(yield* types(), "CONTRACT_PROPOSED");

    yield* fs.writeFileString(
      path.join(worktree, ".forge", "contract.json"),
      JSON.stringify({ endpoint: "POST /auth/google-mock", response: { token: "string" } }),
    );
    yield* fs.writeFileString(path.join(worktree, "auth.js"), "module.exports = {};\n");
    yield* fs.writeFileString(path.join(worktree, "server", "route.js"), "require('../auth');\n");
    yield* reactor.tick;
    yield* reactor.tick;
    const proposals = (yield* log.list({ missionId: mission.id })).filter((e) => e.type === "CONTRACT_PROPOSED");
    assert.equal(proposals.length, 1, "a contract is proposed exactly once");
    assert.equal(Option.getOrUndefined(yield* store.getTask(frontend.id))?.status, "blocked");

    threadState.set("thread-backend", { worktreePath: worktree, status: "completed" });
    yield* reactor.tick;
    assert.equal(Option.getOrUndefined(yield* store.getTask(backend.id))?.status, "completed");
    const edge = (yield* log.list({ missionId: mission.id })).find((e) => e.type === "GRAPH_EDGE_ADDED");
    assert.equal(edge?.payload.id, "imports:file:server/route.js->file:auth.js");
    assert.equal(edge?.evidenceRef, "server/route.js:1");

    yield* coordinator.acknowledgeContract({
      missionId: mission.id,
      contractEventId: proposals[0]!.id,
      acknowledgedBy: "user",
    });
    threadState.set("thread-frontend", { worktreePath: null, status: "failed" });
    yield* reactor.tick;
    assert.equal(Option.getOrUndefined(yield* store.getTask(frontend.id))?.status, "failed");
    const failed = (yield* log.list({ missionId: mission.id })).find((e) => e.type === "TASK_FAILED");
    assert.include(String(failed?.payload.reason), "failed");
    assert.equal(Option.getOrUndefined(yield* store.getMission(mission.id))?.status, "failed");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("fails a backend thread that completes without publishing its contract", () =>
  Effect.gen(function* () {
    const { worktree, mission, backend, reactor, log, store } = yield* setup;
    threadState.set("thread-backend", { worktreePath: worktree, status: "completed" });
    yield* reactor.tick;
    assert.equal(Option.getOrUndefined(yield* store.getTask(backend.id))?.status, "failed");
    const failed = (yield* log.list({ missionId: mission.id })).find((e) => e.type === "TASK_FAILED");
    assert.include(String(failed?.payload.reason), ".forge/contract.json");
    assert.isFalse((yield* log.list({ missionId: mission.id })).some((e) => e.type === "TASK_COMPLETED"));
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
