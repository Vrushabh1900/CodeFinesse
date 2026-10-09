import { assert, it } from "@effect/vitest";

import { diffEdges, scanImports } from "./graphScanner.ts";

const files = [
  {
    path: "server/routes/login.ts",
    content: `import { sign } from "../auth/jwt";\nimport express from "express";\nexport * from "./helpers.js";\n`,
  },
  { path: "server/auth/jwt.ts", content: `export const sign = () => "";\n` },
  { path: "server/routes/helpers.ts", content: `const lazy = () => import("../auth/jwt");\n` },
];

it("creates verified import edges with file:line evidence", () => {
  const graph = scanImports(files);
  const edge = graph.edges.find(
    (e) => e.id === "imports:file:server/routes/login.ts->file:server/auth/jwt.ts",
  );
  assert.equal(edge?.evidenceRef, "server/routes/login.ts:1");
  assert.equal(edge?.status, "verified");
});

it("resolves .js specifiers to TypeScript sources and dynamic imports", () => {
  const graph = scanImports(files);
  const ids = graph.edges.map((e) => e.id);
  assert.include(ids, "imports:file:server/routes/login.ts->file:server/routes/helpers.ts");
  assert.include(ids, "imports:file:server/routes/helpers.ts->file:server/auth/jwt.ts");
});

it("does not invent edges for packages or unresolved paths", () => {
  const graph = scanImports(files);
  assert.isFalse(graph.edges.some((e) => e.to.includes("express")));
  assert.isFalse(scanImports([{ path: "a.ts", content: `import "./missing";` }]).edges.some(
    (e) => e.relation === "imports",
  ));
});

it("adds module containment edges and is idempotent across rescans", () => {
  const first = scanImports(files);
  const second = scanImports(files.toReversed());
  assert.include(
    first.edges.map((e) => e.id),
    "contains:module:server/auth->file:server/auth/jwt.ts",
  );
  assert.deepEqual(
    first.edges.map((e) => e.id).toSorted(),
    second.edges.map((e) => e.id).toSorted(),
  );
  assert.equal(new Set(first.nodes.map((n) => n.id)).size, first.nodes.length);
});

it("reports only new edges between two scans", () => {
  const before = scanImports(files);
  const after = scanImports([
    ...files,
    { path: "server/routes/oauth.ts", content: `import { sign } from "../auth/jwt";\n` },
  ]);
  const added = diffEdges(before, after).filter((e) => e.relation === "imports");
  assert.deepEqual(
    added.map((e) => [e.id, e.evidenceRef]),
    [["imports:file:server/routes/oauth.ts->file:server/auth/jwt.ts", "server/routes/oauth.ts:1"]],
  );
});
