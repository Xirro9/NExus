// Open document (T5-UI): metadata table + expandable sections, fetched
// component-locally via the transport (ephemeral view state — the flagged
// design choice; the store stays lean).
//
// The read seam ALWAYS returns section bodies (CLI parity), so the first
// fetch bounds every body to PREVIEW_MAX_CHARS — that keeps the payload small
// on the desktop leg (research.rs caps CLI stdout at 256 KB; a full bill would
// flirt with it — the flagged T3 gap). Expanding a truncated section re-fetches
// just that section at full length (anchor filter, engine ceiling 50k chars).
// Bodies render verbatim: the engine's "[truncated at N chars]" marker passes
// through untouched — honest truncation, never hidden.

import { useEffect, useState, type ReactNode } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ChevronLeft, ChevronRight, ExternalLink, FileText } from "lucide-react"

import { transport } from "@/lib/transport"
import type { ResearchDocumentRecord } from "@/lib/transport/types"
import { useResearch } from "@/store/research"
import { PanelCard } from "@/components/dashboard/PanelCard"

import { fmtTimestamp } from "./researchFmt"
import { SkeletonList, StaleChip, StatusChip } from "./researchBits"

const PREVIEW_MAX_CHARS = 600
const SECTION_MAX_CHARS = 50_000

const truncMarker = (n: number) => `[truncated at ${n} chars]`

type Section = NonNullable<ResearchDocumentRecord["sections"]>[number]

