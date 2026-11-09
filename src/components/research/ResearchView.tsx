// Research view (T5-UI): the local research library surface. Status strip →
// search + results (or the open document) → collections grid → researcher
// activity. Library data comes from the research store (transport-backed,
// honest errors — a transport failure is a banner, never a fake-empty
// library); researcher sessions come from the nexus store. Lazy-mounted by
// the shell; this view imports nothing from other views' internals beyond the
// shared PanelCard pattern and the delegation correlation helper the T5 brief
// pins.

import { useEffect, useState } from "react"
import { FlaskConical, RefreshCw } from "lucide-react"

import { fmtBytes } from "@/lib/format"
import type { ResearchStatus } from "@/lib/transport/types"
import { useResearch } from "@/store/research"

import { ResearchCollections } from "./ResearchCollections"
import { ResearchDocDetail } from "./ResearchDocDetail"
import { ResearchSearch } from "./ResearchSearch"
import { ResearcherActivity } from "./ResearcherActivity"
import { fmtRelative, fmtTimestamp, useNow } from "./researchFmt"

export function ResearchView({
  onOpenSession,
}: {
  onOpenSession?: (sessionID: string) => void
}) {
  const init = useResearch((s) => s.init)
  const status = useResearch((s) => s.status)
  const root = useResearch((s) => s.root)
  const initializing = useResearch((s) => s.initializing)
  const reindexing = useResearch((s) => s.reindexing)
  const reindex = useResearch((s) => s.reindex)
  const error = useResearch((s) => s.error)
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)

  // one status load per store lifetime (init self-guards); Refresh/reindex
  // re-fetch on demand
  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1360px] p-5 pb-10">
        <div className="mb-4 flex items-center gap-3 px-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <FlaskConical className="size-4 text-primary" aria-hidden />
            Research
          </h1>
          <span className="font-mono text-[10px] tracking-wider text-muted-foreground/80 uppercase">
            local library
          </span>
          <button
            type="button"
            onClick={() => void reindex()}
            disabled={reindexing || initializing || root === null}
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors duration-150 hover:bg-secondary/50 hover:text-foreground disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            aria-label="Rebuild the research index (reindex)"
            title="Refresh — rebuild the derived index from the manifests"
          >
            <RefreshCw
              className={"size-3.5" + (reindexing ? " animate-spin" : "")}
              aria-hidden
            />
          </button>
        </div>

        {/* banner only once a library is connected — the unset-root state
            carries its error inline next to the fix (the path field) */}
        {error !== null && status !== null && (
          <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <p className="min-w-0 break-words">{error}</p>
          </div>
        )}

        {status === null ? (
          initializing ? (
            <div className="rounded-xl border border-border/70 bg-card p-4" aria-hidden>
              <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
              <div className="mt-2.5 h-2.5 w-1/2 animate-pulse rounded bg-muted/70" />
            </div>
          ) : (
            <UnsetRootState />
          )
        ) : (
          <StatusStrip status={status} root={root ?? status.root} />
        )}

        {root !== null && (
          <div className="mt-5 grid grid-cols-1 items-start gap-5 xl:grid-cols-2 [&>*]:h-auto">
            <div className="xl:col-span-2">
              {selectedDocId !== null ? (
                <ResearchDocDetail
                  key={selectedDocId}
                  docId={selectedDocId}
                  onBack={() => setSelectedDocId(null)}
                />
              ) : (
                <ResearchSearch onOpenDoc={setSelectedDocId} />
              )}
            </div>
            <ResearchCollections />
            <ResearcherActivity onOpenSession={onOpenSession} />
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Cell({
  label,
  value,
  warn,
}: {
  label: string
  value: string
  warn?: boolean
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5">
      <dt className="font-mono text-[9px] tracking-wide text-muted-foreground/70 uppercase">
        {label}
      </dt>
      <dd className={"font-mono text-sm tabular-nums" + (warn ? " text-warning" : "")}>
        {value}
      </dd>
    </div>
  )
}

/** Library root + totals — the glance line answering "what does the library
 *  hold and how fresh is it". */
function StatusStrip({ status, root }: { status: ResearchStatus; root: string }) {
  const now = useNow()
  const totalDocs = status.collections.reduce((sum, c) => sum + c.documents, 0)
  const totalSections = status.collections.reduce((sum, c) => sum + c.sections, 0)
  return (
    <div className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 font-mono text-xs text-foreground/90">
          <span className="text-muted-foreground/70">library · </span>
          <span className="break-all">{root}</span>
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
          schema v{status.schemaVersion} · engine {status.engineVersion}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Cell label="documents" value={String(totalDocs)} />
        <Cell label="sections" value={String(totalSections)} />
        <Cell label="stale" value={String(status.staleCount)} warn={status.staleCount > 0} />
        <Cell
          label="last reindex"
          value={
            status.lastReindexAt !== null
              ? fmtRelative(status.lastReindexAt, now)
              : "never"
          }
        />
      </dl>
      <p className="mt-2.5 text-[10px] text-muted-foreground/60">
        {status.dbExists
          ? `index ${fmtBytes(status.dbSizeBytes ?? 0)} · rebuilt ${
              status.lastReindexAt !== null ? fmtTimestamp(status.lastReindexAt) : "never"
            }`
          : "no derived index yet — Refresh builds it from the manifests"}
        {" · "}
        {status.collections.length} collections
      </p>
    </div>
  )
}

/** Honest empty state for an unset/failed root: an editable library path
 *  calling setRoot (dev resolves the checkout automatically; the desktop leg
 *  needs an explicit path or RESEARCH_LIBRARY_ROOT — an error here says so). */
function UnsetRootState() {
  const setRoot = useResearch((s) => s.setRoot)
  const error = useResearch((s) => s.error)
  const root = useResearch((s) => s.root)
  const initializing = useResearch((s) => s.initializing)
  const [path, setPath] = useState(root ?? "")

  return (
    <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
      <p className="text-sm text-muted-foreground">No research library connected.</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground/80">
        Point Jerry at the folder that contains research-library/. In dev the
        checkout root is found automatically; on the desktop an explicit path
        (or RESEARCH_LIBRARY_ROOT) is required.
      </p>
      <form
        className="mx-auto mt-4 flex max-w-md items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void setRoot(path)
        }}
      >
        <input
          type="text"
          name="library-path"
          autoComplete="off"
          spellCheck={false}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/absolute/path/to/checkout"
          aria-label="Library path"
          className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-input/60 px-3 text-sm transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60"
        />
        <button
          type="submit"
          disabled={initializing || path.trim().length === 0}
          className="h-9 shrink-0 rounded-lg border border-border px-3 text-xs font-medium transition-colors duration-150 hover:bg-secondary/50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
        >
          {initializing ? "Checking…" : "Connect"}
        </button>
      </form>
      {error !== null && (
        <p className="mx-auto mt-2 max-w-md break-words text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
