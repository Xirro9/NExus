// Session history browser (SPEC-PHASE3 §6): server-side search/filter over
// GET /api/session (never client-side filtering over a truncated window).
// Debounced 400 ms search, project filter, archived toggle, cursor pagination.
// Row click opens the session in Chat (no destructive ops — §13).

import { useEffect, useRef, useState } from "react"

import { useNexus } from "@/store/nexus"
import {
  useHistoryResults,
  useWorkspace,
} from "@/store/workspace"

import { HistoryCard } from "./HistoryCard"

export function HistoryView({
  onOpenSession,
}: {
  onOpenSession(id: string): void
}) {
  const projects = useNexus((s) => s.projects)
  const historyQuery = useWorkspace((s) => s.historyQuery)
  const historyProjectId = useWorkspace((s) => s.historyProjectId)
  const historyArchived = useWorkspace((s) => s.historyArchived)
  const historyCursor = useWorkspace((s) => s.historyCursor)
  const historyLoading = useWorkspace((s) => s.historyLoading)
  const historyError = useWorkspace((s) => s.historyError)
  const searchHistory = useWorkspace((s) => s.searchHistory)
  const loadMoreHistory = useWorkspace((s) => s.loadMoreHistory)
  const results = useHistoryResults()

  // local input + 400 ms debounce → searchHistory. The debounce effect is the
  // ONLY fetcher on mount/input (single GET, review fix 2); the filter effect
  // skips its first run to avoid double-fetching.
  const [input, setInput] = useState(historyQuery)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      void searchHistory({ query: input })
    }, 400)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [input, searchHistory])
  // refetch when filters change (not on mount — the debounce effect covers it)
  const filtersMounted = useRef(false)
  useEffect(() => {
    if (!filtersMounted.current) {
      filtersMounted.current = true
      return
    }
    void searchHistory()
  }, [historyProjectId, historyArchived, searchHistory])

  return (
    <div className="mx-auto h-full w-full max-w-[900px] overflow-y-auto p-5 pb-10">
      <h1 className="mb-4 text-lg font-semibold tracking-tight">
        Session history
      </h1>

      {/* toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search session titles…"
          aria-label="Search session titles"
          className="h-9 min-w-56 flex-1 rounded-lg border border-border bg-input/60 px-3 text-sm outline-none placeholder:text-muted-foreground/70"
        />
        <select
          value={historyProjectId ?? ""}
          onChange={(e) =>
            void searchHistory({
              projectId: e.target.value === "" ? null : e.target.value,
            })
          }
          aria-label="Filter by project"
          className="h-9 max-w-56 cursor-pointer truncate rounded-lg border border-border bg-input/60 px-2 text-xs"
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.canonical}
            </option>
          ))}
        </select>
        <label className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-input/60 px-3 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={historyArchived}
            onChange={(e) =>
              void searchHistory({ archived: e.target.checked })
            }
            className="accent-[var(--primary)]"
          />
          Archived
        </label>
        <span className="font-mono text-[11px] text-muted-foreground/80">
          {results.length}
          {historyCursor?.next ? "+" : ""} sessions
        </span>
      </div>

      {historyError && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>History query failed: {historyError}</span>
          <button
            type="button"
            onClick={() => void searchHistory()}
            className="rounded-md border border-destructive/50 px-2 py-1 hover:bg-destructive/20"
          >
            Retry
          </button>
        </div>
      )}

      {/* results */}
      {results.length === 0 && !historyLoading && !historyError ? (
        <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">No sessions match.</p>
          <p className="mt-1 text-xs text-muted-foreground/80">
            Adjust the search or filters above.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {results.map((session) => (
            <li key={session.id}>
              <HistoryCard
                session={session}
                onOpen={onOpenSession}
              />
            </li>
          ))}
        </ul>
      )}

      {historyCursor?.next && (
        <div className="mt-4 text-center">
          <button
            type="button"
            disabled={historyLoading}
            onClick={() => void loadMoreHistory()}
            className="h-9 rounded-lg border border-border px-4 text-xs font-medium transition-colors hover:bg-secondary/50 disabled:opacity-50"
          >
            {historyLoading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  )
}
