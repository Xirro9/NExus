// Library search (T5-UI). HistoryView's debounce idiom — one fetch path,
// 400 ms — over the research store; a collection scope set by the collections
// grid re-arms the same debounce. Honest results only: the empty state names
// what the library holds (and what it doesn't), it never fakes coverage.

import { useEffect, useState } from "react"
import { Search } from "lucide-react"

import { useResearch } from "@/store/research"
import { PanelCard } from "@/components/dashboard/PanelCard"

import { inputClass, SkeletonList, StaleChip, StatusChip } from "./researchBits"

export function ResearchSearch({ onOpenDoc }: { onOpenDoc(docId: string): void }) {
  const search = useResearch((s) => s.search)
  const searching = useResearch((s) => s.searching)
  const collection = useResearch((s) => s.collection)
  const runSearch = useResearch((s) => s.runSearch)
  // display name for the scope chip (raw id when status hasn't caught up)
  const collectionName = useResearch((s) =>
    s.collection
      ? (s.status?.collections.find((c) => c.id === s.collection)?.name ?? s.collection)
      : null,
  )

  const [input, setInput] = useState(search?.query ?? "")

  // ONE fetch path: input or scope changes re-arm a 400 ms debounce
  // (HistoryView's cadence). An empty query clears the results — honest.
  useEffect(() => {
    const t = setTimeout(() => {
      void runSearch(input)
    }, 400)
    return () => {
      clearTimeout(t)
    }
  }, [input, collection, runSearch])

  const hits = search?.hits ?? []
  const showSkeleton = searching && hits.length === 0

  return (
    <PanelCard
      title="Library search"
      icon={<Search className="size-3.5 text-primary" aria-hidden />}
      right={
        <span className="flex items-center gap-1.5">
          {collection !== null && (
            <button
              type="button"
              onClick={() => useResearch.getState().setCollection(null)}
              title="Clear the collection scope"
              className="rounded border border-primary/40 px-1 font-mono text-[9px] text-primary transition-colors duration-150 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
            >
              {collectionName} ✕
            </button>
          )}
          {search !== null && (
            <span
              aria-live="polite"
              className="font-mono text-[10px] text-muted-foreground/70"
            >
              {search.hits.length} hit{search.hits.length === 1 ? "" : "s"} ·{" "}
              {search.tookMs} ms
            </span>
          )}
        </span>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          name="research-search"
          autoComplete="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search titles, notes and section text…"
          aria-label="Search the research library"
          className={inputClass}
        />
        {searching && hits.length > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground/70">
            searching…
          </span>
        )}
      </div>

      {showSkeleton ? (
        <SkeletonList rows={4} />
      ) : search === null ? (
        <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">Search the library.</p>
          <p className="mt-1 text-xs text-muted-foreground/80">
            Titles, notes and section text — try a bill number, a standard name,
            or a topic.
          </p>
        </div>
      ) : hits.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            No library hits
            {collection !== null
              ? ` in ${collectionName ?? "this collection"}`
              : ""}{" "}
            — external research may be needed.
          </p>
          <p className="mt-1 text-xs text-muted-foreground/80">
            The library only holds ingested documents; webfetch/websearch can
            reach anything newer.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/40">
          {hits.map((hit) => (
            <li key={`${hit.docId}#${hit.section?.id ?? "doc"}`} className="nexus-row-in">
              <button
                type="button"
                onClick={() => onOpenDoc(hit.docId)}
                className="flex w-full flex-col gap-1 px-2 py-2 text-left transition-colors duration-150 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50"
              >
                <span className="flex w-full items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {hit.title}
                  </span>
                  {hit.section !== null && (
                    <span className="shrink-0 rounded border border-primary/40 px-1 font-mono text-[9px] text-primary">
                      {hit.section.anchor}
                    </span>
                  )}
                  <span className="shrink-0 rounded border border-border/60 px-1 font-mono text-[9px] text-muted-foreground">
                    {hit.version}
                  </span>
                  <StatusChip status={hit.status} />
                  {hit.stale ? (
                    <StaleChip ageDays={hit.ageDays} />
                  ) : (
                    <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70">
                      {hit.ageDays}d
                    </span>
                  )}
                </span>
                {hit.section !== null && (
                  <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                    {hit.section.snippet}
                  </span>
                )}
                <span className="flex w-full items-center gap-1.5 font-mono text-[10px] text-muted-foreground/70">
                  <span>{hit.collection}</span>
                  {hit.publicationDate !== null && (
                    <span>· pub {hit.publicationDate}</span>
                  )}
                  <span className="ml-auto tabular-nums">
                    score {hit.score.toFixed(2)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  )
}
