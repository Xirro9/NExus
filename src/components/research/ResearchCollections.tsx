// Collections grid (T5-UI): the five library collections as compact cards.
// Click scopes the search to that collection (store.collection — ResearchSearch
// re-runs through its debounce); click again clears. Data rides the status
// payload — the engine reports all five collections even when empty, so the
// zeros are honest.

import { Library } from "lucide-react"

import { useResearch } from "@/store/research"
import { PanelCard } from "@/components/dashboard/PanelCard"

import { fmtRelative, useNow } from "./researchFmt"
import { CountChip, EmptyNote } from "./researchBits"

export function ResearchCollections() {
  const status = useResearch((s) => s.status)
  const collection = useResearch((s) => s.collection)
  const setCollection = useResearch((s) => s.setCollection)
  const now = useNow()

  const collections = status?.collections ?? []
  const totalDocs = collections.reduce((sum, c) => sum + c.documents, 0)

  return (
    <PanelCard
      title="Collections"
      icon={<Library className="size-3.5 text-primary" aria-hidden />}
      right={<CountChip n={totalDocs} />}
    >
      {collections.length === 0 ? (
        <EmptyNote label="No collection data — Refresh loads the library status." />
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {collections.map((c) => {
              const active = collection === c.id
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setCollection(active ? null : c.id)}
                    title={
                      active
                        ? "Clear the collection scope"
                        : `Scope the search to ${c.name}`
                    }
                    className={
                      "w-full rounded-lg border px-2.5 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 " +
                      (active
                        ? "border-primary/60 bg-primary/10"
                        : "border-border/60 bg-muted/20 hover:bg-secondary/40")
                    }
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">{c.name}</span>
                      {c.stale > 0 && (
                        <span className="shrink-0 rounded border border-warning/50 px-1 font-mono text-[9px] text-warning">
                          {c.stale} stale
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[10px] leading-snug text-muted-foreground/80">
                      {c.description}
                    </span>
                    <span className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/70">
                      <span className="tabular-nums">
                        {c.documents} doc{c.documents === 1 ? "" : "s"}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="tabular-nums">{c.sections} sec</span>
                      <span className="ml-auto">
                        {c.lastUpdatedAt !== null
                          ? fmtRelative(c.lastUpdatedAt, now)
                          : "—"}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="mt-2 text-[10px] text-muted-foreground/60">
            Click a collection to scope the search; click again to search
            everything.
          </p>
        </>
      )}
    </PanelCard>
  )
}
