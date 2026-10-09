import type { ForgeProjectState } from "@t3tools/contracts";
import { useMemo, useState } from "react";

const COLUMN_WIDTH = 210;
const ROW_HEIGHT = 40;
const NODE_WIDTH = 172;
const NODE_HEIGHT = 28;
const TOP = 34;
const PAD = 16;

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Import graph laid out in one lane per directory. Edges a mission added are
 * drawn in the accent color; selecting an edge shows its file:line evidence.
 */
export function ForgeGraph({ graph }: { readonly graph: ForgeProjectState["graph"] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const layout = useMemo(() => {
    const files = graph.nodes.filter((node) => node.kind === "file");
    const dirs = [...new Set(files.map((node) => dirOf(node.label)))].toSorted();
    const positions = new Map<string, { x: number; y: number }>();
    let rows = 0;
    dirs.forEach((dir, column) => {
      const inDir = files
        .filter((node) => dirOf(node.label) === dir)
        .toSorted((a, b) => a.label.localeCompare(b.label));
      rows = Math.max(rows, inDir.length);
      inDir.forEach((node, row) =>
        positions.set(node.id, { x: PAD + column * COLUMN_WIDTH, y: TOP + row * ROW_HEIGHT }),
      );
    });
    const added = new Set(graph.addedEdgeIds);
    const edges = graph.edges
      .filter((edge) => edge.relation === "imports")
      .toSorted((a, b) => Number(added.has(a.id)) - Number(added.has(b.id)));
    const touched = new Set(
      edges.flatMap((edge) => (added.has(edge.id) ? [edge.from, edge.to] : [])),
    );
    const width = PAD * 2 + Math.max(dirs.length, 1) * COLUMN_WIDTH - (COLUMN_WIDTH - NODE_WIDTH);
    const height = TOP + rows * ROW_HEIGHT + 8;
    return { files, dirs, positions, added, edges, touched, width, height };
  }, [graph]);

  const selectedEdge = layout.edges.find((edge) => edge.id === selected);
  if (layout.files.length === 0) {
    return <p className="text-muted-foreground text-sm">No JavaScript or TypeScript sources found.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-auto rounded-lg border bg-background">
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label="Import graph"
          className="block"
        >
          <defs>
            <marker id="forge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 1L9 5L0 9z" className="fill-muted-foreground" />
            </marker>
            <marker id="forge-arrow-new" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 1L9 5L0 9z" className="fill-primary" />
            </marker>
          </defs>
          {layout.dirs.map((dir, column) => (
            <g key={dir}>
              <rect
                x={PAD + column * COLUMN_WIDTH - 8}
                y={8}
                width={NODE_WIDTH + 16}
                height={layout.height - 12}
                rx={10}
                className="fill-muted/60"
              />
              <text x={PAD + column * COLUMN_WIDTH} y={24} className="fill-muted-foreground font-mono text-3xs tracking-wide">
                {`${dir.toUpperCase()}/`}
              </text>
            </g>
          ))}
          {layout.edges.map((edge) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (from === undefined || to === undefined) return null;
            const y1 = from.y + NODE_HEIGHT / 2;
            const y2 = to.y + NODE_HEIGHT / 2;
            let d: string;
            if (to.x > from.x) {
              const x1 = from.x + NODE_WIDTH;
              d = `M${x1} ${y1} C${x1 + 40} ${y1} ${to.x - 40} ${y2} ${to.x} ${y2}`;
            } else if (to.x < from.x) {
              const x2 = to.x + NODE_WIDTH;
              d = `M${from.x} ${y1} C${from.x - 40} ${y1} ${x2 + 40} ${y2} ${x2} ${y2}`;
            } else {
              const x = from.x + NODE_WIDTH;
              d = `M${x} ${y1} C${x + 30} ${y1} ${x + 30} ${y2} ${x} ${y2}`;
            }
            const isNew = layout.added.has(edge.id);
            const isSelected = selected === edge.id;
            return (
              <g key={edge.id} className="cursor-pointer" onClick={() => setSelected(edge.id)}>
                <path
                  d={d}
                  fill="none"
                  markerEnd={isNew ? "url(#forge-arrow-new)" : "url(#forge-arrow)"}
                  className={isNew ? "stroke-primary" : "stroke-muted-foreground"}
                  strokeWidth={isSelected ? 3 : isNew ? 2 : 1.2}
                  opacity={isNew || isSelected ? 1 : 0.5}
                />
                <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
              </g>
            );
          })}
          {layout.files.map((node) => {
            const position = layout.positions.get(node.id);
            if (position === undefined) return null;
            const isNew = layout.touched.has(node.id);
            return (
              <g key={node.id}>
                <title>{node.label}</title>
                <rect
                  x={position.x}
                  y={position.y}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={7}
                  className={isNew ? "fill-card stroke-primary" : "fill-card stroke-border"}
                  strokeWidth={isNew ? 1.5 : 1}
                />
                <text x={position.x + 10} y={position.y + 18} className="fill-foreground font-mono text-2xs">
                  {baseName(node.label)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-xs">
        <span>Grey: existing imports</span>
        <span className="text-primary">Accent: added by this mission</span>
        {graph.truncated ? <span>Partial: the scan stopped at its file limit</span> : null}
        {selectedEdge ? (
          <span className="font-mono">
            {`${selectedEdge.from.replace("file:", "")} → ${selectedEdge.to.replace("file:", "")} · evidence ${selectedEdge.evidenceRef}`}
          </span>
        ) : null}
      </div>
    </div>
  );
}
