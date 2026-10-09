/**
 * ForgeMemoryStore - the Project Brain's local decision store.
 *
 * Developer decisions are saved here first; a hosted memory service is never a
 * dependency. Retrieval always includes global rules, then fills the remaining
 * slots with the memories that share the most words with the mission text. A
 * superseded memory is never returned as current truth.
 *
 * @module ForgeMemoryStore
 */
import { ForgeMemory } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PersistenceDecodeError,
  type PersistenceSqlError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";

export type ForgeMemoryStoreError = PersistenceSqlError | PersistenceDecodeError;

export const MAX_RETRIEVED_MEMORIES = 8;

interface MemoryRow {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly body: string;
  readonly is_global: number;
  readonly created_at: string;
  readonly superseded_by: string | null;
}

const decodeMemory = Schema.decodeUnknownEffect(ForgeMemory);

const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "not"]);

const tokens = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );

/**
 * Global memories first (oldest first, so the order is stable), then the
 * best-matching others. Memories sharing no word with the query are left out.
 */
export function rankMemories(
  memories: ReadonlyArray<ForgeMemory>,
  query: string,
  limit = MAX_RETRIEVED_MEMORIES,
): ForgeMemory[] {
  const active = memories.filter((memory) => memory.supersededBy === undefined);
  const globals = active
    .filter((memory) => memory.global)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const queryTokens = tokens(query);
  const scored = active
    .filter((memory) => !memory.global)
    .map((memory) => {
      const memoryTokens = tokens(`${memory.title} ${memory.body}`);
      let score = 0;
      for (const token of queryTokens) if (memoryTokens.has(token)) score += 1;
      return { memory, score };
    })
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));
  // Globals are never dropped to make room, even past the limit.
  const room = Math.max(0, limit - globals.length);
  return [...globals, ...scored.slice(0, room).map((entry) => entry.memory)];
}

export class ForgeMemoryStore extends Context.Service<
  ForgeMemoryStore,
  {
    readonly add: (input: {
      readonly id: string;
      readonly projectId: string;
      readonly title: string;
      readonly body: string;
      readonly global: boolean;
      readonly now: string;
    }) => Effect.Effect<ForgeMemory, ForgeMemoryStoreError>;
    /** Marks `memoryId` as replaced by `bySupersedingId`; it stops being retrieved. */
    readonly supersede: (input: {
      readonly memoryId: string;
      readonly bySupersedingId: string;
    }) => Effect.Effect<void, ForgeMemoryStoreError>;
    readonly retrieve: (input: {
      readonly projectId: string;
      readonly query: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<ForgeMemory>, ForgeMemoryStoreError>;
    /** Every memory of a project, superseded ones included, oldest first. */
    readonly list: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<ForgeMemory>, ForgeMemoryStoreError>;
  }
>()("t3/forge/ForgeMemoryStore") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const fromRow = (operation: string, row: MemoryRow) =>
    decodeMemory({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      body: row.body,
      global: row.is_global === 1,
      createdAt: row.created_at,
      ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
    }).pipe(Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError(operation, cause)));

  const add: ForgeMemoryStore["Service"]["add"] = Effect.fn("ForgeMemoryStore.add")(
    function* (input) {
      const rows = yield* sql<MemoryRow>`
        INSERT INTO forge_memories (id, project_id, title, body, is_global, created_at)
        VALUES (${input.id}, ${input.projectId}, ${input.title}, ${input.body}, ${input.global ? 1 : 0}, ${input.now})
        RETURNING *
      `.pipe(Effect.mapError(toPersistenceSqlError("ForgeMemoryStore.add:insert")));
      return yield* fromRow("ForgeMemoryStore.add:decode", rows[0]!);
    },
  );

  const supersede: ForgeMemoryStore["Service"]["supersede"] = Effect.fn(
    "ForgeMemoryStore.supersede",
  )(function* ({ memoryId, bySupersedingId }) {
    yield* sql`
      UPDATE forge_memories SET superseded_by = ${bySupersedingId} WHERE id = ${memoryId}
    `.pipe(Effect.mapError(toPersistenceSqlError("ForgeMemoryStore.supersede:update")));
  });

  const retrieve: ForgeMemoryStore["Service"]["retrieve"] = Effect.fn(
    "ForgeMemoryStore.retrieve",
  )(function* ({ projectId, query, limit }) {
    const rows = yield* sql<MemoryRow>`
      SELECT * FROM forge_memories WHERE project_id = ${projectId} AND superseded_by IS NULL
    `.pipe(Effect.mapError(toPersistenceSqlError("ForgeMemoryStore.retrieve:query")));
    const memories = yield* Effect.forEach(rows, (row) =>
      fromRow("ForgeMemoryStore.retrieve:decode", row),
    );
    return rankMemories(memories, query, limit);
  });

  const list: ForgeMemoryStore["Service"]["list"] = Effect.fn("ForgeMemoryStore.list")(
    function* (projectId) {
      const rows = yield* sql<MemoryRow>`
        SELECT * FROM forge_memories WHERE project_id = ${projectId} ORDER BY created_at ASC, id ASC
      `.pipe(Effect.mapError(toPersistenceSqlError("ForgeMemoryStore.list:query")));
      return yield* Effect.forEach(rows, (row) => fromRow("ForgeMemoryStore.list:decode", row));
    },
  );

  return ForgeMemoryStore.of({ add, supersede, retrieve, list });
});

export const layer = Layer.effect(ForgeMemoryStore, make);
