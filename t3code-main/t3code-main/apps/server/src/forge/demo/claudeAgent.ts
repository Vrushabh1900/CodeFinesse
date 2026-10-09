// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off - Demo host program: spawns and supervises a provider CLI process.
/**
 * Runs a real Claude Code agent (`claude -p`) in one task workspace.
 *
 * The agent may read and edit files in its workspace and run `node --test`;
 * every other shell command, web access and anything outside the workspace is
 * denied by Claude Code's non-interactive permission handling. Its tool calls
 * are streamed back as they happen, and a contract it writes to
 * `.forge/contract.json` is picked up while it is still working.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { CONTRACT_FILE, parseContract, type Contract } from "../contract.ts";
import { redactText } from "../redact.ts";

export interface ClaudeAgentOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly claudePath?: string;
  /** Runs `file ...args <claude args>` instead of the claude binary (tests use a fake agent). */
  readonly launcher?: { readonly file: string; readonly args: ReadonlyArray<string> };
  readonly model?: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly onActivity: (activity: AgentActivity) => void;
  readonly onContract?: (contract: Contract) => void;
}

export type AgentActivity =
  | { readonly kind: "wrote" | "edited"; readonly path: string }
  | { readonly kind: "ran"; readonly command: string };

export interface ClaudeAgentResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly reason?: string;
  readonly numTurns?: number;
  readonly costUsd?: number;
  readonly durationMs: number;
}

const ALLOWED_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "TodoWrite", "Bash(node --test:*)"];
const DENIED_TOOLS = ["WebFetch", "WebSearch"];
const CONTRACT_POLL_MS = 700;

/** Never hand the decision-engine key or Forge's own settings to an agent process. */
export function agentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(JEV_|FORGE_)/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function detectClaude(
  claudePath = "claude",
): Promise<{ readonly available: boolean; readonly version?: string }> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(claudePath, ["--version"], { timeout: 15_000, windowsHide: true }, (error, stdout) => {
      if (error !== null) return resolve({ available: false });
      resolve({ available: true, version: stdout.trim().split("\n")[0] ?? "" });
    });
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Workspace-NodePath.relative POSIX path, or null when the tool touched something outside it. */
function insideWorkspace(cwd: string, filePath: string): string | null {
  const rel = NodePath.relative(cwd, NodePath.isAbsolute(filePath) ? filePath : NodePath.join(cwd, filePath));
  if (rel === "" || rel.startsWith("..") || NodePath.isAbsolute(rel)) return null;
  return rel.split(NodePath.sep).join("/");
}

export function runClaudeAgent(options: ClaudeAgentOptions): Promise<ClaudeAgentResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--disallowedTools",
    ...DENIED_TOOLS,
    ...(options.model === undefined ? [] : ["--model", options.model]),
  ];

  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(
      options.launcher?.file ?? options.claudePath ?? "claude",
      [...(options.launcher?.args ?? []), ...args],
      {
      cwd: options.cwd,
      env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let settled = false;
    let contractSeen = false;
    let buffer = "";
    let stderr = "";
    let result: Record<string, unknown> | undefined;

    const checkContract = () => {
      if (contractSeen || options.onContract === undefined) return;
      let raw: string;
      try {
        raw = NodeFS.readFileSync(NodePath.join(options.cwd, CONTRACT_FILE), "utf8");
      } catch {
        return; // not written yet
      }
      try {
        const contract = parseContract(JSON.parse(raw));
        if (contract !== null) {
          contractSeen = true;
          options.onContract(contract);
        }
      } catch {
        // Partially written or invalid JSON: look again on the next tick.
      }
    };
    const poll = setInterval(checkContract, CONTRACT_POLL_MS);
    const timer = setTimeout(() => {
      finish({ ok: false, summary: "", reason: `timed out after ${options.timeoutMs} ms` });
      child.kill();
    }, options.timeoutMs);

    function finish(outcome: Omit<ClaudeAgentResult, "durationMs">) {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      checkContract();
      resolve({ ...outcome, durationMs: elapsed() });
    }

    const handleLine = (line: string) => {
      if (line.trim() === "") return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      if (message.type === "result") {
        result = message;
        return;
      }
      if (message.type !== "assistant" || !isRecord(message.message)) return;
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const item of content) {
        if (!isRecord(item) || item.type !== "tool_use" || !isRecord(item.input)) continue;
        const name = item.name;
        if ((name === "Write" || name === "Edit" || name === "MultiEdit") && typeof item.input.file_path === "string") {
          const path = insideWorkspace(options.cwd, item.input.file_path);
          if (path !== null) options.onActivity({ kind: name === "Write" ? "wrote" : "edited", path });
        } else if (name === "Bash" && typeof item.input.command === "string") {
          options.onActivity({ kind: "ran", command: redactText(item.input.command).slice(0, 200) });
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.on("error", (error) =>
      finish({ ok: false, summary: "", reason: `could not start claude: ${error.message}` }),
    );
    child.on("close", (code) => {
      handleLine(buffer);
      const isError = result?.is_error === true || result?.subtype !== "success";
      const summary = typeof result?.result === "string" ? redactText(result.result).slice(0, 600) : "";
      finish({
        ok: code === 0 && result !== undefined && !isError,
        summary,
        ...(code === 0 && result !== undefined && !isError
          ? {}
          : {
              reason:
                result === undefined
                  ? `claude exited with code ${code}${stderr ? `: ${redactText(stderr).slice(-300)}` : ""}`
                  : `agent ended with ${String(result.subtype)}`,
            }),
        ...(typeof result?.num_turns === "number" ? { numTurns: result.num_turns } : {}),
        ...(typeof result?.total_cost_usd === "number" ? { costUsd: result.total_cost_usd } : {}),
      });
    });

    child.stdin.end(options.prompt);
  });
}

/** Role-specific framing around the Forge task prompt for a live agent. */
export function livePrompt(role: string, forgePrompt: string): string {
  const base = [
    "You are a coding agent working inside T3 Forge on a small dependency-free Node.js (CommonJS) project in the current directory.",
    "Read the existing code first and follow its patterns. Keep the change small and focused. Do not add npm dependencies.",
    "You may run `node --test` to check your work; no other shell commands are available. Work only inside the current directory.",
  ];
  if (role === "backend") {
    base.push(
      `Another agent will build the frontend against your API in parallel. As soon as you have decided the endpoint, write it to \`${CONTRACT_FILE}\` as JSON shaped like {"endpoint": "POST /path", "request": {...}, "response": {...}}, before you finish the implementation.`,
      "Register the route in server/index.js and add a test under tests/.",
      "You own server/ only. Do not modify anything under web/; the frontend agent owns it.",
    );
  } else if (role === "frontend") {
    base.push(
      "Implement exactly against the agreed API contract below; the backend is being built separately and will be merged with your work.",
      "You own web/ only. Do not modify anything under server/: the endpoint does not exist in your copy yet, and the backend agent's work is merged with yours afterwards.",
      "Add a test under tests/ that exercises your UI module through the contract's endpoint. It is expected to fail in your copy until the merge; do not try to make it pass by changing server/.",
    );
  } else {
    base.push("Implement both the server route and the web side, and add tests under tests/.");
  }
  return `${base.join("\n")}\n\n---\n\n${forgePrompt}`;
}
