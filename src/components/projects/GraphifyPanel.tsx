// Graphify panel (docs/NOTES-SESSIONS-GRAPHIFY.md): per-project code-graph
// status, manual refresh, and official-CLI queries. OPTIONAL by design —
// Jerry never requires Graphify for coding. Every command goes through the
// transport seam's whitelisted executor (Rust command / dev middleware) and
// runs as a separate OS process: nothing here blocks OpenCode execution.
//
// Honesty rules: counts/mtime come from graph.json (authoritative stat); the
// staleness hint is phrased as "source activity since" because v2.2.5 emits
// no filesystem.changed events — the exact check is `graphify update .`
// itself (hash-based). Failure text comes from the CLI's exit contract.

import { useEffect, useRef, useState } from "react"
import { Network, RefreshCw, X } from "lucide-react"

import { GRAPHIFY_INSTALL_HINT, deriveStaleness } from "@/lib/graphify"
import { useNexus } from "@/store/nexus"
import { useWorkspace } from "@/store/workspace"
import type { GraphQueryKind } from "@/store/workspace"

function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "—"
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const QUERY_KINDS: { value: GraphQueryKind; label: string; placeholder: string }[] = [
  {
    value: "query",
    label: "Ask",
    placeholder: "e.g. where is session state managed?",
  },
  { value: "path", label: "Path", placeholder: "SymbolA SymbolB" },
  { value: "explain", label: "Explain", placeholder: "symbol name" },
]

type QueryResult = { ok: boolean; output: string; note: string | null }

