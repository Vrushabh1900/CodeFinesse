// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Demo host program: a plain Node boundary around the Forge services, not Effect domain code.
/**
 * Starts the Forge demo dashboard.
 *
 *   node --env-file=<path to .env> apps/server/src/forge/demo/main.ts
 *
 * Binds to 127.0.0.1 only. State lives in %LOCALAPPDATA%/t3-forge-demo (or
 * FORGE_DEMO_DATA). Without JEV_API_KEY the route decision is answered by the
 * labelled rules fallback. Live agents use the local `claude` CLI; set
 * FORGE_AGENT_MODEL (e.g. `sonnet`) to choose its model.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { createDemoForge } from "./DemoForge.ts";

const PORT = Number(process.env.FORGE_DEMO_PORT ?? 4317);
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const dashboard = NodeFS.readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

// Outside any repository on purpose: live agents read CLAUDE.md/AGENTS.md from parent folders,
// and must never sit next to the .env that holds the decision-engine key.
const defaultDataDir = NodePath.join(process.env.LOCALAPPDATA ?? NodeOS.tmpdir(), "t3-forge-demo");

const forge = await createDemoForge({
  dataDir: process.env.FORGE_DEMO_DATA ?? defaultDataDir,
  env: process.env,
  ...(process.env.FORGE_DEMO_STEP_MS === undefined
    ? {}
    : { stepMs: Number(process.env.FORGE_DEMO_STEP_MS) }),
  claude: {
    ...(process.env.FORGE_CLAUDE_PATH === undefined ? {} : { path: process.env.FORGE_CLAUDE_PATH }),
    ...(process.env.FORGE_AGENT_MODEL === undefined ? {} : { model: process.env.FORGE_AGENT_MODEL }),
    ...(process.env.FORGE_AGENT_TIMEOUT_MS === undefined
      ? {}
      : { timeoutMs: Number(process.env.FORGE_AGENT_TIMEOUT_MS) }),
  },
});

function send(res: NodeHttp.ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  });
  res.end(text);
}

function readJson(req: NodeHttp.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw === "") return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return reject(new Error("Expected a JSON object"));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const sameOrigin = (req: NodeHttp.IncomingMessage): boolean => {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
};

const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error("A required field is empty");
  return value.trim().slice(0, max);
};

const server = NodeHttp.createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, dashboard);
      if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, await forge.snapshot());
      if (req.method !== "POST") return send(res, 404, { error: "Not found" });
      if (!sameOrigin(req)) return send(res, 403, { error: "Cross-origin request refused" });

      const body = await readJson(req);
      switch (url.pathname) {
        case "/api/decision":
          await forge.addDecision({ title: text(body.title, 200), body: text(body.body, 2000) });
          break;
        case "/api/mission/start":
          await forge.startMission(body.agentMode === "claude" ? "claude" : "scripted");
          break;
        case "/api/contract/ack":
          await forge.acknowledgeContract();
          break;
        case "/api/integrate":
          await forge.integrateAndVerify();
          break;
        case "/api/reset":
          await forge.reset();
          break;
        default:
          return send(res, 404, { error: "Not found" });
      }
      return send(res, 200, { ok: true });
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : "Request failed" });
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`T3 Forge demo: http://${HOST}:${PORT}`);
  console.log(`Jev: ${process.env.JEV_API_KEY ? "key found" : "no key, rules fallback"}`);
  void forge.snapshot().then((s) =>
    console.log(
      `Live agents: ${s.liveAgents.claude.available ? `Claude Code ${s.liveAgents.claude.version ?? ""}` : "claude CLI not found"}`,
    ),
  );
});

const shutdown = () => {
  server.close();
  void forge.dispose().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
