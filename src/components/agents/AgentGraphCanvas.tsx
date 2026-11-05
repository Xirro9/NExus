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
}

export default function AgentGraphCanvas({
  nodes: agentNodes,
  edges: agentEdges,
  positions,
  callbacks,
}: {
  nodes: AgentNode[]
  edges: AgentEdge[]
  positions: Map<string, { x: number; y: number }>
  callbacks: CanvasCallbacks
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
        },
        selected: false,
      })),
    [agentNodes, positions],
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
