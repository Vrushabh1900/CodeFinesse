import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { SAMPLE_APP_FILES } from "./demo/sampleApp.ts";
import * as ForgeWorkspace from "./ForgeWorkspace.ts";

const TestLayer = ForgeWorkspace.layer.pipe(Layer.provideMerge(NodeServices.layer));

const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* spawner.exitCode(
      ChildProcess.make("git", args, { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    );
    assert.equal(Number(code), 0, `git ${args.join(" ")}`);
  });

/** A committed copy of the demo app plus two task worktrees, like two agents' checkouts. */
const repoWithTwoWorktrees = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "forge-ws-" });
  const repo = path.join(root, "repo");
  for (const [file, content] of Object.entries(SAMPLE_APP_FILES)) {
    yield* fs.makeDirectory(path.dirname(path.join(repo, file)), { recursive: true });
    yield* fs.writeFileString(path.join(repo, file), content);
  }
  yield* git(repo, "init", "-q");
  yield* git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  yield* git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const a = path.join(root, "wt-backend");
  const b = path.join(root, "wt-frontend");
  yield* git(repo, "worktree", "add", "-q", "--detach", a, "HEAD");
  yield* git(repo, "worktree", "add", "-q", "--detach", b, "HEAD");
  return { fs, path, repo, a, b };
});

it.effect("parses porcelain output including renames and ignores the .forge handoff dir", () =>
  Effect.sync(() => {
    const out = [" M server/index.js", "?? web/New.js", "R  web/b.js", "web/a.js", " D old.js", "?? .forge/contract.json", ""].join("\0");
    assert.deepEqual(ForgeWorkspace.parsePorcelain(out), [
      { path: "server/index.js", deleted: false },
      { path: "web/New.js", deleted: false },
      { path: "web/a.js", deleted: true },
      { path: "web/b.js", deleted: false },
      { path: "old.js", deleted: true },
    ]);
  }),
);

it.effect(
  "merges two worktrees into an integration worktree and reports the real test exit code",
  () =>
    Effect.gen(function* () {
      const { fs, path, repo, a, b } = yield* repoWithTwoWorktrees;
      const workspace = yield* ForgeWorkspace.ForgeWorkspace;

      // Backend publishes a contract and adds a route; frontend adds a passing test.
      yield* fs.makeDirectory(path.join(a, ".forge"), { recursive: true });
      yield* fs.writeFileString(
        path.join(a, ".forge", "contract.json"),
        JSON.stringify({ endpoint: "POST /auth/google-mock", response: { token: "string" } }),
      );
      yield* fs.writeFileString(path.join(a, "server", "routes", "ping.js"), "module.exports = () => 'pong';\n");
      yield* fs.writeFileString(
        path.join(b, "tests", "ping.test.js"),
        "const test = require('node:test');\nconst assert = require('node:assert');\ntest('pong', () => assert.equal(require('../server/routes/ping')(), 'pong'));\n",
      );

      const contract = yield* workspace.readContract(a);
      assert.equal(Option.getOrUndefined(contract)?.endpoint, "POST /auth/google-mock");
      assert.isTrue(Option.isNone(yield* workspace.readContract(b)));

      const changes = yield* workspace.changes(a);
      assert.deepEqual(changes.map((c) => c.path), ["server/routes/ping.js"]);

      const merged = yield* workspace.integrate({ projectRoot: repo, worktrees: [a, b] });
      assert.deepEqual([...merged.applied].toSorted(), ["server/routes/ping.js", "tests/ping.test.js"]);
      assert.deepEqual(merged.conflicts, []);

      const passed = yield* workspace.verify({ cwd: merged.dir, command: "node-test" });
      assert.equal(passed.exitCode, 0);
      assert.equal(passed.command, "node --test");

      // Break the merged code: the verifier must report the failure, not a pass.
      yield* fs.writeFileString(path.join(merged.dir, "server", "routes", "ping.js"), "module.exports = () => 'nope';\n");
      const failed = yield* workspace.verify({ cwd: merged.dir, command: "node-test" });
      assert.notEqual(failed.exitCode, 0);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  60_000,
);

it.effect(
  "reports two agents writing different content to one file as a conflict",
  () =>
    Effect.gen(function* () {
      const { fs, path, repo, a, b } = yield* repoWithTwoWorktrees;
      const workspace = yield* ForgeWorkspace.ForgeWorkspace;
      yield* fs.writeFileString(path.join(a, "server", "index.js"), "// backend version\n");
      yield* fs.writeFileString(path.join(b, "server", "index.js"), "// frontend version\n");
      const merged = yield* workspace.integrate({ projectRoot: repo, worktrees: [a, b] });
      assert.deepEqual(merged.conflicts, ["server/index.js"]);
      // First writer is kept, never a silent blend.
      assert.equal(
        yield* fs.readFileString(path.join(merged.dir, "server", "index.js")),
        "// backend version\n",
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  60_000,
);

it.effect("scans source files with a bound and skips dependency folders", () =>
  Effect.gen(function* () {
    const { fs, path, repo } = yield* repoWithTwoWorktrees;
    const workspace = yield* ForgeWorkspace.ForgeWorkspace;
    yield* fs.makeDirectory(path.join(repo, "node_modules", "x"), { recursive: true });
    yield* fs.writeFileString(path.join(repo, "node_modules", "x", "index.js"), "module.exports = 1;\n");
    const scanned = yield* workspace.scan(repo);
    const paths = scanned.files.map((f) => f.path);
    assert.include(paths, "server/auth/jwt.js");
    assert.isFalse(paths.some((p) => p.startsWith("node_modules")));
    assert.isFalse(scanned.truncated);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
