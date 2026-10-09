import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * T3 Forge wire contracts: missions, the audit event log, the grounded
 * knowledge graph and decision records. Every value here is persisted by the
 * server from real state transitions; clients only render it.
 */

export const ForgeMissionStatus = Schema.Literals([
  "created",
  "planning",
  "waiting",
  "running",
  "integrating",
  "verifying",
  "passed",
  "failed",
  "needs_review",
]);
export type ForgeMissionStatus = typeof ForgeMissionStatus.Type;

export const ForgeTaskRole = Schema.Literals(["frontend", "backend", "tests", "single"]);
export type ForgeTaskRole = typeof ForgeTaskRole.Type;

export const ForgeTaskStatus = Schema.Literals([
  "queued",
  "blocked",
  "running",
  "completed",
  "failed",
]);
export type ForgeTaskStatus = typeof ForgeTaskStatus.Type;

export const ForgeMission = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  status: ForgeMissionStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ForgeMission = typeof ForgeMission.Type;

export const ForgeTask = Schema.Struct({
  id: Schema.String,
  missionId: Schema.String,
  role: ForgeTaskRole,
  status: ForgeTaskStatus,
  dependsOn: Schema.Array(Schema.String),
  agentThreadId: Schema.optionalKey(Schema.String),
  worktreePath: Schema.optionalKey(Schema.String),
});
export type ForgeTask = typeof ForgeTask.Type;

export const ForgeEventType = Schema.Literals([
  "MISSION_CREATED",
  "TASK_CREATED",
  "TASK_STARTED",
  "CONTRACT_PROPOSED",
  "CONTRACT_ACKNOWLEDGED",
  "TASK_UNBLOCKED",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "MEMORY_RETRIEVED",
  "GRAPH_EDGE_ADDED",
  "DECISION_MADE",
  "VERIFICATION_STARTED",
  "VERIFICATION_FINISHED",
  /** A real action a running agent took, such as writing a file. */
  "AGENT_ACTIVITY",
]);
export type ForgeEventType = typeof ForgeEventType.Type;

/**
 * One audit-log row. `seq` is assigned by the server on insert and is the only
 * ordering clients may rely on; `causedByEventId` links an effect to the event
 * that triggered it so the UI can walk the chain of evidence.
 */
export const ForgeEvent = Schema.Struct({
  id: Schema.String,
  seq: NonNegativeInt,
  missionId: Schema.String,
  taskId: Schema.optionalKey(Schema.String),
  source: Schema.String,
  recipient: Schema.optionalKey(Schema.String),
  type: ForgeEventType,
  timestamp: IsoDateTime,
  causedByEventId: Schema.optionalKey(Schema.String),
  payload: Schema.Record(Schema.String, Schema.Unknown),
  evidenceRef: Schema.optionalKey(Schema.String),
});
export type ForgeEvent = typeof ForgeEvent.Type;

export const ForgeGraphNodeKind = Schema.Literals(["file", "module", "api", "decision", "issue"]);
export type ForgeGraphNodeKind = typeof ForgeGraphNodeKind.Type;

export const ForgeGraphRelation = Schema.Literals([
  "contains",
  "imports",
  "depends_on",
  "constrained_by",
  "verified_by",
]);
export type ForgeGraphRelation = typeof ForgeGraphRelation.Type;

/** `verified` is parser- or test-evidenced; `inferred` is never shown as verified. */
export const ForgeGraphStatus = Schema.Literals(["verified", "inferred", "stale"]);
export type ForgeGraphStatus = typeof ForgeGraphStatus.Type;

export const ForgeGraphNode = Schema.Struct({
  id: Schema.String,
  kind: ForgeGraphNodeKind,
  label: Schema.String,
  evidenceRef: Schema.optionalKey(Schema.String),
  status: ForgeGraphStatus,
});
export type ForgeGraphNode = typeof ForgeGraphNode.Type;

export const ForgeGraphEdge = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
  relation: ForgeGraphRelation,
  evidenceRef: Schema.String,
  status: ForgeGraphStatus,
});
export type ForgeGraphEdge = typeof ForgeGraphEdge.Type;

