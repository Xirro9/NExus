// xyflow canvas (SPEC-PHASE3 §2.4) — the ONLY file importing @xyflow/react,
// React.lazy-loaded so the library never enters the entry bundle (§12.3).
// Unmounted when the Agents tab is hidden (zero-measure guard, §0.12).

import { useMemo } from "react"
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

export default function AgentGraphCanvas({
  nodes: agentNodes,
  edges: agentEdges,
  positions,
}: {
  nodes: AgentNode[]
  edges: AgentEdge[]
  positions: Map<string, { x: number; y: number }>
}) {
  const selectNode = (id: string | null) => {
    useWorkspace.setState({ selectedGraphNode: id })
  }

  const nodes: Node<AgentNodeData>[] = useMemo(
    () =>
      agentNodes.map((n) => ({
        id: n.id,
        type: "agent",
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { ...n } as AgentNodeData,
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
      agentEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "smoothstep",
        animated: runningIds.has(e.source) || runningIds.has(e.target),
      })),
    [agentEdges, runningIds],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={{ agent: AgentNodeCard }}
      onNodeClick={(_, node) => selectNode(node.id)}
      onPaneClick={() => selectNode(null)}
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
        nodeColor={(n) => statusColor((n.data as AgentNodeData).status)}
        className="!bg-card !border-border/60"
      />
    </ReactFlow>
  )
}
