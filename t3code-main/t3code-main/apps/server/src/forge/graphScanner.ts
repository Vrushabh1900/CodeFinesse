/**
 * Grounded import graph for the Forge knowledge graph.
 *
 * Every node and edge produced here comes from a source file the scanner read;
 * an edge's `evidenceRef` is `<relative path>:<line>` of the import statement.
 * Ids are deterministic so rescanning never duplicates anything. Imports that
 * resolve to no scanned file (packages, generated files) produce no edge rather
 * than a guessed one.
 */
import type { ForgeEvent, ForgeGraphEdge, ForgeGraphNode } from "@t3tools/contracts";

export interface ScanFile {
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly content: string;
}

export interface GraphSnapshot {
  readonly nodes: ReadonlyArray<ForgeGraphNode>;
  readonly edges: ReadonlyArray<ForgeGraphEdge>;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;
const IMPORT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bimport\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[^'"]*?\sfrom\s+["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

export const fileNodeId = (path: string) => `file:${path}`;
export const moduleNodeId = (dir: string) => `module:${dir === "" ? "." : dir}`;
export const edgeId = (relation: string, from: string, to: string) => `${relation}:${from}->${to}`;

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function resolveRelative(fromPath: string, specifier: string, known: ReadonlySet<string>) {
  if (!specifier.startsWith(".")) return null;
  const base = normalize(`${dirname(fromPath)}/${specifier}`);
  if (base === null) return null;
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
    // `./x.js` in TypeScript sources commonly points at `./x.ts`.
    ...(/\.(m|c)?jsx?$/.test(base)
      ? SOURCE_EXTENSIONS.map((ext) => base.replace(/\.(m|c)?jsx?$/, ext))
      : []),
  ];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

export function scanImports(files: ReadonlyArray<ScanFile>): GraphSnapshot {
  const known = new Set(files.map((file) => file.path));
  const nodes = new Map<string, ForgeGraphNode>();
  const edges = new Map<string, ForgeGraphEdge>();

  const addEdge = (
    relation: ForgeGraphEdge["relation"],
    from: string,
    to: string,
    evidenceRef: string,
  ) => {
    const id = edgeId(relation, from, to);
    // First evidence wins, so repeated imports keep the earliest source line.
    if (!edges.has(id)) edges.set(id, { id, from, to, relation, evidenceRef, status: "verified" });
  };

  for (const file of [...files].toSorted((a, b) => a.path.localeCompare(b.path))) {
    const fileId = fileNodeId(file.path);
    nodes.set(fileId, {
      id: fileId,
      kind: "file",
      label: file.path,
      evidenceRef: file.path,
      status: "verified",
    });
    const dir = dirname(file.path);
    const moduleId = moduleNodeId(dir);
    if (!nodes.has(moduleId)) {
      nodes.set(moduleId, {
        id: moduleId,
        kind: "module",
        label: dir === "" ? "." : dir,
        evidenceRef: dir === "" ? "." : dir,
        status: "verified",
      });
    }
    addEdge("contains", moduleId, fileId, file.path);

    const lineStarts: number[] = [0];
    for (let i = 0; i < file.content.length; i += 1) {
      if (file.content[i] === "\n") lineStarts.push(i + 1);
    }
    const lineOf = (offset: number) => {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (lineStarts[mid]! <= offset) low = mid;
        else high = mid - 1;
      }
      return low + 1;
    };

    for (const pattern of IMPORT_PATTERNS) {
      for (const match of file.content.matchAll(pattern)) {
        const target = resolveRelative(file.path, match[1]!, known);
        if (target === null || target === file.path) continue;
        addEdge("imports", fileId, fileNodeId(target), `${file.path}:${lineOf(match.index)}`);
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Edges present in `next` but not in `previous`: the evidenced delta a mission may report. */
export function diffEdges(previous: GraphSnapshot, next: GraphSnapshot): ForgeGraphEdge[] {
  const before = new Set(previous.edges.map((edge) => edge.id));
  return next.edges.filter((edge) => !before.has(edge.id));
}

/**
 * The graph a client renders: the scanned base plus every edge a mission
 * recorded as GRAPH_EDGE_ADDED, with nodes for files the base scan has not seen.
 */
export function overlayAddedEdges(
  base: GraphSnapshot,
  events: ReadonlyArray<ForgeEvent>,
): GraphSnapshot & { readonly addedEdgeIds: ReadonlyArray<string> } {
  const added = events
    .filter((event) => event.type === "GRAPH_EDGE_ADDED")
    .map((event) => event.payload as unknown as ForgeGraphEdge);
  const nodeIds = new Set(base.nodes.map((node) => node.id));
  const extraNodes: ForgeGraphNode[] = [];
  for (const edge of added) {
    for (const end of [edge.from, edge.to]) {
      if (nodeIds.has(end)) continue;
      nodeIds.add(end);
      extraNodes.push({ id: end, kind: "file", label: end.replace(/^file:/, ""), status: "verified" });
    }
  }
  const baseEdgeIds = new Set(base.edges.map((edge) => edge.id));
  return {
    nodes: [...base.nodes, ...extraNodes],
    edges: [...base.edges, ...added.filter((edge) => !baseEdgeIds.has(edge.id))],
    addedEdgeIds: added.map((edge) => edge.id),
  };
}
