// App shell: grid [280px sidebar] [1fr main] [260px rail], collapsible rail.
// Mounts the SSE stream + bootstrap exactly once.

import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { PanelRightClose, PanelRightOpen } from "lucide-react"

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
        <aside className="hidden min-h-0 border-l border-border/70 lg:block">
          {railCollapsed ? (
            <button
              type="button"
              onClick={toggleRail}
              className="flex h-full w-7 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-secondary/50 hover:text-foreground"
              aria-label="Expand status rail"
            >
              <PanelRightOpen className="size-4" aria-hidden />
            </button>
          ) : (
            <RailSlot onCollapse={toggleRail} />
          )}
        </aside>
      </div>
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.text}
            role="status"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className={
              "fixed bottom-4 left-1/2 z-50 max-w-md -translate-x-1/2 rounded-xl border px-4 py-2.5 text-sm " +
              (toast.kind === "error"
                ? "border-destructive/50 bg-card text-destructive shadow-lg shadow-black/40"
                : "border-border bg-card text-foreground shadow-[var(--glow-primary)]")
            }
          >
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>
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
        className="absolute top-2 right-2 z-10 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-secondary/50 hover:text-foreground"
        aria-label="Collapse status rail"
      >
        <PanelRightClose className="size-3.5" aria-hidden />
      </button>
      <StatusRail session={session} key={activeSessionId ?? "none"} />
    </div>
  )
}
