// Memory viewer (SPEC-PHASE3 §8.3): read-only markdown for the five whitelisted
// memory/workspace files (MEMORY_FILES is the ONLY fs/read path source — no
// user-editable path input). Explicit load/reload per file — no polling, no
// fs.watch (these files change on /remember and session end). No edit
// affordances whatsoever.

import { useEffect, useState } from "react"
import { RotateCw } from "lucide-react"

import { renderMarkdown, useHighlighterReady } from "@/lib/markdown"
import { MEMORY_FILES, useWorkspace } from "@/store/workspace"

function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour12: false })
}

const STATUS_DOT: Record<
  "idle" | "loading" | "ok" | "missing" | "error",
  string
> = {
  idle: "bg-muted-foreground/40",
  loading: "bg-primary nexus-live",
  ok: "bg-success",
  missing: "bg-warning",
  error: "bg-destructive",
}

export function MemoryViewer() {
  const memory = useWorkspace((s) => s.memory)
  const loadMemoryFile = useWorkspace((s) => s.loadMemoryFile)
  // sugar-high loads lazily; re-render once it arrives so fences highlight
  useHighlighterReady()
  const [selected, setSelected] = useState(MEMORY_FILES[0]!.id)

  // load the selected file on first open / switch (if never fetched)
  useEffect(() => {
    if (memory[selected].status === "idle") void loadMemoryFile(selected)
  }, [selected, memory, loadMemoryFile])

  const entry = memory[selected]
  const file = MEMORY_FILES.find((f) => f.id === selected)!

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      {/* file list */}
      <nav
        aria-label="Memory files"
        className="flex w-[220px] shrink-0 flex-col gap-1"
      >
        {MEMORY_FILES.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setSelected(f.id)}
            aria-current={f.id === selected ? "true" : undefined}
            className={
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors " +
              (f.id === selected
                ? "bg-secondary text-secondary-foreground ring-1 ring-border/60"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground")
            }
          >
            <span
              className={"size-1.5 shrink-0 rounded-full " + STATUS_DOT[memory[f.id].status]}
              aria-hidden
            />
            <span className="truncate font-mono">{f.label}</span>
          </button>
        ))}
      </nav>

      {/* rendered pane */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl border border-border/70 bg-card">
        <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-border/60 bg-card/95 px-3 py-2 backdrop-blur">
          <span className="truncate font-mono text-[10px] text-muted-foreground/70" title={file.path}>
            {file.path}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {entry.status === "ok" && entry.fetchedAt && (
              <span className="font-mono text-[10px] text-muted-foreground/70">
                read-only · loaded {fmtClock(entry.fetchedAt)}
              </span>
            )}
            <button
              type="button"
              onClick={() => void loadMemoryFile(selected)}
              disabled={entry.status === "loading"}
              aria-label={`Reload ${file.label}`}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              <RotateCw
                className={"size-3" + (entry.status === "loading" ? " animate-spin" : "")}
                aria-hidden
              />
              Reload
            </button>
          </span>
        </div>
        <div className="p-4">
          {entry.status === "loading" && (
            <div className="space-y-2" aria-hidden>
              <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          )}
          {entry.status === "missing" && (
            <p className="text-xs text-muted-foreground">
              File not present on this machine.
            </p>
          )}
          {entry.status === "error" && (
            <div className="flex items-center gap-3">
              <p className="text-xs text-destructive">
                Failed to read the file.
              </p>
              <button
                type="button"
                onClick={() => void loadMemoryFile(selected)}
                className="rounded-md border border-destructive/50 px-2 py-1 text-[11px] text-destructive hover:bg-destructive/10"
              >
                Retry
              </button>
            </div>
          )}
          {entry.status === "ok" && entry.content !== null && (
            <div
              className="md-body max-w-[72ch]"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.content) }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
