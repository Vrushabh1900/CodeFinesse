// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Demo host program: a plain Node boundary around the Forge services, not Effect domain code.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, afterEach, it } from "@effect/vitest";

import { createDemoForge, type AgentMode, type DemoForge } from "./DemoForge.ts";

/**
 * A stand-in for `claude -p`: reads the prompt from stdin, makes the same
 * edits as the scripted agents, publishes the contract file when asked to,
 * and speaks Claude Code's stream-json protocol on stdout.
 */
const FAKE_CLAUDE = `
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
const agents = await import(process.env.FAKE_AGENTS_MODULE);
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const cwd = process.cwd();
emit({ type: "system", subtype: "init" });
let files;
if (input.includes(".forge/contract.json")) {
  if (process.env.FAKE_CLAUDE_MODE !== "no-contract") {
    NodeFS.mkdirSync(NodePath.join(cwd, ".forge"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, ".forge", "contract.json"), JSON.stringify(agents.DEFAULT_CONTRACT));
  }
  files = agents.applyBackendWork(cwd, input, agents.DEFAULT_CONTRACT);
} else if (input.includes("Agreed API contract")) {
  files = agents.applyFrontendWork(cwd, agents.contractFromPrompt(input));
} else {
  files = [...agents.applyBackendWork(cwd, input, agents.DEFAULT_CONTRACT), ...agents.applyFrontendWork(cwd, agents.DEFAULT_CONTRACT)];
}
for (const file of files) {
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: NodePath.join(cwd, file) } }] } });
}
await new Promise((resolve) => setTimeout(resolve, 900));
emit({ type: "result", subtype: "success", is_error: false, result: "Fake agent finished", num_turns: 3, total_cost_usd: 0 });
`;

const dirs: string[] = [];
const forges: DemoForge[] = [];

afterEach(async () => {
  for (const forge of forges.splice(0)) await forge.dispose();
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

async function open() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "forge-demo-"));
  dirs.push(dir);
  // No JEV_API_KEY: the route is answered by the labelled rules fallback, offline.
  const forge = await createDemoForge({ dataDir: dir, env: {}, stepMs: 5, claude: { detect: false } });
  forges.push(forge);
  return forge;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the mission");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function openLive(mode: "ok" | "no-contract") {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "forge-demo-"));
  dirs.push(dir);
  const fake = NodePath.join(dir, "fake-claude.mjs");
  NodeFS.writeFileSync(fake, FAKE_CLAUDE);
  const forge = await createDemoForge({
    dataDir: NodePath.join(dir, "data"),
    env: {
      ...process.env,
      FAKE_AGENTS_MODULE: new URL("./scriptedAgents.ts", import.meta.url).href,
      FAKE_CLAUDE_MODE: mode,
      JEV_API_KEY: "",
    },
    claude: { launcher: { file: process.execPath, args: [fake] }, timeoutMs: 20_000 },
  });
  forges.push(forge);
  return forge;
}

async function runMission(forge: DemoForge, agentMode: AgentMode = "scripted") {
  await forge.startMission(agentMode);
  await until(forge.snapshot, (s) => s.pendingContract !== null);
  await forge.acknowledgeContract();
  await until(forge.snapshot, (s) => s.mission?.status === "integrating");
  await forge.integrateAndVerify();
  return forge.snapshot();
}

