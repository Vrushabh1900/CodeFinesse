/**
 * ForgeTaskReactor - connects Forge tasks to the T3 threads running them.
 *
 * Every few seconds it looks at each running Forge task's thread: records the
 * worktree once T3 has provisioned it, proposes the API contract the agent
 * wrote to `.forge/contract.json`, and when the thread's run ends, completes
 * the task (with the files git reports changed and the import edges they
 * added) or fails it. Nothing is recorded that the thread did not actually do.
 *
 * @module ForgeTaskReactor
 */
import { ProjectId, ThreadId, type ForgeTask } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { CONTRACT_FILE } from "./contract.ts";
import * as ForgeCoordinator from "./ForgeCoordinator.ts";
import * as ForgeEventLog from "./ForgeEventLog.ts";
import * as ForgeMissionStore from "./ForgeMissionStore.ts";
import * as ForgeWorkspace from "./ForgeWorkspace.ts";
import { diffEdges, scanImports } from "./graphScanner.ts";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

export class ForgeTaskReactor extends Context.Service<
  ForgeTaskReactor,
  {
    /** Starts watching in the background for the lifetime of the scope. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /** One pass over every running task; exposed so tests can step it. */
    readonly tick: Effect.Effect<void>;
  }
>()("t3/forge/ForgeTaskReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const missions = yield* ForgeMissionStore.ForgeMissionStore;
  const log = yield* ForgeEventLog.ForgeEventLog;
  const coordinator = yield* ForgeCoordinator.ForgeCoordinator;
  const workspace = yield* ForgeWorkspace.ForgeWorkspace;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;

  const watchTask = Effect.fn("ForgeTaskReactor.watchTask")(function* (task: ForgeTask) {
    if (task.agentThreadId === undefined) return;
    const found = yield* missions.getMission(task.missionId);
    if (Option.isNone(found)) return;
    const mission = found.value;
    const threadId = ThreadId.make(task.agentThreadId);

    let worktree = task.worktreePath;
    if (worktree === undefined) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell !== null && shell.worktreePath !== null) {
        worktree = shell.worktreePath;
        yield* missions.updateTask({ taskId: task.id, status: "running", worktreePath: worktree });
      }
    }

    const siblings = yield* missions.listTasks(mission.id);
    const needsContract =
      task.role === "backend" &&
      siblings.some((other) => other.status === "blocked" && other.dependsOn.includes(task.id));
    let proposed = (yield* log.list({ missionId: mission.id })).some(
      (event) => event.type === "CONTRACT_PROPOSED" && event.taskId === task.id,
    );
    const proposeIfPublished = Effect.gen(function* () {
      if (!needsContract || proposed || worktree === undefined) return;
      const contract = yield* workspace.readContract(worktree);
      if (Option.isNone(contract)) return;
      yield* coordinator.proposeContract({
        missionId: mission.id,
        taskId: task.id,
        contract: { ...contract.value },
      });
      proposed = true;
    });
    yield* proposeIfPublished;

    const latest = yield* threads.waitForThread({
      projectId: ProjectId.make(mission.projectId),
      threadId,
      timeoutMs: 1,
    });
    const status = latest.run?.status;
    if (status === undefined || !TERMINAL_RUN_STATUSES.has(status)) return;

    if (status !== "completed") {
      yield* coordinator.failTask({
        missionId: mission.id,
        taskId: task.id,
        reason: `The agent's thread run ended as ${status}.`,
      });
      return;
    }
    // The contract may have been written in the run's last moments.
    yield* proposeIfPublished;
    if (needsContract && !proposed) {
      yield* coordinator.failTask({
        missionId: mission.id,
        taskId: task.id,
        reason: `The agent finished without publishing ${CONTRACT_FILE}.`,
      });
      return;
    }

    const changed =
      worktree === undefined
        ? []
        : (yield* workspace.changes(worktree).pipe(Effect.orElseSucceed(() => []))).map(
            (change) => change.path,
          );
    yield* coordinator.completeTask({
      missionId: mission.id,
      taskId: task.id,
      summary: "Agent thread run completed",
      changedFiles: changed,
    });

    if (worktree !== undefined) {
      const project = yield* projects.getById(ProjectId.make(mission.projectId));
      if (Option.isSome(project)) {
        const base = scanImports((yield* workspace.scan(project.value.workspaceRoot)).files);
        const work = scanImports((yield* workspace.scan(worktree)).files);
        const added = diffEdges(base, work).filter((edge) => edge.relation === "imports");
        yield* coordinator.recordGraphEdges({ missionId: mission.id, taskId: task.id, edges: added });
      }
    }
  });

  const tick: ForgeTaskReactor["Service"]["tick"] = Effect.gen(function* () {
    const running = yield* missions.listRunningTasks();
    for (const task of running) {
      yield* watchTask(task).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Forge reactor could not update a task").pipe(
            Effect.annotateLogs({ forgeTaskId: task.id, cause: String(cause) }),
          ),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Forge reactor pass failed").pipe(Effect.annotateLogs({ cause: String(cause) })),
    ),
  );

  const start: ForgeTaskReactor["Service"]["start"] = tick.pipe(
    Effect.repeat(Schedule.spaced("2 seconds")),
    Effect.asVoid,
    Effect.forkScoped,
    Effect.asVoid,
  );

  return ForgeTaskReactor.of({ start, tick });
});

export const layer = Layer.effect(ForgeTaskReactor, make);
