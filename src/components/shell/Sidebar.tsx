// Sidebar: brand row, new-session, project filter, session list.
// Store-driven; no props (§8).

import { useMemo } from "react"

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
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-lg font-semibold tracking-tight">
          Nexus
        </span>
        <ConnectionBadge status={status} version={version} />
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => void newSession()}
          className="w-full rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-[var(--glow-primary)] transition-colors hover:opacity-90"
        >
          + New session
        </button>
      </div>

      {/* project filter */}
      <div className="px-3 pb-2">
        <select
          value={activeProjectId ?? ""}
          onChange={(e) =>
            useNexus.setState({
              activeProjectId: e.target.value === "" ? null : e.target.value,
            })
          }
          className="w-full rounded-lg border border-border bg-input px-2 py-1.5 text-xs text-foreground"
          aria-label="Filter sessions by project"
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.canonical}
            </option>
          ))}
        </select>
      </div>

      {/* session list */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Sessions">
        {filtered.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            No sessions yet.
          </p>
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