export const ForgeDecisionProvider = Schema.Literals(["jev", "rules_fallback", "manual_override"]);
export type ForgeDecisionProvider = typeof ForgeDecisionProvider.Type;

export const ForgeDecisionKind = Schema.Literals([
  "execution_route",
  "memory_relevance",
  "verification_risk",
]);
export type ForgeDecisionKind = typeof ForgeDecisionKind.Type;

/**
 * `provider` is `jev` only when a real Jev response produced `selection`.
 * `fallbackReason` is set whenever a rule answered instead, so a fallback is
 * never presented as model inference.
 */
export const ForgeDecision = Schema.Struct({
  missionId: Schema.String,
  provider: ForgeDecisionProvider,
  kind: ForgeDecisionKind,
  alternatives: Schema.Array(Schema.String),
  selection: Schema.String,
  probabilities: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  modelScore: Schema.optionalKey(Schema.Number),
  latencyMs: Schema.optionalKey(NonNegativeInt),
  modelId: Schema.optionalKey(Schema.String),
  inputSummary: Schema.String,
  fallbackReason: Schema.optionalKey(Schema.String),
});
export type ForgeDecision = typeof ForgeDecision.Type;

/** An explicit developer decision the Project Brain retrieves for later missions. */
export const ForgeMemory = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  /** Global rules are always attached to agent context, however relevance ranks them. */
  global: Schema.Boolean,
  createdAt: IsoDateTime,
  supersededBy: Schema.optionalKey(Schema.String),
});
export type ForgeMemory = typeof ForgeMemory.Type;

/** Test commands Forge may run in an integration worktree; nothing else is executable. */
export const ForgeVerificationCommand = Schema.Literals(["node-test", "npm-test", "pnpm-test", "bun-test"]);
export type ForgeVerificationCommand = typeof ForgeVerificationCommand.Type;

/** Everything the Forge view renders for one project, rebuilt from persisted state. */
export const ForgeProjectState = Schema.Struct({
  projectId: Schema.String,
  jevConfigured: Schema.Boolean,
  mission: Schema.NullOr(ForgeMission),
  tasks: Schema.Array(ForgeTask),
  events: Schema.Array(ForgeEvent),
  memories: Schema.Array(ForgeMemory),
  graph: Schema.Struct({
    nodes: Schema.Array(ForgeGraphNode),
    edges: Schema.Array(ForgeGraphEdge),
    addedEdgeIds: Schema.Array(Schema.String),
    /** True when the scan stopped at its file limit; the graph is then partial. */
    truncated: Schema.Boolean,
  }),
});
export type ForgeProjectState = typeof ForgeProjectState.Type;

export const ForgeProjectInput = Schema.Struct({ projectId: Schema.String });
export type ForgeProjectInput = typeof ForgeProjectInput.Type;

export const ForgeAddDecisionInput = Schema.Struct({
  projectId: Schema.String,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  body: Schema.String.check(Schema.isMaxLength(2_000)),
  global: Schema.optionalKey(Schema.Boolean),
});
export type ForgeAddDecisionInput = typeof ForgeAddDecisionInput.Type;

export const ForgeStartMissionInput = Schema.Struct({
  projectId: Schema.String,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  description: Schema.String.check(Schema.isMaxLength(4_000)),
  backendInstruction: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  frontendInstruction: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
});
export type ForgeStartMissionInput = typeof ForgeStartMissionInput.Type;

export const ForgeAcknowledgeContractInput = Schema.Struct({
  projectId: Schema.String,
  missionId: Schema.String,
  contractEventId: Schema.String,
});
export type ForgeAcknowledgeContractInput = typeof ForgeAcknowledgeContractInput.Type;

export const ForgeVerifyInput = Schema.Struct({
  projectId: Schema.String,
  missionId: Schema.String,
  command: ForgeVerificationCommand,
});
export type ForgeVerifyInput = typeof ForgeVerifyInput.Type;

export const ForgeOkResult = Schema.Struct({ ok: Schema.Literal(true) });
export type ForgeOkResult = typeof ForgeOkResult.Type;

/** A Forge command was refused or failed; `message` is safe to show the user. */
export class ForgeError extends Schema.TaggedError<ForgeError>()("ForgeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