it("runs a mission end to end: decision, contract gate, graph evidence, real test exit code", async () => {
  const forge = await open();
  await forge.addDecision({
    title: "Reuse the existing auth service",
    body: "Do not introduce Auth0; extend the existing JWT auth service.",
  });
  const final = await runMission(forge);

  assert.equal(final.mission?.status, "passed");
  assert.equal(final.verification?.exitCode, 0);
  assert.equal(final.verification?.status, "passed");
  assert.include(String(final.verification?.output), "pass");

  const types = final.events.map((e) => e.type);
  assert.isBelow(types.indexOf("CONTRACT_PROPOSED"), types.indexOf("CONTRACT_ACKNOWLEDGED"));
  assert.isBelow(types.indexOf("CONTRACT_ACKNOWLEDGED"), types.lastIndexOf("TASK_STARTED"));
  assert.isBelow(types.indexOf("VERIFICATION_STARTED"), types.indexOf("VERIFICATION_FINISHED"));

  // The memory reached the agent: the new route reuses jwt.js and nothing parallel was added.
  const importsJwt = final.graph.edges.find(
    (e) => e.id === "imports:file:server/routes/googleMock.js->file:server/auth/jwt.js",
  );
  assert.equal(importsJwt?.evidenceRef, "server/routes/googleMock.js:1");
  assert.isFalse(final.graph.nodes.some((n) => n.id.includes("auth0Client")));
  assert.include(final.graph.addedEdgeIds, importsJwt!.id);

  // The frontend used the endpoint from the acknowledged contract.
  assert.isTrue(
    final.graph.edges.some(
      (e) => e.id === "imports:file:web/LoginForm.js->file:web/GoogleButton.js",
    ),
  );
  assert.deepEqual(final.integration?.conflicts, []);
}, 30_000);

it("without the project decision the agent builds a second auth path", async () => {
  const forge = await open();
  const final = await runMission(forge);
  assert.isTrue(final.graph.nodes.some((n) => n.id === "file:server/auth/auth0Client.js"));
  assert.isTrue(
    final.graph.edges.some(
      (e) => e.id === "imports:file:server/routes/googleMock.js->file:server/auth/auth0Client.js",
    ),
  );
}, 30_000);

it("keeps mission history after the services are reopened on the same data", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "forge-demo-"));
  dirs.push(dir);
  const first = await createDemoForge({ dataDir: dir, env: {}, stepMs: 5, claude: { detect: false } });
  await runMission(first);
  const before = await first.snapshot();
  await first.dispose();

  const second = await createDemoForge({ dataDir: dir, env: {}, stepMs: 5, claude: { detect: false } });
  forges.push(second);
  const after = await second.snapshot();
  assert.equal(after.mission?.id, before.mission?.id);
  assert.equal(after.events.length, before.events.length);
  assert.equal(after.verification?.exitCode, 0);
}, 30_000);

it("live agents: streamed edits are audited, the contract file becomes a real proposal, tests run", async () => {
  const forge = await openLive("ok");
  await forge.addDecision({
    title: "Reuse the existing auth service",
    body: "Do not introduce Auth0; extend the existing JWT auth service.",
  });
  const final = await runMission(forge, "claude");

  assert.equal(final.agentMode, "claude");
  assert.isTrue(final.tasks.every((t) => t.agentThreadId?.startsWith("claude-")));
  assert.equal(final.mission?.status, "passed");
  assert.equal(final.verification?.exitCode, 0);

  const activity = final.events.filter((e) => e.type === "AGENT_ACTIVITY");
  const wrote = activity.find((e) => e.payload.path === "server/routes/googleMock.js");
  assert.equal(wrote?.payload.activity, "wrote");
  assert.equal(wrote?.evidenceRef, "server/routes/googleMock.js");
  assert.isTrue(activity.some((e) => e.payload.activity === "finished" && e.payload.turns === 3));

  const types = final.events.map((e) => e.type);
  assert.isBelow(types.indexOf("CONTRACT_PROPOSED"), types.indexOf("CONTRACT_ACKNOWLEDGED"));
  // The contract file is a handoff artifact, never merged into the project.
  assert.isFalse((final.integration?.applied ?? []).some((path) => path.startsWith(".forge")));
}, 60_000);

it("live agents: a backend agent that never publishes its contract fails its task", async () => {
  const forge = await openLive("no-contract");
  await forge.startMission("claude");
  const final = await until(forge.snapshot, (s) => s.mission?.status === "failed");
  const failed = final.events.find((e) => e.type === "TASK_FAILED");
  assert.include(String(failed?.payload.reason), ".forge/contract.json");
  assert.isFalse(final.events.some((e) => e.type === "CONTRACT_PROPOSED"));
}, 60_000);

it("refuses a live mission when Claude Code is unavailable", async () => {
  const forge = await open();
  let message = "";
  await forge.startMission("claude").catch((error: Error) => {
    message = error.message;
  });
  assert.include(message, "Claude Code was not found");
  assert.isNull((await forge.snapshot()).mission);
});
