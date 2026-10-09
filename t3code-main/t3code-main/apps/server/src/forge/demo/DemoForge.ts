// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off cryptoRandomUUIDInEffect:off globalDateInEffect:off - Demo host program: a plain Node boundary around the Forge services, not Effect domain code.
/**
 * DemoForge - composes the real Forge services (event log, coordinator, Jev
 * router, memory store, graph scanner, verifier) over a file-backed SQLite
 * database, and runs each mission's agents against the sample project.
 *
 * Agents are chosen per mission: live Claude Code agents (`claude -p`, real
 * LLM edits streamed into the audit log) or deterministic scripted agents for
 * an offline run. Either way the Jev call, every persisted event, the graph
 * scan, the contract gate, the merge and the test exit code are real, and the
 * snapshot reports which kind of agent did the work.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as ForgeCoordinator from "../ForgeCoordinator.ts";
import * as ForgeEventLog from "../ForgeEventLog.ts";
import * as ForgeMemoryStore from "../ForgeMemoryStore.ts";
import * as ForgeMissionStore from "../ForgeMissionStore.ts";
import * as ForgeRouter from "../ForgeRouter.ts";
import * as ForgeThreadRunner from "../ForgeThreadRunner.ts";
import {
  diffEdges,
  overlayAddedEdges,
  scanImports,
  type GraphSnapshot,
} from "../graphScanner.ts";
import { readJevConfig } from "../jevClient.ts";
import { CONTRACT_FILE } from "../contract.ts";
import { agentEnvironment, detectClaude, livePrompt, runClaudeAgent } from "./claudeAgent.ts";
import {
  applyBackendWork,
  applyFrontendWork,
  contractFromPrompt,
  DEFAULT_CONTRACT,
} from "./scriptedAgents.ts";
import { SAMPLE_APP_FILES } from "./sampleApp.ts";
import { ALLOWED_COMMANDS, runAllowlisted } from "./verifier.ts";
import {
  copyWorkspace,
  changedFiles,
  integrate,
  readScanFiles,
  resetDir,
  writeFiles,
  type IntegrationResult,
} from "./workspaces.ts";

export const DEMO_PROJECT_ID = "demo-project";

export type AgentMode = "scripted" | "claude";

export interface DemoForgeOptions {
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Pause between scripted agent steps so the dashboard can show them. */
  readonly stepMs?: number;
  /** Live agent settings; detection runs `claude --version` once at startup. */
  readonly claude?: {
    readonly detect?: boolean;
    readonly path?: string;
    readonly model?: string;
    readonly timeoutMs?: number;
    /** Replaces the claude binary; a launcher counts as an available live agent. */
    readonly launcher?: { readonly file: string; readonly args: ReadonlyArray<string> };
  };
}

