/**
 * Role-specific framing around a Forge task prompt for a live agent running in
 * a T3 thread. It states who owns which part of the code, and tells the agent
 * that owns an API how to publish its contract so the dependent agent can be
 * started against it.
 */
import type { ForgeTaskRole } from "@t3tools/contracts";

import { CONTRACT_FILE } from "./contract.ts";

export function briefAgent(role: ForgeTaskRole, forgePrompt: string): string {
  const lines = [
    "You are one agent in a T3 Forge mission. Other agents may work on the same repository in separate worktrees, and their changes are merged with yours afterwards.",
    "Read the existing code first and follow its patterns. Keep the change focused on your task. Do not commit, push, or switch branches.",
  ];
  if (role === "backend") {
    lines.push(
      `A frontend agent will build against your API. As soon as you have decided the endpoint, write it to \`${CONTRACT_FILE}\` as JSON shaped like {"endpoint": "POST /path", "request": {...}, "response": {...}} before you finish the implementation. Forge reads that file; it is not part of the project.`,
      "Own the server side only; leave UI code to the frontend agent. Add or update tests for your endpoint.",
    );
  } else if (role === "frontend") {
    lines.push(
      "Implement exactly against the acknowledged API contract below. The backend is being built in a separate worktree, so the endpoint may not exist in your copy yet; do not implement it yourself.",
      "Own the UI side only. Add or update tests for your UI code.",
    );
  } else {
    lines.push("Implement the whole change, server and UI, and add or update tests.");
  }
  return `${lines.join("\n")}\n\n---\n\n${forgePrompt}`;
}
