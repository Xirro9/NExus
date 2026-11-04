// App shell: grid [280px sidebar] [1fr main] [260px rail], collapsible rail.
// Mounts the SSE stream + bootstrap exactly once.

import { useEffect, useState } from "react"

import { useEventStream } from "@/hooks/useEventStream"
import { useHealthPoll } from "@/hooks/useHealthPoll"
import { useNexus } from "@/store/nexus"
import { useStatus } from "@/store/selectors"
import { ChatPanel } from "@/components/chat/ChatPanel"
import { DegradedBanner } from "./DegradedBanner"
import { Sidebar } from "./Sidebar"
import { StatusRail } from "@/components/rail/StatusRail"

const RAIL_KEY = "nexus.railCollapsed"

export function AppShell() {
  useEventStream()
  useHealthPoll()

  const bootstrap = useNexus((s) => s.bootstrap)
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_KEY) === "1",
  )
  const status = useStatus()
  const toast = useNexus((s) => s.toast)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const toggleRail = () => {
    setRailCollapsed((prev) => {
      localStorage.setItem(RAIL_KEY, prev ? "0" : "1")
      return !prev
    })
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {status !== "online" && <DegradedBanner status={status} />}
      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr] lg:grid-cols-[280px_1fr_260px]">
        <Sidebar />
        <main className="min-h-0 min-w-0">
          <ChatPanel />
        </main>
        <aside className="hidden min-h-0 border-l border-border lg:block">
          {railCollapsed ? (
            <button
              type="button"
              onClick={toggleRail}
              className="h-full w-6 text-muted-foreground hover:text-foreground"
              aria-label="Expand status rail"
            >
              ‹
            </button>
          ) : (
            <RailSlot onCollapse={toggleRail} />
          )}
        </aside>
      </div>
      {toast && (
        <div
          role="status"
          className={
            "fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-xl border px-4 py-2 text-sm shadow-[var(--glow-primary)] " +
            (toast.kind === "error"
              ? "border-destructive/50 bg-card text-destructive"
              : "border-border bg-card text-foreground")
          }
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}

function RailSlot({ onCollapse }: { onCollapse: () => void }) {
  const activeSessionId = useNexus((s) => s.activeSessionId)
  const session = useNexus((s) =>
    s.activeSessionId ? (s.sessions[s.activeSessionId] ?? null) : null,
  )
  return (
    <div className="relative h-full">
      <button
        type="button"
        onClick={onCollapse}
        className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
        aria-label="Collapse status rail"
      >
        ›
      </button>
      <StatusRail session={session} key={activeSessionId ?? "none"} />
    </div>
  )
}
