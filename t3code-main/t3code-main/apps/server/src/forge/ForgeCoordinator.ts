/**
 * ForgeCoordinator - runs a Forge mission as real state transitions.
 *
 * Every transition appends an audit event first-hand: nothing is recorded
 * unless the state it describes changed. The route decision decides how many
 * tasks exist, a blocked task starts only after the server has recorded an
 * acknowledgment of a contract proposed by the task it depends on, and a
 * mission becomes `integrating` only once every task has actually completed.
 *
 * @module ForgeCoordinator
 */
import type {
  ForgeDecision,
  ForgeEvent,
  ForgeGraphEdge,
  ForgeEventType,
  ForgeMemory,
  ForgeMission,
  ForgeTask,
  ForgeTaskRole,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ForgeEventLog from "./ForgeEventLog.ts";
import * as ForgeMemoryStore from "./ForgeMemoryStore.ts";
import * as ForgeMissionStore from "./ForgeMissionStore.ts";
import * as ForgeRouter from "./ForgeRouter.ts";
import * as ForgeThreadRunner from "./ForgeThreadRunner.ts";

export class ForgeMissionNotFoundError extends Schema.TaggedError<ForgeMissionNotFoundError>()(
  "ForgeMissionNotFoundError",
  { missionId: Schema.String },
) {
  override get message(): string {
    return `Forge mission ${this.missionId} does not exist.`;
  }
}

export class ForgeTaskNotFoundError extends Schema.TaggedError<ForgeTaskNotFoundError>()(
  "ForgeTaskNotFoundError",
  { missionId: Schema.String, taskId: Schema.String },
) {
  override get message(): string {
    return `Forge task ${this.taskId} is not part of mission ${this.missionId}.`;
  }
}

/** The requested transition is not legal from the task or contract's current state. */
export class ForgeTransitionError extends Schema.TaggedError<ForgeTransitionError>()(
  "ForgeTransitionError",
  {
    missionId: Schema.String,
    reason: Schema.Literals([
      "task_not_running",
      "no_dependent_task",
      "not_a_contract",
      "already_acknowledged",
      "dependent_not_blocked",
      "empty_plan",
      "not_integrating",
      "not_verifying",
    ]),
  },
) {
  override get message(): string {
    return `Forge mission ${this.missionId} rejected the transition: ${this.reason}.`;
  }
}

export type ForgeCoordinatorError =
  | ForgeMissionStore.ForgeMissionStoreError
  | ForgeMemoryStore.ForgeMemoryStoreError
  | ForgeEventLog.ForgeEventLogError
  | ForgeThreadRunner.ForgeThreadRunnerError
  | ForgeMissionNotFoundError
  | ForgeTaskNotFoundError
  | ForgeTransitionError;

export interface PlannedTask {
  readonly role: ForgeTaskRole;
  readonly title: string;
  readonly instruction: string;
  /** Roles of earlier planned tasks this one waits on. */
  readonly dependsOnRoles?: ReadonlyArray<ForgeTaskRole>;
}

export interface StartMissionInput {
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly plan: ReadonlyArray<PlannedTask>;
  /** False when a second concurrent agent session cannot be started. */
  readonly parallelismAvailable?: boolean;
}

export interface StartedMission {
  readonly mission: ForgeMission;
  readonly tasks: ReadonlyArray<ForgeTask>;
  readonly decision: ForgeDecision;
  readonly memories: ReadonlyArray<ForgeMemory>;
}

/** The prompt an agent receives: its task, the project's decisions, and any acknowledged contract. */
export function buildTaskPrompt(input: {
  readonly missionTitle: string;
  readonly instruction: string;
  readonly memories: ReadonlyArray<ForgeMemory>;
  readonly contract?: Record<string, unknown>;
}): string {
  const sections = [`Mission: ${input.missionTitle}`, `Your task: ${input.instruction}`];
  if (input.memories.length > 0) {
    sections.push(
      [
        "Project decisions you must follow:",
        ...input.memories.map((memory) => `- ${memory.title}: ${memory.body}`),
      ].join("\n"),
    );
  }
  if (input.contract !== undefined) {
    sections.push(
      `Agreed API contract (acknowledged; implement against it exactly):\n${JSON.stringify(input.contract, null, 2)}`,
    );
  }
  return sections.join("\n\n");
}

export class ForgeCoordinator extends Context.Service<
  ForgeCoordinator,
  {
    readonly startMission: (
      input: StartMissionInput,
    ) => Effect.Effect<StartedMission, ForgeCoordinatorError>;
    /** The task that owns the contract publishes it; the dependent task stays blocked. */
    readonly proposeContract: (input: {
      readonly missionId: string;
      readonly taskId: string;
      readonly contract: Record<string, unknown>;
    }) => Effect.Effect<ForgeEvent, ForgeCoordinatorError>;
    /** Records the acknowledgment, then unblocks and starts the dependent task. */
    readonly acknowledgeContract: (input: {
      readonly missionId: string;
      readonly contractEventId: string;
      readonly acknowledgedBy: string;
    }) => Effect.Effect<ForgeEvent, ForgeCoordinatorError>;
    readonly completeTask: (input: {
      readonly missionId: string;
      readonly taskId: string;
      readonly summary?: string;
      readonly changedFiles?: ReadonlyArray<string>;
    }) => Effect.Effect<ForgeEvent, ForgeCoordinatorError>;
    readonly failTask: (input: {
      readonly missionId: string;
      readonly taskId: string;
      readonly reason: string;
    }) => Effect.Effect<ForgeEvent, ForgeCoordinatorError>;
    /** Records something a running agent actually did; rejected once the task is no longer running. */
    readonly recordAgentActivity: (input: {
      readonly missionId: string;
      readonly taskId: string;
      readonly activity: string;
      readonly detail?: Record<string, unknown>;
      readonly evidenceRef?: string;
    }) => Effect.Effect<ForgeEvent, ForgeCoordinatorError>;
    /** Records edges a task's real changes added to the graph, each with its source evidence. */
    readonly recordGraphEdges: (input: {
      readonly missionId: string;
      readonly taskId: string;
      readonly edges: ReadonlyArray<ForgeGraphEdge>;
    }) => Effect.Effect<ReadonlyArray<ForgeEvent>, ForgeCoordinatorError>;
    /** `integrating` -> `verifying`; the caller then runs the command and calls `finishVerification`. */
    readonly startVerification: (input: {
      readonly missionId: string;
      readonly command: string;
      readonly cwd: string;
      /** Facts about the merge being verified, such as applied files and conflicts. */
      readonly detail?: Record<string, unknown>;
    }) => Effect.Effect<ForgeEvent, ForgeCoordinatorError>;
    /** `passed` only when the process really exited 0; anything else is `failed`. */
    readonly finishVerification: (input: {
      readonly missionId: string;
      readonly command: string;
      readonly cwd: string;
      readonly exitCode: number;
      readonly durationMs: number;
      readonly output: string;
    }) => Effect.Effect<ForgeEvent, ForgeCoordinatorError>;
  }
>()("t3/forge/ForgeCoordinator") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const log = yield* ForgeEventLog.ForgeEventLog;
  const missions = yield* ForgeMissionStore.ForgeMissionStore;
  const memoryStore = yield* ForgeMemoryStore.ForgeMemoryStore;
  const router = yield* ForgeRouter.ForgeRouter;
  const runner = yield* ForgeThreadRunner.ForgeThreadRunner;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);

  const emit = Effect.fn("ForgeCoordinator.emit")(function* (input: {
    readonly missionId: string;
    readonly type: ForgeEventType;
    readonly source: string;
    readonly taskId?: string;
    readonly recipient?: string;
    readonly causedByEventId?: string;
    readonly payload?: Record<string, unknown>;
    readonly evidenceRef?: string;
  }) {
    return yield* log.append({
      id: yield* newId,
      missionId: input.missionId,
      type: input.type,
      source: input.source,
      timestamp: yield* nowIso,
      payload: input.payload ?? {},
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.recipient === undefined ? {} : { recipient: input.recipient }),
      ...(input.causedByEventId === undefined ? {} : { causedByEventId: input.causedByEventId }),
      ...(input.evidenceRef === undefined ? {} : { evidenceRef: input.evidenceRef }),
    });
  });

  const setMissionStatus = (missionId: string, status: ForgeMission["status"]) =>
    nowIso.pipe(Effect.flatMap((now) => missions.setMissionStatus({ missionId, status, now })));

  const requireMission = Effect.fn("ForgeCoordinator.requireMission")(function* (
    missionId: string,
  ) {
    const mission = yield* missions.getMission(missionId);
    return Option.isSome(mission)
      ? mission.value
      : yield* new ForgeMissionNotFoundError({ missionId });
  });

  const requireTask = Effect.fn("ForgeCoordinator.requireTask")(function* (
    missionId: string,
    taskId: string,
  ) {
    const task = yield* missions.getTask(taskId);
    return Option.isSome(task) && task.value.missionId === missionId
      ? task.value
      : yield* new ForgeTaskNotFoundError({ missionId, taskId });
  });

  /** Latest event of `type` for a task, used as the causal parent of what follows. */
  const latestEventFor = (events: ReadonlyArray<ForgeEvent>, type: ForgeEventType, taskId: string) =>
    events.findLast((event) => event.type === type && event.taskId === taskId);

  const startTask = Effect.fn("ForgeCoordinator.startTask")(function* (input: {
    readonly mission: ForgeMission;
    readonly task: ForgeTask;
    readonly instruction: string;
    readonly memories: ReadonlyArray<ForgeMemory>;
    readonly contract?: Record<string, unknown>;
    readonly isolatedWorktree: boolean;
    readonly causedByEventId: string | undefined;
  }) {
    const started = yield* runner.launch({
      missionId: input.mission.id,
      taskId: input.task.id,
      projectId: input.mission.projectId,
      role: input.task.role,
      title: `${input.mission.title} (${input.task.role})`,
      prompt: buildTaskPrompt({
        missionTitle: input.mission.title,
        instruction: input.instruction,
        memories: input.memories,
        ...(input.contract === undefined ? {} : { contract: input.contract }),
      }),
      isolatedWorktree: input.isolatedWorktree,
    });
    yield* missions.updateTask({
      taskId: input.task.id,
      status: "running",
      agentThreadId: started.threadId,
      ...(started.worktreePath === undefined ? {} : { worktreePath: started.worktreePath }),
    });
    return yield* emit({
      missionId: input.mission.id,
      type: "TASK_STARTED",
      source: "coordinator",
      taskId: input.task.id,
      payload: {
        role: input.task.role,
        agentThreadId: started.threadId,
        worktreePath: started.worktreePath ?? null,
      },
      ...(input.causedByEventId === undefined ? {} : { causedByEventId: input.causedByEventId }),
    });
  });

  const startMission: ForgeCoordinator["Service"]["startMission"] = Effect.fn(
    "ForgeCoordinator.startMission",
  )(function* (input) {
    if (input.plan.length === 0) {
      return yield* new ForgeTransitionError({ missionId: "(new)", reason: "empty_plan" });
    }
    const missionId = yield* newId;
    const created = yield* missions.createMission({
      id: missionId,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      now: yield* nowIso,
    });
    const createdEvent = yield* emit({
      missionId,
      type: "MISSION_CREATED",
      source: "user",
      payload: { title: input.title },
    });
    yield* setMissionStatus(missionId, "planning");

    const memories = yield* memoryStore.retrieve({
      projectId: input.projectId,
      query: `${input.title} ${input.description}`,
    });
    const memoryEvent = yield* emit({
      missionId,
      type: "MEMORY_RETRIEVED",
      source: "project-brain",
      causedByEventId: createdEvent.id,
      payload: {
        memoryIds: memories.map((memory) => memory.id),
        titles: memories.map((memory) => memory.title),
      },
    });

    const parallelismAvailable = input.parallelismAvailable ?? true;
    const decision = yield* router.decideRoute({
      missionId,
      title: input.title,
      description: input.description,
      affectedAreas: new Set(input.plan.map((task) => task.role)).size,
      independentSubtasks: input.plan.filter((task) => (task.dependsOnRoles ?? []).length === 0)
        .length,
      parallelismAvailable,
    });
    const decisionEvent = yield* emit({
      missionId,
      type: "DECISION_MADE",
      source: decision.provider,
      causedByEventId: memoryEvent.id,
      payload: { decision },
    });

    // The decision changes scheduling: one collapsed task, or the planned DAG.
    const single = decision.selection === "single_agent";
    const planned: ReadonlyArray<PlannedTask> = single
      ? [
          {
            role: "single",
            title: input.title,
            instruction: input.plan.map((task) => task.instruction).join("\n"),
          },
        ]
      : input.plan;

    const taskByRole = new Map<ForgeTaskRole, ForgeTask>();
    const instructions = new Map<string, string>();
    const createdEvents = new Map<string, ForgeEvent>();
    for (const item of planned) {
      const dependsOn = (item.dependsOnRoles ?? []).flatMap((role) => {
        const dependency = taskByRole.get(role);
        return dependency === undefined ? [] : [dependency.id];
      });
      const task = yield* missions.createTask({
        id: yield* newId,
        missionId,
        role: item.role,
        status: dependsOn.length === 0 ? "queued" : "blocked",
        dependsOn,
      });
      taskByRole.set(item.role, task);
      instructions.set(task.id, item.instruction);
      createdEvents.set(
        task.id,
        yield* emit({
          missionId,
          type: "TASK_CREATED",
          source: "coordinator",
          taskId: task.id,
          causedByEventId: decisionEvent.id,
          payload: {
            role: task.role,
            dependsOn,
            title: item.title,
            instruction: item.instruction,
          },
        }),
      );
    }

    const isolatedWorktree = planned.length > 1;
    for (const task of taskByRole.values()) {
      if (task.dependsOn.length > 0) continue;
      yield* startTask({
        mission: created,
        task,
        instruction: instructions.get(task.id)!,
        memories,
        isolatedWorktree,
        causedByEventId: createdEvents.get(task.id)?.id,
      });
    }
    yield* setMissionStatus(missionId, "running");

    const finalMission = yield* requireMission(missionId);
    return {
      mission: finalMission,
      tasks: yield* missions.listTasks(missionId),
      decision,
      memories,
    };
  });

  const proposeContract: ForgeCoordinator["Service"]["proposeContract"] = Effect.fn(
    "ForgeCoordinator.proposeContract",
  )(function* ({ missionId, taskId, contract }) {
    yield* requireMission(missionId);
    const task = yield* requireTask(missionId, taskId);
    if (task.status !== "running") {
      return yield* new ForgeTransitionError({ missionId, reason: "task_not_running" });
    }
    const dependent = (yield* missions.listTasks(missionId)).find(
      (other) => other.status === "blocked" && other.dependsOn.includes(taskId),
    );
    if (dependent === undefined) {
      return yield* new ForgeTransitionError({ missionId, reason: "no_dependent_task" });
    }
    const events = yield* log.list({ missionId });
    const proposed = yield* emit({
      missionId,
      type: "CONTRACT_PROPOSED",
      source: `task:${taskId}`,
      taskId,
      recipient: `task:${dependent.id}`,
      payload: { contract, dependentTaskId: dependent.id },
      ...(latestEventFor(events, "TASK_STARTED", taskId) === undefined
        ? {}
        : { causedByEventId: latestEventFor(events, "TASK_STARTED", taskId)!.id }),
    });
    yield* setMissionStatus(missionId, "waiting");
    return proposed;
  });

  const acknowledgeContract: ForgeCoordinator["Service"]["acknowledgeContract"] = Effect.fn(
    "ForgeCoordinator.acknowledgeContract",
  )(function* ({ missionId, contractEventId, acknowledgedBy }) {
    const mission = yield* requireMission(missionId);
    const events = yield* log.list({ missionId });
    const proposal = events.find(
      (event) => event.id === contractEventId && event.type === "CONTRACT_PROPOSED",
    );
    if (proposal === undefined) {
      return yield* new ForgeTransitionError({ missionId, reason: "not_a_contract" });
    }
    if (
      events.some(
        (event) =>
          event.type === "CONTRACT_ACKNOWLEDGED" && event.causedByEventId === contractEventId,
      )
    ) {
      return yield* new ForgeTransitionError({ missionId, reason: "already_acknowledged" });
    }
    const dependentTaskId = String(proposal.payload.dependentTaskId);
    const dependent = yield* requireTask(missionId, dependentTaskId);
    if (dependent.status !== "blocked") {
      return yield* new ForgeTransitionError({ missionId, reason: "dependent_not_blocked" });
    }

    const acknowledged = yield* emit({
      missionId,
      type: "CONTRACT_ACKNOWLEDGED",
      source: acknowledgedBy,
      taskId: dependentTaskId,
      ...(proposal.taskId === undefined ? {} : { recipient: `task:${proposal.taskId}` }),
      causedByEventId: contractEventId,
      payload: {},
    });
    yield* missions.updateTask({ taskId: dependentTaskId, status: "queued" });
    const unblocked = yield* emit({
      missionId,
      type: "TASK_UNBLOCKED",
      source: "coordinator",
      taskId: dependentTaskId,
      causedByEventId: acknowledged.id,
      payload: { contractEventId },
    });

    const memoryIds = events.find((event) => event.type === "MEMORY_RETRIEVED")?.payload.memoryIds;
    const memories = (yield* memoryStore.retrieve({
      projectId: mission.projectId,
      query: `${mission.title} ${mission.description}`,
    })).filter((memory) => !Array.isArray(memoryIds) || memoryIds.includes(memory.id));
    const created = events.find(
      (event) => event.type === "TASK_CREATED" && event.taskId === dependentTaskId,
    );
    yield* startTask({
      mission,
      task: dependent,
      instruction: String(created?.payload.instruction ?? mission.title),
      memories,
      contract: proposal.payload.contract as Record<string, unknown>,
      isolatedWorktree: true,
      causedByEventId: unblocked.id,
    });
    yield* setMissionStatus(missionId, "running");
    return acknowledged;
  });

  const completeTask: ForgeCoordinator["Service"]["completeTask"] = Effect.fn(
    "ForgeCoordinator.completeTask",
  )(function* ({ missionId, taskId, summary, changedFiles }) {
    yield* requireMission(missionId);
    const task = yield* requireTask(missionId, taskId);
    if (task.status !== "running") {
      return yield* new ForgeTransitionError({ missionId, reason: "task_not_running" });
    }
    const events = yield* log.list({ missionId });
    yield* missions.updateTask({ taskId, status: "completed" });
    const completed = yield* emit({
      missionId,
      type: "TASK_COMPLETED",
      source: `task:${taskId}`,
      taskId,
      payload: { summary: summary ?? null, changedFiles: changedFiles ?? [] },
      ...(latestEventFor(events, "TASK_STARTED", taskId) === undefined
        ? {}
        : { causedByEventId: latestEventFor(events, "TASK_STARTED", taskId)!.id }),
    });
    const tasks = yield* missions.listTasks(missionId);
    if (tasks.every((other) => other.status === "completed")) {
      yield* setMissionStatus(missionId, "integrating");
    }
    return completed;
  });

  const failTask: ForgeCoordinator["Service"]["failTask"] = Effect.fn("ForgeCoordinator.failTask")(
    function* ({ missionId, taskId, reason }) {
      yield* requireMission(missionId);
      const task = yield* requireTask(missionId, taskId);
      if (task.status !== "running") {
        return yield* new ForgeTransitionError({ missionId, reason: "task_not_running" });
      }
      const events = yield* log.list({ missionId });
      yield* missions.updateTask({ taskId, status: "failed" });
      const failed = yield* emit({
        missionId,
        type: "TASK_FAILED",
        source: `task:${taskId}`,
        taskId,
        payload: { reason },
        ...(latestEventFor(events, "TASK_STARTED", taskId) === undefined
          ? {}
          : { causedByEventId: latestEventFor(events, "TASK_STARTED", taskId)!.id }),
      });
      yield* setMissionStatus(missionId, "failed");
      return failed;
    },
  );

  const recordAgentActivity: ForgeCoordinator["Service"]["recordAgentActivity"] = Effect.fn(
    "ForgeCoordinator.recordAgentActivity",
  )(function* ({ missionId, taskId, activity, detail, evidenceRef }) {
    yield* requireMission(missionId);
    const task = yield* requireTask(missionId, taskId);
    if (task.status !== "running") {
      return yield* new ForgeTransitionError({ missionId, reason: "task_not_running" });
    }
    const events = yield* log.list({ missionId });
    const started = latestEventFor(events, "TASK_STARTED", taskId);
    return yield* emit({
      missionId,
      type: "AGENT_ACTIVITY",
      source: `task:${taskId}`,
      taskId,
      payload: { activity, ...detail },
      ...(evidenceRef === undefined ? {} : { evidenceRef }),
      ...(started === undefined ? {} : { causedByEventId: started.id }),
    });
  });

  const MAX_RECORDED_EDGES = 50;
  const MAX_OUTPUT_CHARS = 4_000;

  const recordGraphEdges: ForgeCoordinator["Service"]["recordGraphEdges"] = Effect.fn(
    "ForgeCoordinator.recordGraphEdges",
  )(function* ({ missionId, taskId, edges }) {
    yield* requireMission(missionId);
    yield* requireTask(missionId, taskId);
    const events = yield* log.list({ missionId });
    // Idempotent: an edge already recorded for this mission is not recorded twice.
    const known = new Set(
      events.filter((event) => event.type === "GRAPH_EDGE_ADDED").map((event) => event.payload.id),
    );
    const parent = latestEventFor(events, "TASK_COMPLETED", taskId);
    const recorded: ForgeEvent[] = [];
    for (const edge of edges.filter((candidate) => !known.has(candidate.id)).slice(0, MAX_RECORDED_EDGES)) {
      recorded.push(
        yield* emit({
          missionId,
          type: "GRAPH_EDGE_ADDED",
          source: "graph-scanner",
          taskId,
          evidenceRef: edge.evidenceRef,
          payload: { ...edge },
          ...(parent === undefined ? {} : { causedByEventId: parent.id }),
        }),
      );
    }
    return recorded;
  });

  const startVerification: ForgeCoordinator["Service"]["startVerification"] = Effect.fn(
    "ForgeCoordinator.startVerification",
  )(function* ({ missionId, command, cwd, detail }) {
    const mission = yield* requireMission(missionId);
    if (mission.status !== "integrating") {
      return yield* new ForgeTransitionError({ missionId, reason: "not_integrating" });
    }
    const events = yield* log.list({ missionId });
    const started = yield* emit({
      missionId,
      type: "VERIFICATION_STARTED",
      source: "verifier",
      payload: { ...detail, command, cwd },
      ...(events.findLast((event) => event.type === "TASK_COMPLETED") === undefined
        ? {}
        : { causedByEventId: events.findLast((event) => event.type === "TASK_COMPLETED")!.id }),
    });
    yield* setMissionStatus(missionId, "verifying");
    return started;
  });

  const finishVerification: ForgeCoordinator["Service"]["finishVerification"] = Effect.fn(
    "ForgeCoordinator.finishVerification",
  )(function* ({ missionId, command, cwd, exitCode, durationMs, output }) {
    const mission = yield* requireMission(missionId);
    if (mission.status !== "verifying") {
      return yield* new ForgeTransitionError({ missionId, reason: "not_verifying" });
    }
    const events = yield* log.list({ missionId });
    const started = events.findLast((event) => event.type === "VERIFICATION_STARTED");
    const passed = exitCode === 0;
    const finished = yield* emit({
      missionId,
      type: "VERIFICATION_FINISHED",
      source: "verifier",
      payload: {
        command,
        cwd,
        exitCode,
        durationMs,
        status: passed ? "passed" : "failed",
        output: output.slice(-MAX_OUTPUT_CHARS),
      },
      ...(started === undefined ? {} : { causedByEventId: started.id }),
    });
    yield* setMissionStatus(missionId, passed ? "passed" : "failed");
    return finished;
  });

  return ForgeCoordinator.of({
    startMission,
    proposeContract,
    acknowledgeContract,
    completeTask,
    failTask,
    recordAgentActivity,
    recordGraphEdges,
    startVerification,
    finishVerification,
  });
});

export const layer = Layer.effect(ForgeCoordinator, make);