const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function createDemoForge(options: DemoForgeOptions) {
  const stepMs = options.stepMs ?? 1_500;
  const baseDir = NodePath.join(options.dataDir, "project", "base");
  const runsDir = NodePath.join(options.dataDir, "runs");
  NodeFS.mkdirSync(options.dataDir, { recursive: true });
  if (!NodeFS.existsSync(baseDir)) {
    resetDir(baseDir);
    writeFiles(baseDir, SAMPLE_APP_FILES);
  }

  const jevConfigured = readJevConfig(options.env) !== null;
  const claude: { readonly available: boolean; readonly version?: string } =
    options.claude?.launcher !== undefined
      ? { available: true, version: "custom launcher" }
      : options.claude?.detect === false
        ? { available: false }
        : await detectClaude(options.claude?.path);
  const integrations = new Map<string, IntegrationResult>();
  const missionModes = new Map<string, AgentMode>();
  // The mode for the mission being started; its id is only known at the first launch.
  let nextMissionMode: AgentMode = "scripted";
  let launchCounter = 0;

  const runnerLayer = Layer.succeed(
    ForgeThreadRunner.ForgeThreadRunner,
    ForgeThreadRunner.ForgeThreadRunner.of({
      launch: (input) =>
        Effect.try({
          try: () => {
            if (!missionModes.has(input.missionId)) missionModes.set(input.missionId, nextMissionMode);
            const mode = missionModes.get(input.missionId)!;
            const dir = NodePath.join(runsDir, input.missionId, input.taskId);
            copyWorkspace(baseDir, dir);
            launchCounter += 1;
            // Start the agent after the coordinator has recorded TASK_STARTED.
            setTimeout(() => void (mode === "claude" ? driveClaude(input, dir) : drive(input, dir)), 0);
            return { threadId: `${mode}-${input.role}-${launchCounter}`, worktreePath: dir };
          },
          catch: (cause) => new ForgeThreadRunner.ForgeThreadRunnerError({ taskId: input.taskId, cause }),
        }),
    }),
  );

  const stores = Layer.mergeAll(
    ForgeEventLog.layer,
    ForgeMissionStore.layer,
    ForgeMemoryStore.layer,
  ).pipe(
    Layer.provideMerge(
      NodeSqliteClient.layer({ filename: NodePath.join(options.dataDir, "forge.sqlite") }),
    ),
  );
  const layer = ForgeCoordinator.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(ForgeRouter.layerFromEnv(options.env), runnerLayer, NodeCrypto.layer),
    ),
    Layer.provideMerge(stores),
  );
  const runtime = ManagedRuntime.make(layer);
  await runtime.runPromise(runMigrations());

  const coordinator = <A, E>(
    use: (c: ForgeCoordinator.ForgeCoordinator["Service"]) => Effect.Effect<A, E, never>,
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const c = yield* ForgeCoordinator.ForgeCoordinator;
        return yield* use(c);
      }),
    );

  const baseGraph = (): GraphSnapshot => scanImports(readScanFiles(baseDir));

  /** Scripted agent: waits, edits its own workspace, and reports through the coordinator. */
  async function drive(
    input: ForgeThreadRunner.ForgeThreadLaunch,
    dir: string,
  ): Promise<void> {
    const { missionId, taskId, role, prompt } = input;
    try {
      await sleep(stepMs);
      if (role === "backend" || role === "single") {
        applyBackendWork(dir, prompt, DEFAULT_CONTRACT);
        if (role === "backend") {
          await coordinator((c) =>
            c.proposeContract({
              missionId,
              taskId,
              contract: { ...DEFAULT_CONTRACT },
            }),
          );
          await sleep(stepMs);
        }
      }
      if (role === "frontend" || role === "single") {
        const contract = contractFromPrompt(prompt) ?? (role === "single" ? DEFAULT_CONTRACT : null);
        if (contract === null) throw new Error("No acknowledged contract in the task prompt");
        applyFrontendWork(dir, contract);
      }
      await sleep(stepMs);
      await coordinator((c) =>
        c.completeTask({
          missionId,
          taskId,
          summary: `Scripted ${role} agent finished`,
          changedFiles: changedFiles(baseDir, dir),
        }),
      );
      const delta = diffEdges(baseGraph(), scanImports(readScanFiles(dir))).filter(
        (edge) => edge.relation === "imports",
      );
      await coordinator((c) => c.recordGraphEdges({ missionId, taskId, edges: delta }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "scripted agent failed";
      await coordinator((c) => c.failTask({ missionId, taskId, reason })).catch(() => undefined);
    }
  }

  /**
   * Live agent: a real `claude -p` process in the task workspace. File edits it
   * makes are recorded as they happen, in order; a contract it publishes is
   * proposed through the coordinator, and the dependent task stays blocked
   * until a human acknowledges it.
   */
  async function driveClaude(
    input: ForgeThreadRunner.ForgeThreadLaunch,
    dir: string,
  ): Promise<void> {
    const { missionId, taskId, role } = input;
    let chain: Promise<unknown> = Promise.resolve();
    const enqueue = (work: () => Promise<unknown>) => {
      chain = chain.then(work).catch(() => undefined);
    };
    let contractProposed = false;
    try {
      const result = await runClaudeAgent({
        cwd: dir,
        prompt: livePrompt(role, input.prompt),
        timeoutMs: options.claude?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        env: agentEnvironment(options.env as NodeJS.ProcessEnv),
        ...(options.claude?.path === undefined ? {} : { claudePath: options.claude.path }),
        ...(options.claude?.launcher === undefined ? {} : { launcher: options.claude.launcher }),
        ...(options.claude?.model === undefined ? {} : { model: options.claude.model }),
        onActivity: (activity) =>
          enqueue(() =>
            coordinator((c) =>
              c.recordAgentActivity({
                missionId,
                taskId,
                activity: activity.kind,
                detail: activity.kind === "ran" ? { command: activity.command } : { path: activity.path },
                ...(activity.kind === "ran" ? {} : { evidenceRef: activity.path }),
              }),
            ),
          ),
        ...(role === "backend"
          ? {
              onContract: (contract) =>
                enqueue(async () => {
                  await coordinator((c) =>
                    c.proposeContract({ missionId, taskId, contract: { ...contract } }),
                  );
                  contractProposed = true;
                }),
            }
          : {}),
      });
      await chain;

      if (!result.ok) throw new Error(result.reason ?? "the agent failed");
      if (role === "backend" && !contractProposed) {
        throw new Error(`The agent finished without publishing ${CONTRACT_FILE}`);
      }
      await coordinator((c) =>
        c.recordAgentActivity({
          missionId,
          taskId,
          activity: "finished",
          detail: {
            durationMs: result.durationMs,
            ...(result.numTurns === undefined ? {} : { turns: result.numTurns }),
            ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
          },
        }),
      );
      await coordinator((c) =>
        c.completeTask({
          missionId,
          taskId,
          summary: result.summary,
          changedFiles: changedFiles(baseDir, dir),
        }),
      );
      const delta = diffEdges(baseGraph(), scanImports(readScanFiles(dir))).filter(
        (edge) => edge.relation === "imports",
      );
      await coordinator((c) => c.recordGraphEdges({ missionId, taskId, edges: delta }));
    } catch (error) {
      await chain;
      const reason = error instanceof Error ? error.message : "live agent failed";
      await coordinator((c) => c.failTask({ missionId, taskId, reason })).catch(() => undefined);
    }
  }

  const readAll = Effect.gen(function* () {
    const missions = yield* ForgeMissionStore.ForgeMissionStore;
    const memories = yield* ForgeMemoryStore.ForgeMemoryStore;
    const log = yield* ForgeEventLog.ForgeEventLog;
    const latest = (yield* missions.listMissions(DEMO_PROJECT_ID))[0];
    return {
      memories: yield* memories.list(DEMO_PROJECT_ID),
      mission: latest ?? null,
      tasks: latest === undefined ? [] : yield* missions.listTasks(latest.id),
      events: latest === undefined ? [] : yield* log.list({ missionId: latest.id }),
    };
  });

  async function snapshot() {
    const { memories, mission, tasks, events } = await runtime.runPromise(readAll);
    const graph = overlayAddedEdges(baseGraph(), events);
    const decisionEvent = events.findLast((event) => event.type === "DECISION_MADE");
    const proposals = events.filter((event) => event.type === "CONTRACT_PROPOSED");
    const acked = new Set(
      events.filter((event) => event.type === "CONTRACT_ACKNOWLEDGED").map((e) => e.causedByEventId),
    );
    const verification = events.findLast((event) => event.type === "VERIFICATION_FINISHED");
    // After a restart the in-memory choice is gone; the thread ids still say which kind ran.
    const agentMode: AgentMode | null =
      mission === null
        ? null
        : (missionModes.get(mission.id) ??
          (tasks[0]?.agentThreadId?.startsWith("claude-") ? "claude" : "scripted"));
    return {
      agentMode,
      liveAgents: { claude },
      jevConfigured,
      memories,
      mission,
      tasks,
      events,
      decision: decisionEvent?.payload.decision ?? null,
      pendingContract: proposals.findLast((event) => !acked.has(event.id)) ?? null,
      graph,
      verification: verification?.payload ?? null,
      integration: mission === null ? null : (integrations.get(mission.id) ?? null),
    };
  }

  return {
    snapshot,
    async addDecision(input: { readonly title: string; readonly body: string }) {
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ForgeMemoryStore.ForgeMemoryStore;
          yield* store.add({
            id: crypto.randomUUID(),
            projectId: DEMO_PROJECT_ID,
            title: input.title,
            body: input.body,
            global: false,
            now: new Date().toISOString(),
          });
        }),
      );
    },
    async startMission(agentMode: AgentMode = "scripted") {
      if (agentMode === "claude" && !claude.available) {
        throw new Error("Claude Code was not found on this machine; use scripted agents.");
      }
      nextMissionMode = agentMode;
      await coordinator((c) =>
        c.startMission({
          projectId: DEMO_PROJECT_ID,
          title: "Add a mock Google OAuth-style sign-in flow using existing authentication patterns",
          description:
            "Local mock only, not live Google OAuth. Backend route issues a token; frontend adds a sign-in button.",
          parallelismAvailable: true,
          plan: [
            {
              role: "backend",
              title: "Mock Google sign-in route",
              instruction:
                "Add POST /auth/google-mock issuing a token for a mock user, following the existing authentication patterns.",
            },
            {
              role: "frontend",
              title: "Mock Google sign-in button",
              instruction:
                'Add a "Sign in with Google (mock)" button to the login form that calls the agreed endpoint.',
              dependsOnRoles: ["backend"],
            },
          ],
        }),
      );
    },
    async acknowledgeContract() {
      const { mission, events } = await runtime.runPromise(readAll);
      if (mission === null) throw new Error("No mission");
      const acked = new Set(
        events.filter((e) => e.type === "CONTRACT_ACKNOWLEDGED").map((e) => e.causedByEventId),
      );
      const pending = events.findLast((e) => e.type === "CONTRACT_PROPOSED" && !acked.has(e.id));
      if (pending === undefined) throw new Error("No contract is waiting for acknowledgment");
      await coordinator((c) =>
        c.acknowledgeContract({
          missionId: mission.id,
          contractEventId: pending.id,
          acknowledgedBy: "human",
        }),
      );
    },
    async integrateAndVerify() {
      const { mission, tasks } = await runtime.runPromise(readAll);
      if (mission === null || mission.status !== "integrating") {
        throw new Error("The mission is not ready to integrate");
      }
      const roots = tasks.flatMap((task) =>
        task.worktreePath === undefined ? [] : [{ taskId: task.id, root: task.worktreePath }],
      );
      const integrationDir = NodePath.join(runsDir, mission.id, "integration");
      const merged = integrate(baseDir, roots, integrationDir);
      integrations.set(mission.id, merged);
      const command = ALLOWED_COMMANDS["node-test"]!.label;
      await coordinator((c) =>
        c.startVerification({ missionId: mission.id, command, cwd: integrationDir }),
      );
      const outcome = await runAllowlisted("node-test", integrationDir);
      await coordinator((c) =>
        c.finishVerification({
          missionId: mission.id,
          command: outcome.command,
          cwd: outcome.cwd,
          exitCode: outcome.exitCode,
          durationMs: outcome.durationMs,
          output: outcome.output,
        }),
      );
    },
    async reset() {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM forge_events`;
          yield* sql`DELETE FROM forge_tasks`;
          yield* sql`DELETE FROM forge_missions`;
          yield* sql`DELETE FROM forge_memories`;
        }),
      );
      NodeFS.rmSync(runsDir, { recursive: true, force: true });
      integrations.clear();
    },
    dispose: () => runtime.dispose(),
  };
}

export type DemoForge = Awaited<ReturnType<typeof createDemoForge>>;
