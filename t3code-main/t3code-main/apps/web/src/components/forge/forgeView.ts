import type { ForgeDecision, ForgeEvent, ForgeProjectState } from "@t3tools/contracts";

/**
 * Pure derivations for the Forge page. Every value comes from persisted
 * events; nothing here guesses progress the server has not recorded.
 */

export type StepState = "pending" | "active" | "done" | "failed" | "skipped";

export interface Step {
  readonly name: string;
  readonly state: StepState;
  readonly hint: string;
}

const has = (events: ReadonlyArray<ForgeEvent>, type: ForgeEvent["type"]) =>
  events.some((event) => event.type === type);

export function decisionOf(state: ForgeProjectState): ForgeDecision | null {
  const event = state.events.findLast((e) => e.type === "DECISION_MADE");
  return (event?.payload.decision as ForgeDecision | undefined) ?? null;
}

/** The newest contract proposal nobody has acknowledged yet. */
export function pendingContract(state: ForgeProjectState): ForgeEvent | null {
  const acknowledged = new Set(
    state.events.filter((e) => e.type === "CONTRACT_ACKNOWLEDGED").map((e) => e.causedByEventId),
  );
  return (
    state.events.findLast((e) => e.type === "CONTRACT_PROPOSED" && !acknowledged.has(e.id)) ?? null
  );
}

export interface VerificationView {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly output: string;
  readonly applied: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<string>;
}

export function verificationOf(state: ForgeProjectState): VerificationView | null {
  const finished = state.events.findLast((e) => e.type === "VERIFICATION_FINISHED");
  if (finished === undefined) return null;
  const started = state.events.find((e) => e.id === finished.causedByEventId);
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
  return {
    command: String(finished.payload.command ?? ""),
    cwd: String(finished.payload.cwd ?? ""),
    exitCode: Number(finished.payload.exitCode),
    durationMs: Number(finished.payload.durationMs ?? 0),
    output: String(finished.payload.output ?? ""),
    applied: list(started?.payload.applied),
    conflicts: list(started?.payload.conflicts),
  };
}

export function steps(state: ForgeProjectState): ReadonlyArray<Step> {
  const { events, tasks, mission } = state;
  if (mission === null) {
    return ["Brain", "Route", "Build", "Handoff", "Verify"].map((name) => ({
      name,
      state: "pending" as const,
      hint: "",
    }));
  }
  const decision = decisionOf(state);
  const single = tasks.length === 1;
  const failed = tasks.some((t) => t.status === "failed");
  const allDone = tasks.length > 0 && tasks.every((t) => t.status === "completed");
  const verification = verificationOf(state);
  return [
    { name: "Brain", state: has(events, "MEMORY_RETRIEVED") ? "done" : "active", hint: "decisions" },
    {
      name: "Route",
      state: decision ? "done" : "active",
      hint: decision ? decision.selection.replace("_", " ") : "deciding",
    },
    {
      name: "Build",
      state: failed ? "failed" : allDone ? "done" : has(events, "TASK_STARTED") ? "active" : "pending",
      hint: failed ? "failed" : `${tasks.length} agent${single ? "" : "s"}`,
    },
    {
      name: "Handoff",
      state: single
        ? "skipped"
        : has(events, "CONTRACT_ACKNOWLEDGED")
          ? "done"
          : has(events, "CONTRACT_PROPOSED")
            ? "active"
            : "pending",
      hint: single
        ? "not needed"
        : has(events, "CONTRACT_ACKNOWLEDGED")
          ? "acknowledged"
          : has(events, "CONTRACT_PROPOSED")
            ? "awaiting you"
            : "contract",
    },
    {
      name: "Verify",
      state: verification
        ? verification.exitCode === 0
          ? "done"
          : "failed"
        : has(events, "VERIFICATION_STARTED")
          ? "active"
          : "pending",
      hint: verification ? `exit ${verification.exitCode}` : "tests",
    },
  ];
}

const roleOf = (state: ForgeProjectState, taskId: string | undefined) =>
  state.tasks.find((task) => task.id === taskId)?.role ?? "task";

const fileName = (id: unknown) => String(id ?? "").replace(/^file:/, "");

/** One plain-language line per audit event. */
export function describeEvent(state: ForgeProjectState, event: ForgeEvent): string {
  const p = event.payload;
  const role = roleOf(state, event.taskId);
  switch (event.type) {
    case "MISSION_CREATED":
      return "Mission created";
    case "MEMORY_RETRIEVED":
      return `Project decisions retrieved (${Array.isArray(p.memoryIds) ? p.memoryIds.length : 0})`;
    case "DECISION_MADE": {
      const d = p.decision as ForgeDecision | undefined;
      return d
        ? `Route decided: ${d.selection.replace("_", " ")} via ${d.provider.replace("_", " ")}`
        : "Route decided";
    }
    case "TASK_CREATED":
      return `Task created: ${String(p.role)}${Array.isArray(p.dependsOn) && p.dependsOn.length > 0 ? " (waits on contract)" : ""}`;
    case "TASK_STARTED":
      return `${role} agent started`;
    case "CONTRACT_PROPOSED": {
      const contract = p.contract as { endpoint?: unknown } | undefined;
      return `Contract proposed: ${String(contract?.endpoint ?? "")}`;
    }
    case "CONTRACT_ACKNOWLEDGED":
      return "Contract acknowledged";
    case "TASK_UNBLOCKED":
      return `${role} unblocked`;
    case "TASK_COMPLETED":
      return `${role} agent finished`;
    case "TASK_FAILED":
      return `${role} agent failed: ${String(p.reason ?? "")}`;
    case "GRAPH_EDGE_ADDED":
      return `Import discovered: ${fileName(p.from)} → ${fileName(p.to)}`;
    case "VERIFICATION_STARTED":
      return `Tests started: ${String(p.command ?? "")}`;
    case "VERIFICATION_FINISHED":
      return `Tests finished: exit ${String(p.exitCode)}`;
    case "AGENT_ACTIVITY":
      return `${role} ${String(p.activity ?? "")} ${String(p.path ?? p.command ?? "")}`.trim();
  }
}

/** True while agents or the verifier are still working on the mission. */
export function isMissionActive(state: ForgeProjectState): boolean {
  const status = state.mission?.status;
  return (
    status === "created" ||
    status === "planning" ||
    status === "waiting" ||
    status === "running" ||
    status === "integrating" ||
    status === "verifying"
  );
}
