/**
 * ForgeMissionStore - persistence for Forge missions and their tasks.
 *
 * Status changes are plain writes here; the coordinator decides when a
 * transition is legal and records the matching audit event.
 *
 * @module ForgeMissionStore
 */
import {
  ForgeMission,
  ForgeTask,
  type ForgeMissionStatus,
  type ForgeTaskStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PersistenceDecodeError,
  type PersistenceSqlError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";

export type ForgeMissionStoreError = PersistenceSqlError | PersistenceDecodeError;

interface MissionRow {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TaskRow {
  readonly id: string;
  readonly mission_id: string;
  readonly role: string;
  readonly status: string;
  readonly depends_on_json: string;
  readonly agent_thread_id: string | null;
  readonly worktree_path: string | null;
}

const DependsOnJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeDependsOn = Schema.decodeUnknownEffect(DependsOnJson);
const encodeDependsOn = Schema.encodeUnknownEffect(DependsOnJson);
const decodeMission = Schema.decodeUnknownEffect(ForgeMission);
const decodeTask = Schema.decodeUnknownEffect(ForgeTask);

export interface NewForgeMission {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly now: string;
}

export interface NewForgeTask {
  readonly id: string;
  readonly missionId: string;
  readonly role: ForgeTask["role"];
  readonly status: ForgeTaskStatus;
  readonly dependsOn: ReadonlyArray<string>;
}

export class ForgeMissionStore extends Context.Service<
  ForgeMissionStore,
  {
    readonly createMission: (
      input: NewForgeMission,
    ) => Effect.Effect<ForgeMission, ForgeMissionStoreError>;
    readonly getMission: (
      missionId: string,
    ) => Effect.Effect<Option.Option<ForgeMission>, ForgeMissionStoreError>;
    readonly listMissions: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<ForgeMission>, ForgeMissionStoreError>;
    readonly setMissionStatus: (input: {
      readonly missionId: string;
      readonly status: ForgeMissionStatus;
      readonly now: string;
    }) => Effect.Effect<void, ForgeMissionStoreError>;
    readonly createTask: (input: NewForgeTask) => Effect.Effect<ForgeTask, ForgeMissionStoreError>;
    readonly getTask: (
      taskId: string,
    ) => Effect.Effect<Option.Option<ForgeTask>, ForgeMissionStoreError>;
    readonly listTasks: (
      missionId: string,
    ) => Effect.Effect<ReadonlyArray<ForgeTask>, ForgeMissionStoreError>;
    /** Every running task that has an agent thread, across missions; what the reactor watches. */
    readonly listRunningTasks: () => Effect.Effect<ReadonlyArray<ForgeTask>, ForgeMissionStoreError>;
    readonly updateTask: (input: {
      readonly taskId: string;
      readonly status: ForgeTaskStatus;
      readonly agentThreadId?: string;
      readonly worktreePath?: string;
    }) => Effect.Effect<void, ForgeMissionStoreError>;
  }
>()("t3/forge/ForgeMissionStore") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const missionFromRow = (operation: string, row: MissionRow) =>
    decodeMission({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }).pipe(Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError(operation, cause)));

  const taskFromRow = (operation: string, row: TaskRow) =>
    decodeDependsOn(row.depends_on_json).pipe(
      Effect.flatMap((dependsOn) =>
        decodeTask({
          id: row.id,
          missionId: row.mission_id,
          role: row.role,
          status: row.status,
          dependsOn,
          ...(row.agent_thread_id === null ? {} : { agentThreadId: row.agent_thread_id }),
          ...(row.worktree_path === null ? {} : { worktreePath: row.worktree_path }),
        }),
      ),
      Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError(operation, cause)),
    );

  const createMission: ForgeMissionStore["Service"]["createMission"] = Effect.fn(
    "ForgeMissionStore.createMission",
  )(function* (input) {
    const rows = yield* sql<MissionRow>`
      INSERT INTO forge_missions (id, project_id, title, description, status, created_at, updated_at)
      VALUES (${input.id}, ${input.projectId}, ${input.title}, ${input.description}, 'created', ${input.now}, ${input.now})
      RETURNING *
    `.pipe(Effect.mapError(toPersistenceSqlError("ForgeMissionStore.createMission:insert")));
    return yield* missionFromRow("ForgeMissionStore.createMission:decode", rows[0]!);
  });

  const getMission: ForgeMissionStore["Service"]["getMission"] = Effect.fn(
    "ForgeMissionStore.getMission",
  )(function* (missionId) {
    const rows = yield* sql<MissionRow>`SELECT * FROM forge_missions WHERE id = ${missionId}`.pipe(
      Effect.mapError(toPersistenceSqlError("ForgeMissionStore.getMission:query")),
    );
    return rows[0] === undefined
      ? Option.none()
      : Option.some(yield* missionFromRow("ForgeMissionStore.getMission:decode", rows[0]));
  });

  const listMissions: ForgeMissionStore["Service"]["listMissions"] = Effect.fn(
    "ForgeMissionStore.listMissions",
  )(function* (projectId) {
    const rows = yield* sql<MissionRow>`
      SELECT * FROM forge_missions WHERE project_id = ${projectId} ORDER BY created_at DESC, id DESC
    `.pipe(Effect.mapError(toPersistenceSqlError("ForgeMissionStore.listMissions:query")));
    return yield* Effect.forEach(rows, (row) =>
      missionFromRow("ForgeMissionStore.listMissions:decode", row),
    );
  });

  const setMissionStatus: ForgeMissionStore["Service"]["setMissionStatus"] = Effect.fn(
    "ForgeMissionStore.setMissionStatus",
  )(function* ({ missionId, status, now }) {
    yield* sql`
      UPDATE forge_missions SET status = ${status}, updated_at = ${now} WHERE id = ${missionId}
    `.pipe(Effect.mapError(toPersistenceSqlError("ForgeMissionStore.setMissionStatus:update")));
  });

  const createTask: ForgeMissionStore["Service"]["createTask"] = Effect.fn(
    "ForgeMissionStore.createTask",
  )(function* (input) {
    const dependsOnJson = yield* encodeDependsOn(input.dependsOn).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError("ForgeMissionStore.createTask:encode", cause),
      ),
    );
    const rows = yield* sql<TaskRow>`
      INSERT INTO forge_tasks (id, mission_id, role, status, depends_on_json)
      VALUES (${input.id}, ${input.missionId}, ${input.role}, ${input.status}, ${dependsOnJson})
      RETURNING *
    `.pipe(Effect.mapError(toPersistenceSqlError("ForgeMissionStore.createTask:insert")));
    return yield* taskFromRow("ForgeMissionStore.createTask:decode", rows[0]!);
  });

  const getTask: ForgeMissionStore["Service"]["getTask"] = Effect.fn("ForgeMissionStore.getTask")(
    function* (taskId) {
      const rows = yield* sql<TaskRow>`SELECT * FROM forge_tasks WHERE id = ${taskId}`.pipe(
        Effect.mapError(toPersistenceSqlError("ForgeMissionStore.getTask:query")),
      );
      return rows[0] === undefined
        ? Option.none()
        : Option.some(yield* taskFromRow("ForgeMissionStore.getTask:decode", rows[0]));
    },
  );

  const listTasks: ForgeMissionStore["Service"]["listTasks"] = Effect.fn(
    "ForgeMissionStore.listTasks",
  )(function* (missionId) {
    const rows = yield* sql<TaskRow>`
      SELECT * FROM forge_tasks WHERE mission_id = ${missionId} ORDER BY rowid ASC
    `.pipe(Effect.mapError(toPersistenceSqlError("ForgeMissionStore.listTasks:query")));
    return yield* Effect.forEach(rows, (row) =>
      taskFromRow("ForgeMissionStore.listTasks:decode", row),
    );
  });

  const listRunningTasks: ForgeMissionStore["Service"]["listRunningTasks"] = Effect.fn(
    "ForgeMissionStore.listRunningTasks",
  )(function* () {
    const rows = yield* sql<TaskRow>`
      SELECT * FROM forge_tasks
      WHERE status = 'running' AND agent_thread_id IS NOT NULL
      ORDER BY rowid ASC
    `.pipe(Effect.mapError(toPersistenceSqlError("ForgeMissionStore.listRunningTasks:query")));
    return yield* Effect.forEach(rows, (row) =>
      taskFromRow("ForgeMissionStore.listRunningTasks:decode", row),
    );
  });

  const updateTask: ForgeMissionStore["Service"]["updateTask"] = Effect.fn(
    "ForgeMissionStore.updateTask",
  )(function* ({ taskId, status, agentThreadId, worktreePath }) {
    yield* sql`
      UPDATE forge_tasks
      SET status = ${status},
          agent_thread_id = COALESCE(${agentThreadId ?? null}, agent_thread_id),
          worktree_path = COALESCE(${worktreePath ?? null}, worktree_path)
      WHERE id = ${taskId}
    `.pipe(Effect.mapError(toPersistenceSqlError("ForgeMissionStore.updateTask:update")));
  });

  return ForgeMissionStore.of({
    createMission,
    getMission,
    listMissions,
    setMissionStatus,
    createTask,
    getTask,
    listTasks,
    listRunningTasks,
    updateTask,
  });
});

export const layer = Layer.effect(ForgeMissionStore, make);