export function ResearchDocDetail({
  docId,
  onBack,
}: {
  docId: string
  onBack(): void
}) {
  const root = useResearch((s) => s.root)
  // The loaded payload carries the request it answered — staleness (doc/root
  // changed before the fetch landed) is DERIVED, not reset synchronously in
  // an effect (oxlint set-state-in-effect). The view also remounts this
  // component per docId (key=), so section state resets naturally.
  const [loaded, setLoaded] = useState<{
    root: string
    docId: string
    doc: ResearchDocumentRecord | null // null = honest not-found
  } | null>(null)
  const [failed, setFailed] = useState<{
    root: string
    docId: string
    message: string
  } | null>(null)
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())
  const [bodies, setBodies] = useState<Record<string, string>>({})
  const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set())
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (root === null) return
    let alive = true
    transport
      .researchDocument(root, docId, { maxChars: PREVIEW_MAX_CHARS })
      .then((d) => {
        if (alive) {
          setLoaded({ root, docId, doc: d })
          setFailed(null)
        }
      })
      .catch((err: unknown) => {
        if (alive)
          setFailed({
            root,
            docId,
            message: err instanceof Error ? err.message : String(err),
          })
      })
    return () => {
      alive = false
    }
  }, [root, docId])

  const fetchFailed =
    failed !== null && failed.root === root && failed.docId === docId
      ? failed.message
      : null
  const fresh =
    loaded !== null && loaded.root === root && loaded.docId === docId
      ? loaded.doc
      : undefined // undefined = loading for THIS doc; null (when fresh) = not-found

  /** Expand/collapse one section; a truncated preview body is re-fetched at
   *  full length through the section anchor filter (exact-anchor pick — the
   *  filter is a substring match, "SEC. 4" would also match "SEC. 40"). */
  const toggleSection = (sec: Section) => {
    if (openIds.has(sec.id)) {
      const next = new Set(openIds)
      next.delete(sec.id)
      setOpenIds(next)
      return
    }
    setOpenIds((prev) => new Set(prev).add(sec.id))
    if (bodies[sec.id] !== undefined) return
    const preview = sec.body
    if (preview === undefined || !preview.endsWith(truncMarker(PREVIEW_MAX_CHARS)))
      return
    if (root === null || loadingIds.has(sec.id)) return
    setLoadingIds((prev) => new Set(prev).add(sec.id))
    transport
      .researchDocument(root, docId, {
        section: sec.anchor,
        maxChars: SECTION_MAX_CHARS,
      })
      .then((res) => {
        const match = res?.sections?.find(
          (s) => s.anchor.toLowerCase() === sec.anchor.toLowerCase(),
        )
        setBodies((prev) => ({ ...prev, [sec.id]: match?.body ?? preview }))
        if (match === undefined) setFailedIds((prev) => new Set(prev).add(sec.id))
      })
      .catch(() => {
        // degrade to the preview body — the failure is surfaced on the row
        setBodies((prev) => ({ ...prev, [sec.id]: preview }))
        setFailedIds((prev) => new Set(prev).add(sec.id))
      })
      .finally(() => {
        setLoadingIds((prev) => {
          const next = new Set(prev)
          next.delete(sec.id)
          return next
        })
      })
  }

  let body: ReactNode
  if (fetchFailed !== null) {
    body = (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <p className="break-words">Document read failed: {fetchFailed}</p>
      </div>
    )
  } else if (fresh === undefined) {
    body = <SkeletonList rows={3} />
  } else if (fresh === null) {
    body = (
      <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">Document not found.</p>
        <p className="mt-1 text-xs text-muted-foreground/80">
          It may have been removed, or the index is stale — Refresh rebuilds it
          from the manifests.
        </p>
      </div>
    )
  } else {
    body = (
      <>
        <div className="mb-3">
          <h3 className="text-sm font-semibold leading-snug">{fresh.title}</h3>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">
            {fresh.collection} · {fresh.docId}
          </p>
        </div>

        <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5">
          <MetaRow label="source">
            <a
              href={fresh.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-primary underline underline-offset-2"
            >
              {fresh.sourceUrl}
              <ExternalLink className="ml-1 inline size-3 align-[-1px]" aria-hidden />
            </a>
          </MetaRow>
          <MetaRow label="published">
            {fresh.publicationDate ?? "—"}
          </MetaRow>
          <MetaRow label="retrieved">{fmtTimestamp(fresh.retrievedAt)}</MetaRow>
          <MetaRow label="verified">
            {fresh.verifiedAt !== null ? fmtTimestamp(fresh.verifiedAt) : "—"}
          </MetaRow>
          <MetaRow label="version">{fresh.version}</MetaRow>
          <MetaRow label="status">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <StatusChip status={fresh.status} />
              {fresh.stale && <StaleChip ageDays={fresh.ageDays} />}
              {!fresh.stale && <span>{fresh.ageDays}d old</span>}
            </span>
          </MetaRow>
          <MetaRow label="revision">r{fresh.revision}</MetaRow>
          <MetaRow label="hash">{fresh.contentHash.slice(0, 8)}</MetaRow>
          <MetaRow label="file">
            <span className="break-all">{fresh.filePath ?? "—"}</span>
          </MetaRow>
        </dl>

        {fresh.notes.length > 0 && (
          <div className="mt-3 rounded-lg border border-border/50 bg-muted/20 p-2.5">
            <h4 className="font-mono text-[9px] tracking-wide text-muted-foreground/70 uppercase">
              Notes
            </h4>
            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
              {fresh.notes}
            </p>
          </div>
        )}

        <h4 className="mt-4 font-mono text-[9px] tracking-wide text-muted-foreground/70 uppercase">
          Sections
          {fresh.sections !== undefined ? ` · ${fresh.sections.length}` : ""}
        </h4>
        {fresh.sections === undefined || fresh.sections.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground/80">
            No sections recorded for this document.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {fresh.sections.map((sec) => (
              <SectionRow
                key={sec.id}
                sec={sec}
                open={openIds.has(sec.id)}
                body={bodies[sec.id] ?? sec.body}
                loading={loadingIds.has(sec.id)}
                failed={failedIds.has(sec.id)}
                reduceMotion={reduceMotion}
                onToggle={() => toggleSection(sec)}
              />
            ))}
          </ul>
        )}
      </>
    )
  }

  return (
    <PanelCard
      title="Document"
      icon={<FileText className="size-3.5 text-primary" aria-hidden />}
      right={
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
        >
          <ChevronLeft className="size-3" aria-hidden />
          Back to results
        </button>
      }
    >
      {body}
    </PanelCard>
  )
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-0.5 font-mono text-[9px] tracking-wide text-muted-foreground/70 uppercase">
        {label}
      </dt>
      <dd className="min-w-0 font-mono text-[11px] text-foreground/90">{children}</dd>
    </>
  )
}

function SectionRow({
  sec,
  open,
  body,
  loading,
  failed,
  reduceMotion,
  onToggle,
}: {
  sec: Section
  open: boolean
  body: string | undefined
  loading: boolean
  failed: boolean
  reduceMotion: boolean | null
  onToggle(): void
}) {
  return (
    <li className="rounded-lg border border-border/50 bg-background/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50"
      >
        <ChevronRight
          className={
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 " +
            (open ? "rotate-90" : "")
          }
          aria-hidden
        />
        <span className="shrink-0 rounded border border-primary/40 px-1 font-mono text-[9px] text-primary">
          {sec.anchor}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs">{sec.heading}</span>
        {loading && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
            loading…
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="section-body"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div className="border-t border-border/40 px-3 py-2">
              {failed && (
                <p className="mb-1.5 text-[10px] text-warning/90">
                  Full body unavailable — showing the {PREVIEW_MAX_CHARS}-char
                  preview.
                </p>
              )}
              <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/90">
                {body ?? "Body not loaded."}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  )
}