export function GraphifyPanel({
  projectID,
  cwd,
}: {
  projectID: string
  cwd: string
}) {
  const entry = useWorkspace((s) => s.graphify[projectID] ?? null)
  const graphDirtyAt = useWorkspace((s) => s.graphDirty[projectID])
  const sessions = useNexus((s) => s.sessions)
  const checkGraphStatus = useWorkspace((s) => s.checkGraphStatus)
  const refreshGraph = useWorkspace((s) => s.refreshGraph)
  const runGraphQuery = useWorkspace((s) => s.runGraphQuery)

  const [feedback, setFeedback] = useState<string | null>(null)
  const [kind, setKind] = useState<GraphQueryKind>("query")
  const [input, setInput] = useState("")
  const [queryRunning, setQueryRunning] = useState(false)
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null)

  // Status check on first mount (panel only exists while the card is open).
  const checked = useRef(false)
  useEffect(() => {
    if (checked.current) return
    checked.current = true
    void checkGraphStatus(projectID, cwd)
  }, [projectID, cwd, checkGraphStatus])

  const busy = entry === null || entry.status === "checking" || entry.status === "updating"
  const cli = useWorkspace((s) => s.graphifyCli)
  const unavailable =
    entry?.status === "unavailable" || (cli !== null && !cli.available)
  const staleness = deriveStaleness(entry?.mtimeMs ?? null, sessions, projectID)
  const stale = entry?.status === "ready" && (graphDirtyAt !== undefined || staleness.stale)

  const refresh = (skipIfClean: boolean) => {
    setFeedback(null)
    void refreshGraph(projectID, cwd, skipIfClean).then((r) => {
      if (r === "ok") {
        const ms = useWorkspace.getState().graphify[projectID]?.lastDurationMs
        setFeedback(
          ms !== null && ms !== undefined
            ? `Graph updated in ${(ms / 1000).toFixed(1)}s.`
            : "Graph updated.",
        )
      } else if (r === "skipped") {
        setFeedback(
          "Already up to date — no source changes observed since the last build, nothing ran.",
        )
      }
      // "error" / "unavailable" render through entry.error / the hint below.
    })
  }

  const runQuery = () => {
    setQueryRunning(true)
    setQueryResult(null)
    runGraphQuery(cwd, kind, input)
      .then(setQueryResult)
      .finally(() => setQueryRunning(false))
  }

  const placeholder = QUERY_KINDS.find((k) => k.value === kind)?.placeholder ?? ""

  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-background/40 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          <Network className="size-3" aria-hidden />
          Code graph
        </h4>
        {entry?.status === "ready" && (
          <button
            type="button"
            onClick={() => refresh(true)}
            disabled={busy}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw
              className={"size-3" + (busy ? " animate-spin" : "")}
              aria-hidden
            />
            Refresh graph
          </button>
        )}
      </div>

      {/* status line */}
      {entry === null || entry.status === "checking" ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <RefreshCw className="size-3 animate-spin" aria-hidden />
          Checking graph…
        </p>
      ) : entry.status === "updating" ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <RefreshCw className="size-3 animate-spin" aria-hidden />
          Updating graph…
        </p>
      ) : entry.status === "ready" ? (
        <>
          <p className="font-mono text-[11px] text-foreground/90">
            {entry.nodeCount ?? "?"} nodes · {entry.edgeCount ?? "?"} links
            {entry.graphifyVersion !== null && (
              <span className="text-muted-foreground/70"> · graphify {entry.graphifyVersion}</span>
            )}
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">
            built {relativeTime(entry.mtimeMs)}
            {entry.lastDurationMs !== null && entry.lastDurationMs !== undefined
              ? ` · last update ${(entry.lastDurationMs / 1000).toFixed(1)}s`
              : ""}
          </p>
          {stale && (
            <p className="mt-1 flex items-center gap-1 text-[10px] text-warning">
              <span className="inline-block size-1.5 rounded-full bg-warning" aria-hidden />
              Source activity since the build — the graph may be stale.
            </p>
          )}
        </>
      ) : entry.status === "missing" ? (
        <>
          <p className="text-[11px] text-muted-foreground/80">
            No graph yet — build one to query this codebase.
          </p>
          <button
            type="button"
            onClick={() => refresh(false)}
            disabled={busy}
            className="mt-1.5 flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-foreground/90 transition-colors hover:text-foreground disabled:opacity-50"
          >
            <Network className="size-3" aria-hidden />
            Build graph
          </button>
        </>
      ) : entry.status === "error" ? (
        <p className="text-[11px] text-destructive">
          {entry.error ?? "Graphify failed."}
        </p>
      ) : entry.status === "unavailable" || unavailable ? (
        <p className="text-[11px] text-muted-foreground/80">
          Graphify CLI not found on this machine. Optional — install with{" "}
          <code className="rounded bg-muted px-1 font-mono text-[10px]">
            {GRAPHIFY_INSTALL_HINT}
          </code>{" "}
          (deterministic, no LLM, no API key).
        </p>
      ) : null}

      {feedback !== null && (
        <p className="mt-1 text-[10px] text-success">{feedback}</p>
      )}

      {/* hubs (informational, from the official CLI's god-nodes) */}
      {entry?.status === "ready" && entry.hubs !== null && entry.hubs.length > 0 && (
        <p className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/80" title={entry.hubs.map((h) => `${h.label} (${h.degree})`).join(" · ")}>
          <span className="font-sans text-[9px] tracking-wider uppercase">hubs</span>{" "}
          {entry.hubs.map((h) => `${h.label} (${h.degree})`).join(" · ")}
        </p>
      )}

      {/* queries — only meaningful with a graph */}
      {entry?.status === "ready" && (
        <div className="mt-2 border-t border-border/50 pt-2">
          <div className="flex items-center gap-1.5">
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as GraphQueryKind)
                setQueryResult(null)
              }}
              aria-label="Graphify query mode"
              className="h-7 shrink-0 cursor-pointer rounded-md border border-border bg-input/60 px-1.5 font-mono text-[10px] text-foreground"
            >
              {QUERY_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !queryRunning && input.trim() !== "") runQuery()
              }}
              placeholder={placeholder}
              aria-label="Graphify query input"
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-input/60 px-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/60"
            />
            <button
              type="button"
              onClick={runQuery}
              disabled={queryRunning || input.trim() === ""}
              className="h-7 shrink-0 rounded-md border border-border px-2 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {queryRunning ? "…" : "Run"}
            </button>
          </div>
          {queryResult !== null && (
            <div className="mt-1.5">
              <div className="flex items-center justify-between">
                {queryResult.note !== null ? (
                  <p className="text-[10px] text-warning">{queryResult.note}</p>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => setQueryResult(null)}
                  aria-label="Clear query result"
                  className="text-muted-foreground/70 transition-colors hover:text-foreground"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </div>
              {queryResult.output !== "" && (
                <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border/50 bg-muted/30 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-foreground/90">
                  {queryResult.output}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
