import type { ForgeEvent, ForgeProjectState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeEvent, pendingContract, steps, verificationOf } from "./forgeView";

let seq = 0;
const event = (type: ForgeEvent["type"], extra: Partial<ForgeEvent> = {}): ForgeEvent => {
  seq += 1;
  return {
    id: `e${seq}`,
    seq,
    missionId: "m1",
    source: "coordinator",
    type,
    timestamp: `2026-10-09T00:00:${String(seq).padStart(2, "0")}.000Z`,
    payload: {},
    ...extra,
  };
};

const state = (events: ReadonlyArray<ForgeEvent>, tasks: ForgeProjectState["tasks"]): ForgeProjectState => ({
  projectId: "p1",
  jevConfigured: true,
  mission: {
    id: "m1",
    projectId: "p1",
    title: "Mission",
    description: "",
    status: "running",
    createdAt: "t",
    updatedAt: "t",
  },
  tasks,
  events,
  memories: [],
  graph: { nodes: [], edges: [], addedEdgeIds: [], truncated: false },
});

const backend = { id: "t1", missionId: "m1", role: "backend", status: "running", dependsOn: [] } as const;
const frontend = { id: "t2", missionId: "m1", role: "frontend", status: "blocked", dependsOn: ["t1"] } as const;

describe("forgeView", () => {
  it("shows a contract as pending only until it is acknowledged", () => {
    const proposed = event("CONTRACT_PROPOSED", { taskId: "t1", payload: { contract: { endpoint: "POST /x" } } });
    expect(pendingContract(state([proposed], [backend, frontend]))?.id).toBe(proposed.id);
    const acknowledged = event("CONTRACT_ACKNOWLEDGED", { causedByEventId: proposed.id });
    expect(pendingContract(state([proposed, acknowledged], [backend, frontend]))).toBeNull();
  });

  it("marks the handoff step skipped for a single agent and awaiting the user for a proposal", () => {
    const single = steps(state([event("TASK_STARTED")], [{ ...backend, role: "single" }]));
    expect(single.find((s) => s.name === "Handoff")?.state).toBe("skipped");
    const waiting = steps(state([event("CONTRACT_PROPOSED")], [backend, frontend]));
    expect(waiting.find((s) => s.name === "Handoff")).toMatchObject({ state: "active", hint: "awaiting you" });
  });

  it("reports verification from the recorded exit code and the merge facts that caused it", () => {
    const started = event("VERIFICATION_STARTED", { payload: { applied: ["a.js"], conflicts: ["b.js"] } });
    const finished = event("VERIFICATION_FINISHED", {
      causedByEventId: started.id,
      payload: { command: "npm test", cwd: "/w", exitCode: 1, durationMs: 9, output: "1 failing" },
    });
    const view = verificationOf(state([started, finished], [backend]));
    expect(view).toMatchObject({ exitCode: 1, applied: ["a.js"], conflicts: ["b.js"] });
    expect(steps(state([started, finished], [backend])).find((s) => s.name === "Verify")?.state).toBe("failed");
  });

  it("describes agent failures and discovered imports in plain language", () => {
    const s = state([], [backend, frontend]);
    expect(describeEvent(s, event("TASK_FAILED", { taskId: "t2", payload: { reason: "run failed" } }))).toBe(
      "frontend agent failed: run failed",
    );
    expect(
      describeEvent(s, event("GRAPH_EDGE_ADDED", { payload: { from: "file:a.js", to: "file:b.js" } })),
    ).toBe("Import discovered: a.js → b.js");
  });
});
