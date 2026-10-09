/**
 * ForgeWorkspace - the filesystem and process work behind a Forge mission.
 *
 * Scans a bounded slice of a project's source for the import graph, reads the
 * contract an agent publishes in its worktree, lists what an agent changed
 * (via `git status`), merges task worktrees into a fresh integration worktree
 * without silently resolving conflicts, and runs one allowlisted test command
 * there, reporting the process's real exit code.
 *
 * @module ForgeWorkspace
 */
import type { ForgeVerificationCommand } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { CONTRACT_FILE, parseContract, type Contract } from "./contract.ts";
import type { ScanFile } from "./graphScanner.ts";
import { redactText } from "./redact.ts";

export class ForgeWorkspaceError extends Schema.TaggedError<ForgeWorkspaceError>()(
  "ForgeWorkspaceError",
  {
    operation: Schema.Literals(["git", "integrate", "verify"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Forge could not ${this.operation === "git" ? "read the worktree's git state" : this.operation === "integrate" ? "merge the agents' worktrees" : "run the verification command"}.`;
  }
}

export interface WorkspaceChange {
  readonly path: string;
  readonly deleted: boolean;
}

export interface IntegrationOutcome {
  readonly dir: string;
  readonly applied: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<string>;
}

export interface VerificationOutcome {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly output: string;
}

/** The only commands Forge executes; arguments are fixed, nothing comes from a client or an agent. */
export const VERIFICATION_COMMANDS: Readonly<
  Record<ForgeVerificationCommand, { readonly label: string; readonly command: string; readonly args: ReadonlyArray<string> }>
> = {
  "node-test": { label: "node --test", command: "node", args: ["--test"] },
  "npm-test": { label: "npm test", command: "npm", args: ["test"] },
  "pnpm-test": { label: "pnpm test", command: "pnpm", args: ["test"] },
  "bun-test": { label: "bun test", command: "bun", args: ["test"] },
};

const SKIPPED_DIRS = new Set([
  "node_modules", ".git", ".forge", ".t3", ".next", ".turbo", "dist", "build", "out", "coverage", ".vite",
]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const MAX_SCANNED_FILES = 400;
const MAX_VISITED_ENTRIES = 6_000;
const MAX_FILE_BYTES = 256 * 1024;
const VERIFY_TIMEOUT = Duration.minutes(10);
const MAX_OUTPUT_CHARS = 8_000;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Parses `git status --porcelain=v1 -z -uall`; rename entries carry their source path next. */
export function parsePorcelain(output: string): WorkspaceChange[] {
  const entries = output.split("\0").filter((entry) => entry.length > 0);
  const changes: WorkspaceChange[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (/[RC]/.test(status)) {
      const from = entries[i + 1];
      i += 1;
      if (from !== undefined && /R/.test(status)) changes.push({ path: from, deleted: true });
    }
    changes.push({ path, deleted: /D/.test(status) });
  }
  return changes.filter((change) => !change.path.startsWith(".forge/"));
}

export class ForgeWorkspace extends Context.Service<
  ForgeWorkspace,
  {
    readonly scan: (
      root: string,
    ) => Effect.Effect<{ readonly files: ReadonlyArray<ScanFile>; readonly truncated: boolean }>;
    readonly readContract: (worktree: string) => Effect.Effect<Option.Option<Contract>>;
    readonly changes: (
      worktree: string,
    ) => Effect.Effect<ReadonlyArray<WorkspaceChange>, ForgeWorkspaceError>;
    readonly integrate: (input: {
      readonly projectRoot: string;
      readonly worktrees: ReadonlyArray<string>;
    }) => Effect.Effect<IntegrationOutcome, ForgeWorkspaceError>;
    readonly verify: (input: {
      readonly cwd: string;
      readonly command: ForgeVerificationCommand;
    }) => Effect.Effect<VerificationOutcome, ForgeWorkspaceError>;
  }
>()("t3/forge/ForgeWorkspace") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const toPosix = (value: string) => value.split(path.sep).join("/");

  /** Runs a fixed command and returns its combined output and real exit code. */
  const run = (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    options: { readonly shell?: boolean } = {},
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        // In shell mode the fixed command and arguments are one string: nothing in them comes from
        // a client or an agent, and passing an argument list to a shell is deprecated in Node.
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            options.shell === true ? [command, ...args].join(" ") : command,
            options.shell === true ? [] : args,
            {
              cwd,
              stdin: "ignore",
              extendEnv: true,
              // The decision-engine key never reaches a project's scripts.
              env: { JEV_API_KEY: "" },
              ...(options.shell === true ? { shell: true } : {}),
            },
          ),
        );
        const [output, exitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
          { concurrency: 2 },
        );
        return { output, exitCode: Number(exitCode) };
      }),
    );

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    run("git", args, cwd).pipe(
      Effect.mapError((cause) => new ForgeWorkspaceError({ operation: "git", cause })),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.output)
          : Effect.fail(
              new ForgeWorkspaceError({
                operation: "git",
                cause: `git ${args[0]} exited with ${result.exitCode}: ${result.output.slice(-300)}`,
              }),
            ),
      ),
    );

  const scan: ForgeWorkspace["Service"]["scan"] = Effect.fn("ForgeWorkspace.scan")(function* (root) {
    const files: ScanFile[] = [];
    const pending = [root];
    let visited = 0;
    let truncated = false;
    while (pending.length > 0) {
      const dir = pending.shift()!;
      const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
      for (const name of names.toSorted()) {
        visited += 1;
        if (visited > MAX_VISITED_ENTRIES || files.length >= MAX_SCANNED_FILES) {
          truncated = true;
          break;
        }
        const full = path.join(dir, name);
        const info = yield* fs.stat(full).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        if (info.value.type === "Directory") {
          if (!SKIPPED_DIRS.has(name)) pending.push(full);
        } else if (
          info.value.type === "File" &&
          SOURCE_FILE.test(name) &&
          Number(info.value.size) <= MAX_FILE_BYTES
        ) {
          const content = yield* fs.readFileString(full).pipe(Effect.option);
          if (Option.isSome(content)) {
            files.push({ path: toPosix(path.relative(root, full)), content: content.value });
          }
        }
      }
      if (truncated) break;
    }
    return { files, truncated };
  });

  const readContract: ForgeWorkspace["Service"]["readContract"] = (worktree) =>
    fs.readFileString(path.join(worktree, CONTRACT_FILE)).pipe(
      Effect.option,
      Effect.map((raw) =>
        Option.flatMap(raw, (text) =>
          Option.flatMap(decodeJson(text), (json) => Option.fromNullishOr(parseContract(json))),
        ),
      ),
    );

  const changes: ForgeWorkspace["Service"]["changes"] = (worktree) =>
    git(worktree, ["status", "--porcelain=v1", "-z", "-uall"]).pipe(Effect.map(parsePorcelain));

  const sameBytes = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  const integrate: ForgeWorkspace["Service"]["integrate"] = Effect.fn("ForgeWorkspace.integrate")(
    function* ({ projectRoot, worktrees }) {
      const parent = yield* fs
        .makeTempDirectory({ prefix: "t3-forge-" })
        .pipe(Effect.mapError((cause) => new ForgeWorkspaceError({ operation: "integrate", cause })));
      const dir = path.join(parent, "integration");
      yield* git(projectRoot, ["worktree", "add", "--detach", dir, "HEAD"]);

      const written = new Map<string, Uint8Array | null>();
      const applied: string[] = [];
      const conflicts = new Set<string>();
      for (const worktree of worktrees) {
        for (const change of yield* changes(worktree)) {
          const content = change.deleted
            ? null
            : yield* fs
                .readFile(path.join(worktree, change.path))
                .pipe(Effect.mapError((cause) => new ForgeWorkspaceError({ operation: "integrate", cause })));
          if (written.has(change.path)) {
            const previous = written.get(change.path)!;
            const same = previous === null ? content === null : content !== null && sameBytes(previous, content);
            // First writer wins; a differing second write is reported, never merged.
            if (!same) conflicts.add(change.path);
            continue;
          }
          written.set(change.path, content);
          const target = path.join(dir, change.path);
          yield* (content === null
            ? fs.remove(target, { force: true })
            : fs
                .makeDirectory(path.dirname(target), { recursive: true })
                .pipe(Effect.andThen(fs.writeFile(target, content)))
          ).pipe(Effect.mapError((cause) => new ForgeWorkspaceError({ operation: "integrate", cause })));
          applied.push(change.path);
        }
      }
      // Reuse the project's installed dependencies so the test command can resolve them.
      const deps = path.join(projectRoot, "node_modules");
      if ((yield* fs.exists(deps).pipe(Effect.orElseSucceed(() => false))) === true) {
        yield* fs.symlink(deps, path.join(dir, "node_modules")).pipe(Effect.ignore);
      }
      return { dir, applied, conflicts: [...conflicts] };
    },
  );

  const verify: ForgeWorkspace["Service"]["verify"] = Effect.fn("ForgeWorkspace.verify")(
    function* ({ cwd, command }) {
      const spec = VERIFICATION_COMMANDS[command];
      const startedMs = yield* Clock.currentTimeMillis;
      const result = yield* run(spec.command, spec.args, cwd, { shell: true }).pipe(
        Effect.timeoutOption(VERIFY_TIMEOUT),
        Effect.mapError((cause) => new ForgeWorkspaceError({ operation: "verify", cause })),
      );
      const durationMs = (yield* Clock.currentTimeMillis) - startedMs;
      // A timeout has no exit code and is never reported as a pass.
      return Option.match(result, {
        onNone: () => ({
          command: spec.label,
          cwd,
          exitCode: -1,
          durationMs,
          output: `Timed out after ${Duration.toMinutes(VERIFY_TIMEOUT)} minutes.`,
        }),
        onSome: ({ output, exitCode }) => ({
          command: spec.label,
          cwd,
          exitCode,
          durationMs,
          output: redactText(output).slice(-MAX_OUTPUT_CHARS),
        }),
      });
    },
  );

  return ForgeWorkspace.of({ scan, readContract, changes, integrate, verify });
});

export const layer = Layer.effect(ForgeWorkspace, make);
