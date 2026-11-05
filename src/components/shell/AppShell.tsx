// App shell: grid [280px sidebar] [1fr main] [260px rail], collapsible rail.
// Mounts the SSE stream, health poll, telemetry poll + bootstrap exactly once.
// The main area switches Chat | Dashboard (MainTabs): ChatPanel stays mounted
// (hidden attribute) so scroll state and the SSE stream are untouched; the
// dashboard mounts lazily on first open and stays mounted (SPEC-PHASE2 §6).

import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { PanelRightClose, PanelRightOpen } from "lucide-react"

import { useEventStream } from "@/hooks/useEventStream"
import { useHealthPoll } from "@/hooks/useHealthPoll"
import { useTelemetryPoll } from "@/hooks/useTelemetryPoll"
import { useNexus } from "@/store/nexus"
import { useStatus } from "@/store/selectors"
import { ChatPanel } from "@/components/chat/ChatPanel"
import { DashboardView } from "@/components/dashboard/DashboardView"
import { PermissionDrawer } from "@/components/permissions/PermissionDrawer"
import { DegradedBanner } from "./DegradedBanner"
import { MainTabs, type MainView } from "./MainTabs"
import { Sidebar } from "./Sidebar"
import { StatusRail } from "@/components/rail/StatusRail"

const RAIL_KEY = "nexus.railCollapsed"
const MAIN_VIEW_KEY = "nexus.mainView"

export function AppShell() {
  useEventStream()
  useHealthPoll()
  useTelemetryPoll()

  const bootstrap = useNexus((s) => s.bootstrap)
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_KEY) === "1",
  )
  const [mainView, setMainView] = useState<MainView>(() =>
    localStorage.getItem(MAIN_VIEW_KEY) === "dashboard" ? "dashboard" : "chat",
  )
  // lazy dashboard mount: only created on first open, then kept alive
  const [dashboardEverOpened, setDashboardEverOpened] = useState(
    () => localStorage.getItem(MAIN_VIEW_KEY) === "dashboard",
  )
  const status = useStatus()
  const toast = useNexus((s) => s.toast)
  const [permissionsOpen, setPermissionsOpen] = useState(false)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const changeView = (v: MainView) => {
    setMainView(v)
    localStorage.setItem(MAIN_VIEW_KEY, v)
    if (v === "dashboard") setDashboardEverOpened(true)
  }
  const dashboardMounted = dashboardEverOpened

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
        <main className="flex min-h-0 min-w-0 flex-col">
          <MainTabs
            view={mainView}
            onChange={changeView}
            onOpenPermissions={() => setPermissionsOpen(true)}
          />
          <div className="min-h-0 flex-1">
            {/* `hidden` (Tailwind preflight: display:none !important) keeps
                ChatPanel alive — scroll + SSE untouched across view switches */}
            <div hidden={mainView !== "chat"} className="h-full">
              <ChatPanel />
            </div>
            {dashboardMounted && <DashboardView visible={mainView === "dashboard"} />}
          </div>
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
            <RailSlot
              onCollapse={toggleRail}
              onOpenPermissions={() => setPermissionsOpen(true)}
            />
          )}
        </aside>
      </div>
      <PermissionDrawer
        open={permissionsOpen}
        onClose={() => setPermissionsOpen(false)}
      />
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

function RailSlot({
  onCollapse,
  onOpenPermissions,
}: {
  onCollapse: () => void
  onOpenPermissions: () => void
}) {
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
      <StatusRail
        session={session}
        onOpenPermissions={onOpenPermissions}
        key={activeSessionId ?? "none"}
      />
    </div>
  )
}
