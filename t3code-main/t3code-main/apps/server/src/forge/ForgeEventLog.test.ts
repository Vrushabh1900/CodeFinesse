import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ForgeEventLog from "./ForgeEventLog.ts";

const TestLayer = ForgeEventLog.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const seedMission = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`
    INSERT INTO forge_missions (id, project_id, title, description, status, created_at, updated_at)
    VALUES ('m1', 'p1', 'Mission', 'desc', 'created', 't0', 't0'),
           ('m2', 'p1', 'Other', 'desc', 'created', 't0', 't0')
  `;
});

const event = (id: string, extra: Partial<ForgeEventLog.AppendForgeEventInput> = {}) => ({
  id,
  missionId: "m1",
  source: "coordinator",
  type: "MISSION_CREATED" as const,
  timestamp: "2026-10-09T00:00:00.000Z",
  payload: {},
  ...extra,
});

it.effect("assigns increasing seq and lists in order after a cursor", () =>
  Effect.gen(function* () {
    yield* seedMission;
    const log = yield* ForgeEventLog.ForgeEventLog;
    const a = yield* log.append(event("e1"));
    const b = yield* log.append(event("e2", { type: "TASK_CREATED", causedByEventId: "e1" }));
    assert.isTrue(b.seq > a.seq);
    assert.deepEqual(
      (yield* log.list({ missionId: "m1" })).map((e) => e.id),
      ["e1", "e2"],
    );
    assert.deepEqual(
      (yield* log.list({ missionId: "m1", afterSeq: a.seq })).map((e) => e.id),
      ["e2"],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("returns the stored row for a duplicate id instead of duplicating history", () =>
  Effect.gen(function* () {
    yield* seedMission;
    const log = yield* ForgeEventLog.ForgeEventLog;
    const first = yield* log.append(event("e1"));
    const again = yield* log.append(event("e1", { source: "someone-else" }));
    assert.equal(again.seq, first.seq);
    assert.equal(again.source, "coordinator");
    assert.equal((yield* log.list({ missionId: "m1" })).length, 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects a causal parent from another mission or one that does not exist", () =>
  Effect.gen(function* () {
    yield* seedMission;
    const log = yield* ForgeEventLog.ForgeEventLog;
    yield* log.append(event("other", { missionId: "m2" }));
    const crossMission = yield* Effect.flip(log.append(event("e1", { causedByEventId: "other" })));
    assert.equal(crossMission._tag, "ForgeEventCauseError");
    const missing = yield* Effect.flip(log.append(event("e2", { causedByEventId: "nope" })));
    assert.equal(missing._tag, "ForgeEventCauseError");
    assert.equal((yield* log.list({ missionId: "m1" })).length, 0);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("scrubs secrets from payloads before they are stored", () =>
  Effect.gen(function* () {
    yield* seedMission;
    const sql = yield* SqlClient.SqlClient;
    const log = yield* ForgeEventLog.ForgeEventLog;
    const stored = yield* log.append(
      event("e1", {
        type: "VERIFICATION_FINISHED",
        payload: { stdout: "JEV_API_KEY=apik_abcdefghijklmnop1234 ok", apiKey: "raw" },
      }),
    );
    assert.isFalse(JSON.stringify(stored.payload).includes("abcdefghijklmnop1234"));
    assert.equal(stored.payload.apiKey, "[REDACTED]");
    const raw = yield* sql<{ readonly payload_json: string }>`SELECT payload_json FROM forge_events`;
    assert.isFalse(raw[0]!.payload_json.includes("abcdefghijklmnop1234"));
  }).pipe(Effect.provide(TestLayer)),
);
