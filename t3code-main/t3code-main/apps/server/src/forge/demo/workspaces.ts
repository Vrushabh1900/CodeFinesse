// @effect-diagnostics nodeBuiltinImport:off - Demo host program: a plain Node boundary around the Forge services, not Effect domain code.
/**
 * Plain-filesystem helpers for the demo: one isolated copy of the project per
 * task, change detection against the base, and a conflict-aware merge into an
 * integration directory. Copies stand in for git worktrees so the demo needs
 * no git setup; the production runner uses real worktrees.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ScanFile } from "../graphScanner.ts";

// `.forge` holds agent-to-coordinator handoff files (the contract), not project source.
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".forge", ".claude"]);
const SCANNED_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;

const toPosix = (path: string) => path.split(NodePath.sep).join("/");

/** Resolves `relativePath` inside `root`, refusing anything that would escape it. */
export function safeJoin(root: string, relativePath: string): string {
  const resolvedRoot = NodePath.resolve(root);
  const target = NodePath.resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + NodePath.sep)) {
    throw new Error(`Path escapes the workspace: ${relativePath}`);
  }
  return target;
}

export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = safeJoin(root, path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content);
  }
}

export function readText(root: string, path: string): string {
  return NodeFS.readFileSync(safeJoin(root, path), "utf8");
}

export function resetDir(path: string): void {
  NodeFS.rmSync(path, { recursive: true, force: true });
  NodeFS.mkdirSync(path, { recursive: true });
}

export function copyWorkspace(from: string, to: string): void {
  resetDir(to);
  NodeFS.cpSync(from, to, { recursive: true });
}

export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir)) {
      if (SKIPPED_DIRS.has(entry)) continue;
      const full = NodePath.join(dir, entry);
      if (NodeFS.statSync(full).isDirectory()) walk(full);
      else out.push(toPosix(NodePath.relative(root, full)));
    }
  };
  if (NodeFS.existsSync(root)) walk(root);
  return out.toSorted();
}

export function readScanFiles(root: string): ScanFile[] {
  return listFiles(root)
    .filter((path) => SCANNED_EXTENSIONS.test(path))
    .map((path) => ({ path, content: readText(root, path) }));
}

/** Files that are new or different compared with the base copy. */
export function changedFiles(baseRoot: string, workRoot: string): string[] {
  return listFiles(workRoot).filter((path) => {
    const base = safeJoin(baseRoot, path);
    return !NodeFS.existsSync(base) || NodeFS.readFileSync(base, "utf8") !== readText(workRoot, path);
  });
}

export interface IntegrationResult {
  readonly applied: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<string>;
}

/**
 * Copies the base into `integrationRoot`, then applies each task's changed
 * files. Two tasks writing different content to the same path is a conflict:
 * the first writer is kept and the path is reported, never silently merged.
 */
export function integrate(
  baseRoot: string,
  tasks: ReadonlyArray<{ readonly taskId: string; readonly root: string }>,
  integrationRoot: string,
): IntegrationResult {
  copyWorkspace(baseRoot, integrationRoot);
  const written = new Map<string, string>();
  const applied: string[] = [];
  const conflicts: string[] = [];
  for (const task of tasks) {
    for (const path of changedFiles(baseRoot, task.root)) {
      const content = readText(task.root, path);
      const previous = written.get(path);
      if (previous !== undefined && previous !== content) {
        conflicts.push(path);
        continue;
      }
      if (previous === undefined) {
        writeFiles(integrationRoot, { [path]: content });
        written.set(path, content);
        applied.push(path);
      }
    }
  }
  return { applied, conflicts };
}
