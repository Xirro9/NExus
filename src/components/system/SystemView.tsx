// System view (SPEC-PHASE3 §8): extensions status + memory viewer behind a
// small segmented control. Data loads once on first open; SSE invalidation
// events null the cache so the next open refetches — no polling.

import { useEffect, useState } from "react"

import { useNexus } from "@/store/nexus"
import { useWorkspace } from "@/store/workspace"

import { McpPanel } from "./McpPanel"
import { MemoryViewer } from "./MemoryViewer"
import { PluginsPanel } from "./PluginsPanel"
import { SkillsPanel } from "./SkillsPanel"

type Segment = "extensions" | "memory"

export function SystemView() {
  const [segment, setSegment] = useState<Segment>("extensions")
  const skills = useWorkspace((s) => s.skills)
  const plugins = useWorkspace((s) => s.plugins)
  const mcpServers = useWorkspace((s) => s.mcpServers)
  const extensionsStatus = useWorkspace((s) => s.extensionsStatus)
  const loadExtensions = useWorkspace((s) => s.loadExtensions)
  const online = useNexus((s) => s.connection.status === "online")

  useEffect(() => {
    void loadExtensions()
  }, [loadExtensions])

  return (
    <div className="mx-auto flex h-full w-full max-w-[900px] flex-col p-5 pb-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight">System</h1>
        <div
          role="tablist"
          aria-label="System sections"
          className="flex rounded-lg border border-border bg-input/60 p-0.5"
        >
          {(["extensions", "memory"] as const).map((seg) => (
            <button
              key={seg}
              type="button"
              role="tab"
              aria-selected={segment === seg}
              onClick={() => setSegment(seg)}
              className={
                "rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors " +
                (segment === seg
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {seg}
            </button>
          ))}
        </div>
      </div>

      {segment === "extensions" ? (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          {extensionsStatus === "error" && (
            <div className="flex items-center justify-between rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <span>Failed to load extensions{online ? "" : " — offline"}.</span>
              <button
                type="button"
                onClick={() => void loadExtensions(true)}
                className="rounded-md border border-destructive/50 px-2 py-1 hover:bg-destructive/20"
              >
                Retry
              </button>
            </div>
          )}
          <section aria-label="Skills">
            <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Skills
            </h2>
            <SkillsPanel skills={skills} />
          </section>
          <section aria-label="Plugins">
            <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Plugins
            </h2>
            <PluginsPanel plugins={plugins} />
          </section>
          <section aria-label="MCP servers">
            <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              MCP servers
            </h2>
            <McpPanel servers={mcpServers} />
          </section>
        </div>
      ) : (
        <MemoryViewer />
      )}
    </div>
  )
}
