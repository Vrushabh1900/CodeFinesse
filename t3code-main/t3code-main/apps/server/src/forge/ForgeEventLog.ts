/**
 * ForgeEventLog - append-only audit log for Forge missions.
 *
 * Events are scrubbed of credentials before they are written, receive their
 * monotonic `seq` from SQLite, and may only name a causal parent that already
 * exists in the same mission. Appending an id that already exists returns the
 * stored row, so duplicate delivery never duplicates history.
 *
 * @module ForgeEventLog
 */
import { ForgeEvent, type ForgeEventType } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";
import { redactPayload } from "./redact.ts";

export class ForgeEventCauseError extends Schema.TaggedError<ForgeEventCauseError>()(
  "ForgeEventCauseError",
  {
    missionId: Schema.String,
    eventId: Schema.String,
    causedByEventId: Schema.String,
  },
) {
  override get message(): string {
    return `Forge event ${this.eventId} names a causal parent that is not in mission ${this.missionId}.`;
  }
}

export type ForgeEventLogError = PersistenceSqlError | PersistenceDecodeError | ForgeEventCauseError;

export interface AppendForgeEventInput {
  readonly id: string;
  readonly missionId: string;
  readonly taskId?: string;
  readonly source: string;
  readonly recipient?: string;
  readonly type: ForgeEventType;
  readonly timestamp: string;
  readonly causedByEventId?: string;
  readonly payload: Record<string, unknown>;
  readonly evidenceRef?: string;
}

interface ForgeEventRow {
  readonly seq: number;
  readonly id: string;
  readonly mission_id: string;
  readonly task_id: string | null;
  readonly source: string;
  readonly recipient: string | null;
  readonly type: string;
  readonly timestamp: string;
  readonly caused_by_event_id: string | null;
  readonly payload_json: string;
  readonly evidence_ref: string | null;
}

const decodeEvent = Schema.decodeUnknownEffect(ForgeEvent);
const PayloadJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodePayload = Schema.decodeUnknownEffect(PayloadJson);
const encodePayload = Schema.encodeUnknownEffect(PayloadJson);

const rowToCandidate = (row: ForgeEventRow, payload: Record<string, unknown>) => ({
  id: row.id,
  seq: row.seq,
  missionId: row.mission_id,
  source: row.source,
  type: row.type,
  timestamp: row.timestamp,
  payload,
  ...(row.task_id === null ? {} : { taskId: row.task_id }),
  ...(row.recipient === null ? {} : { recipient: row.recipient }),
  ...(row.caused_by_event_id === null ? {} : { causedByEventId: row.caused_by_event_id }),
  ...(row.evidence_ref === null ? {} : { evidenceRef: row.evidence_ref }),
});

export class ForgeEventLog extends Context.Service<
  ForgeEventLog,
  {
    /** Appends one event and returns it with its server-assigned `seq`. */
    readonly append: (input: AppendForgeEventInput) => Effect.Effect<ForgeEvent, ForgeEventLogError>;
    /** Events of one mission in `seq` order, strictly after `afterSeq`. */
    readonly list: (input: {
      readonly missionId: string;
      readonly afterSeq?: number;
    }) => Effect.Effect<ReadonlyArray<ForgeEvent>, ForgeEventLogError>;
    /** Signals after every appended event (and every `notifyChanged`); consecutive signals coalesce. */
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    /** For Forge state that is not an event, such as a saved project decision. */
    readonly notifyChanged: Effect.Effect<void>;
  }
>()("t3/forge/ForgeEventLog") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const decodeRow = (operation: string, row: ForgeEventRow) =>
    decodePayload(row.payload_json).pipe(
      Effect.flatMap((payload) => decodeEvent(rowToCandidate(row, payload))),
      Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError(operation, cause)),
    );

  const append: ForgeEventLog["Service"]["append"] = Effect.fn("ForgeEventLog.append")(
    function* (input) {
      const existing = yield* sql<ForgeEventRow>`
        SELECT * FROM forge_events WHERE id = ${input.id}
      `.pipe(Effect.mapError(toPersistenceSqlError("ForgeEventLog.append:lookup")));
      if (existing[0] !== undefined) return yield* decodeRow("ForgeEventLog.append:decode", existing[0]);

      if (input.causedByEventId !== undefined) {
        const parent = yield* sql<{ readonly id: string }>`
          SELECT id FROM forge_events
          WHERE id = ${input.causedByEventId} AND mission_id = ${input.missionId}
        `.pipe(Effect.mapError(toPersistenceSqlError("ForgeEventLog.append:parent")));
        if (parent.length === 0) {
          return yield* new ForgeEventCauseError({
            missionId: input.missionId,
            eventId: input.id,
            causedByEventId: input.causedByEventId,
          });
        }
      }

      const payloadJson = yield* encodePayload(redactPayload(input.payload)).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError("ForgeEventLog.append:encode", cause),
        ),
      );
      const inserted = yield* sql<ForgeEventRow>`
        INSERT INTO forge_events (
          id, mission_id, task_id, source, recipient, type, timestamp,
          caused_by_event_id, payload_json, evidence_ref
        ) VALUES (
          ${input.id}, ${input.missionId}, ${input.taskId ?? null}, ${input.source},
          ${input.recipient ?? null}, ${input.type}, ${input.timestamp},
          ${input.causedByEventId ?? null}, ${payloadJson}, ${input.evidenceRef ?? null}
        )
        RETURNING *
      `.pipe(Effect.mapError(toPersistenceSqlError("ForgeEventLog.append:insert")));
      const event = yield* decodeRow("ForgeEventLog.append:decode", inserted[0]!);
      yield* notifyChanged;
      return event;
    },
  );

  const list: ForgeEventLog["Service"]["list"] = Effect.fn("ForgeEventLog.list")(
    function* ({ missionId, afterSeq }) {
      const rows = yield* sql<ForgeEventRow>`
        SELECT * FROM forge_events
        WHERE mission_id = ${missionId} AND seq > ${afterSeq ?? 0}
        ORDER BY seq ASC
      `.pipe(Effect.mapError(toPersistenceSqlError("ForgeEventLog.list:query")));
      return yield* Effect.forEach(rows, (row) => decodeRow("ForgeEventLog.list:decode", row));
    },
  );

  return ForgeEventLog.of({
    append,
    list,
    subscribeChanges: PubSub.subscribe(changes),
    notifyChanged,
  });
});

export const layer = Layer.effect(ForgeEventLog, make);
