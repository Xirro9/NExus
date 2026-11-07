// Sidebar: brand row, destination nav (VNEXT Phase E2: Workspace/Operations/
// System groups), new-session, project filter, session list with children
// grouped under their parent roots (SPEC-PHASE3 §9.1). Store-driven.
//
// Destination nav switches the MainView via AppShell's changeView callback —
// MainTabs stays the fine-grained switcher; the sidebar is the map.
//
// Grouping rules: children (parentID set) whose parent IS loaded nest under
// it (collapsed by default); children whose parent is outside the 50-session
// window render at top level with an agent chip.

import { useMemo, useState, type ReactNode } from "react"
import {
  Activity,
  Cpu,
  Folder,
  FolderOpen,
  MessageSquare,
  Network,
  Plus,
  Settings,
} from "lucide-react"

import { useNexus } from "@/store/nexus"
import { useStatus } from "@/store/selectors"
import { useWorkspace } from "@/store/workspace"
import type { SessionInfo } from "@/lib/opencode/types"
import { useSessionActions } from "@/components/agents/sessionActions"

import { ConnectionBadge } from "./ConnectionBadge"
import { ModelSelect } from "./ModelSelect"
import { SessionListItem } from "./SessionListItem"
import type { MainView } from "./MainTabs"

export function Sidebar({
  onInspect,
  view,
  onNavigate,
}: {
  /** Inspect Agent (P0 context menu) → Agents tab with the node selected. */
  onInspect?(id: string): void
  /** current main view — drives the nav active state */
  view?: MainView
  /** switch the main view (AppShell's changeView) */
  onNavigate?(v: MainView): void
}) {
  const status = useStatus()
  const version = useNexus((s) => s.connection.version)
  const sessionOrder = useNexus((s) => s.sessionOrder)
  const sessions = useNexus((s) => s.sessions)
  const busy = useNexus((s) => s.busy)
  const activeSessionId = useNexus((s) => s.activeSessionId)
  const projects = useNexus((s) => s.projects)
  const activeProjectId = useNexus((s) => s.activeProjectId)
  const newSession = useNexus((s) => s.newSession)
  // any live execution → quiet pulse on the Activity destination (cyan=live).
  // Same running signal the Activity view uses: Jerry's busy map OR the
  // server-truth active map (busy alone misses server-side running sessions).
  const activeMap = useWorkspace((s) => s.activeMap)
  const anyRunning =
    Object.values(busy).some(Boolean) || Object.keys(activeMap ?? {}).length > 0
  // expanded parent ids (collapsed by default, §9.1)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  // shared P0 session-control menu (right-click / kebab on rows)
  const actions = useSessionActions({
    onOpenSession: (id) => void useNexus.getState().setActiveSession(id),
    onInspect,
  })
  const openRowMenu = actions.openMenu

  const { roots, orphans, childrenOf } = useMemo(() => {
    const ids = activeProjectId
      ? sessionOrder.filter((id) => sessions[id]?.projectID === activeProjectId)
      : sessionOrder
    const list = ids
      .map((id) => sessions[id])
      .filter((s): s is SessionInfo => Boolean(s))
    const inList = new Set(list.map((s) => s.id))
    const roots = list.filter(
      (s) => !s.parentID || !inList.has(s.parentID),
    )
    const childrenOf = new Map<string, SessionInfo[]>()
    for (const s of list) {
      if (s.parentID && inList.has(s.parentID)) {
        const arr = childrenOf.get(s.parentID) ?? []
        arr.push(s)
        childrenOf.set(s.parentID, arr)
      }
    }
    // children whose parent is not loaded render at top level with agent chip
    const orphans = list.filter(
      (s) => s.parentID && !inList.has(s.parentID),
    )
    return { roots, orphans, childrenOf }
  }, [sessionOrder, sessions, activeProjectId])

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
      {/* brand row */}
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-3">
        <span className="flex items-center gap-2.5">
          <span
            className="size-2 rounded-full bg-primary shadow-[var(--glow-primary)]"
            aria-hidden
          />
          <span className="text-[17px] leading-none font-semibold tracking-tight">
            Jerry
          </span>
        </span>
        <ConnectionBadge status={status} version={version} />
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={() => void newSession()}
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground shadow-[var(--glow-primary)] transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
        >
          <Plus className="size-4" aria-hidden />
          New session
        </button>
      </div>

      {/* destination nav (VNEXT Phase E2): primary places, grouped. Icons
          match the surfaces they open; active treatment mirrors the session
          rows (bg-secondary + hairline ring). */}
      <nav aria-label="Destinations" className="shrink-0 px-2 pb-1">
        <NavGroup label="Workspace">
          <NavItem
            icon={FolderOpen}
            label="Projects"
            active={view === "projects"}
            onClick={() => onNavigate?.("projects")}
          />
          <NavItem
            icon={MessageSquare}
            label="Sessions"
            active={view === "chat"}
            onClick={() => onNavigate?.("chat")}
          />
        </NavGroup>
        <NavGroup label="Operations">
          <NavItem
            icon={Network}
            label="Agents"
            active={view === "agents"}
            onClick={() => onNavigate?.("agents")}
          />
          <NavItem
            icon={Activity}
            label="Activity"
            active={view === "activity"}
            onClick={() => onNavigate?.("activity")}
            trailing={
              anyRunning ? (
                <span
                  className="nexus-dot-live size-1.5 rounded-full bg-primary shadow-[var(--glow-primary)]"
                  aria-hidden
                />
              ) : undefined
            }
          />
        </NavGroup>
        <NavGroup label="System">
          <NavItem
            icon={Cpu}
            label="System"
            active={view === "system"}
            onClick={() => onNavigate?.("system")}
          />
          <NavItem
            icon={Settings}
            label="Settings"
            active={view === "settings"}
            onClick={() => onNavigate?.("settings")}
          />
        </NavGroup>
      </nav>

      {/* project filter */}
      <div className="px-3 pb-3">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-input/60 px-2.5 py-1.5 transition-colors hover:border-muted-foreground/30">
          <Folder
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <select
            value={activeProjectId ?? ""}
            onChange={(e) =>
              useNexus.setState({
                activeProjectId: e.target.value === "" ? null : e.target.value,
              })
            }
            className="w-full cursor-pointer truncate bg-transparent text-xs text-foreground"
            aria-label="Filter sessions by project"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.canonical}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* current LLM + per-session model switch */}
      <ModelSelect />

      {/* session list */}
      <div className="flex items-baseline justify-between px-4 pt-1 pb-1.5">
        <h2 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          Sessions
        </h2>
        <span className="font-mono text-[10px] text-muted-foreground/80">
          {roots.length + orphans.length}
        </span>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Sessions">
        {roots.length + orphans.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-3 py-6 text-center">
            <p className="text-xs text-muted-foreground">
              {activeProjectId
                ? "No sessions in this project."
                : "No sessions yet — start a new chat with Jerry."}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground/80">
              Create one with “New session”.
            </p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {roots.map((session) => {
              const children = childrenOf.get(session.id) ?? []
              return (
                <li key={session.id}>
                  <SessionListItem
                    session={session}
                    active={session.id === activeSessionId}
                    busy={busy[session.id] ?? false}
                    onSelect={(id) =>
                      void useNexus.getState().setActiveSession(id)
                    }
                    childCount={children.length}
                    expanded={expanded.has(session.id)}
                    onToggleChildren={
                      children.length > 0
                        ? () => toggleExpanded(session.id)
                        : undefined
                    }
                    onContextMenu={(e) => openRowMenu(e, session.id)}
                    onActionsClick={(e) => openRowMenu(e, session.id)}
                  />
                  {children.length > 0 && expanded.has(session.id) && (
                    <ul className="ml-5 space-y-0.5 border-l border-border/50 pl-2">
                      {children.map((child) => (
                        <li key={child.id}>
                          <SessionListItem
                            session={child}
                            active={child.id === activeSessionId}
                            busy={busy[child.id] ?? false}
                            onSelect={(id) =>
                              void useNexus.getState().setActiveSession(id)
                            }
                            child={{ agent: child.agent }}
                            onContextMenu={(e) => openRowMenu(e, child.id)}
                            onActionsClick={(e) => openRowMenu(e, child.id)}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
            {orphans.map((session) => (
              <li key={session.id}>
                <SessionListItem
                  session={session}
                  active={session.id === activeSessionId}
                  busy={busy[session.id] ?? false}
                  onSelect={(id) => void useNexus.getState().setActiveSession(id)}
                  child={{ agent: session.agent }}
                  onContextMenu={(e) => openRowMenu(e, session.id)}
                  onActionsClick={(e) => openRowMenu(e, session.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>
      {actions.overlays}
    </aside>
  )
}

/** Grouped destinations — same label voice as the "Sessions" list header. */
function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pb-1.5 pt-2 first:pt-0.5">
      <h2 className="px-2 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </h2>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  )
}

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  trailing,
}: {
  icon: (props: { className?: string; "aria-hidden"?: boolean }) => ReactNode
  label: string
  active: boolean
  onClick(): void
  /** optional right-edge slot (live dot, count…) */
  trailing?: ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={
          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50 " +
          (active
            ? "bg-secondary font-medium text-secondary-foreground ring-1 ring-border/60"
            : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground")
        }
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing}
      </button>
    </li>
  )
}
