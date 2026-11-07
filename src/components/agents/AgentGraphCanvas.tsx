// xyflow canvas (SPEC-PHASE3 §2.4) — the ONLY file importing @xyflow/react,
// React.lazy-loaded so the library never enters the entry bundle (§12.3).
// Unmounted when the Agents tab is hidden (zero-measure guard, §0.12).
//
// P0 session control: node context menus + End buttons reach the card through
// the node data. Callbacks are passed via a ref-stable wrapper so identity
// churn in AgentGraphView never rebuilds the nodes memo.

import { useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react"
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { useWorkspace } from "@/store/workspace"
import type { AgentEdge, AgentNode } from "./graph"
import { AgentNodeCard, type AgentNodeData } from "./AgentNodeCard"

function statusColor(status: AgentNode["status"]): string {
  switch (status) {
    case "running":
      return "var(--primary)"
    case "succeeded":
      return "var(--success)"
    case "failed":
      return "var(--destructive)"
    case "interrupted":
      return "var(--warning)"
    default:
      return "var(--muted-foreground)"
  }
}

export interface CanvasCallbacks {
  onContextMenu(e: { clientX: number; clientY: number; preventDefault(): void }, id: string): void
  onEnd(id: string): void
  /** collapse/expand a node's subtree (Phase D4 — shared with the tree view) */
  onToggleCollapse(id: string): void
}

export default function AgentGraphCanvas({
  nodes: agentNodes,
  edges: agentEdges,
  hasChildIds,
  positions,
  callbacks,
  highlightIds,
  collapsedIds,
}: {
  nodes: AgentNode[]
  edges: AgentEdge[]
  /** parents in the UNFILTERED edge list — collapsed nodes keep their
   *  expand chevron even though their child edges are filtered out */
  hasChildIds: Set<string>
  positions: Map<string, { x: number; y: number }>
  callbacks: CanvasCallbacks
  /** active search matches — null when no search (D4.2 highlight, not filter) */
  highlightIds: Set<string> | null
  /** nodes whose subtree is collapsed (chevron state on the card) */
  collapsedIds: Set<string>
}) {
  // keep the latest callbacks without invalidating the nodes memo
  const cbRef = useRef<CanvasCallbacks>(callbacks)
  cbRef.current = callbacks

  const selectNode = (id: string | null) => {
    useWorkspace.setState({ selectedGraphNode: id })
  }

  const nodes: Node<AgentNodeData>[] = useMemo(
    () =>
      agentNodes.map((n) => ({
        id: n.id,
        type: "agent",
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: {
          ...n,
          onContextMenu: (e: Parameters<CanvasCallbacks["onContextMenu"]>[0], id: string) =>
            cbRef.current.onContextMenu(e, id),
          onEnd: (id: string) => cbRef.current.onEnd(id),
          onToggleCollapse: (id: string) => cbRef.current.onToggleCollapse(id),
          hasChildren: hasChildIds.has(n.id),
          collapsed: collapsedIds.has(n.id),
          // highlight semantics: null set = search inactive (no dimming)
          searchState:
            highlightIds === null
              ? undefined
              : highlightIds.has(n.id)
                ? ("hit" as const)
                : ("dim" as const),
        },
        selected: false,
      })),
    [agentNodes, positions, hasChildIds, collapsedIds, highlightIds],
  )
  const runningIds = useMemo(
    () => new Set(agentNodes.filter((n) => n.status === "running").map((n) => n.id)),
    [agentNodes],
  )
  const edges: Edge[] = useMemo(
    () =>
      agentEdges.map((e) => {
        const busy = runningIds.has(e.source) || runningIds.has(e.target)
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "smoothstep",
          animated: busy,
          // busy sessions carry the cyan flow; idle edges stay hairline-neutral
          style: busy
            ? { stroke: "var(--primary)", strokeWidth: 1.5 }
            : { strokeWidth: 1 },
        }
      }),
    [agentEdges, runningIds],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={{ agent: AgentNodeCard }}
      onNodeClick={(_, node) => selectNode(node.id)}
      onPaneClick={() => selectNode(null)}
      onNodeContextMenu={(
        e: ReactMouseEvent,
        node: { id: string },
      ) => cbRef.current.onContextMenu(e, node.id)}
      fitView
      proOptions={{ hideAttribution: false }}
      minZoom={0.2}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={true}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        ariaLabel="Graph minimap"
        nodeColor={(n) => statusColor((n.data as AgentNodeData).status)}
        className="!border-border/60"
      />
    </ReactFlow>
  )
}
