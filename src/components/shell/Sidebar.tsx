// Sidebar: brand row, new-session, project filter, session list.
// Store-driven; no props (§8).

import { useMemo } from "react"
import { Folder, Plus } from "lucide-react"

import { useNexus } from "@/store/nexus"
import { useStatus } from "@/store/selectors"

import { ConnectionBadge } from "./ConnectionBadge"
import { SessionListItem } from "./SessionListItem"

export function Sidebar() {
  const status = useStatus()
  const version = useNexus((s) => s.connection.version)
  const sessionOrder = useNexus((s) => s.sessionOrder)
  const sessions = useNexus((s) => s.sessions)
  const busy = useNexus((s) => s.busy)
  const activeSessionId = useNexus((s) => s.activeSessionId)
  const projects = useNexus((s) => s.projects)
  const activeProjectId = useNexus((s) => s.activeProjectId)
  const newSession = useNexus((s) => s.newSession)

  const filtered = useMemo(() => {
    const ids = activeProjectId
      ? sessionOrder.filter((id) => sessions[id]?.projectID === activeProjectId)
      : sessionOrder
    return ids
      .map((id) => sessions[id])
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
  }, [sessionOrder, sessions, activeProjectId])

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
            Nexus
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

      {/* session list */}
      <div className="flex items-baseline justify-between px-4 pt-1 pb-1.5">
        <h2 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          Sessions
        </h2>
        <span className="font-mono text-[10px] text-muted-foreground/80">
          {filtered.length}
        </span>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Sessions">
        {filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-3 py-6 text-center">
            <p className="text-xs text-muted-foreground">
              {activeProjectId ? "No sessions in this project." : "No sessions yet."}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground/80">
              Create one with “New session”.
            </p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((session) => (
              <SessionListItem
                key={session.id}
                session={session}
                active={session.id === activeSessionId}
                busy={busy[session.id] ?? false}
                onSelect={(id) => void useNexus.getState().setActiveSession(id)}
              />
            ))}
          </ul>
        )}
      </nav>
    </aside>
  )
}
