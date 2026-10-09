import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_missions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_tasks (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES forge_missions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      depends_on_json TEXT NOT NULL,
      agent_thread_id TEXT,
      worktree_path TEXT
    )
  `;

  // Append-only audit log. `seq` is the only ordering clients may rely on, and
  // the foreign key on `caused_by_event_id` keeps every causal link resolvable.
  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      mission_id TEXT NOT NULL REFERENCES forge_missions(id) ON DELETE CASCADE,
      task_id TEXT,
      source TEXT NOT NULL,
      recipient TEXT,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      caused_by_event_id TEXT REFERENCES forge_events(id),
      payload_json TEXT NOT NULL,
      evidence_ref TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_forge_events_mission_seq
    ON forge_events(mission_id, seq)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_memories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      is_global INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      superseded_by TEXT REFERENCES forge_memories(id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_forge_memories_project_active
    ON forge_memories(project_id, superseded_by)
  `;
});
