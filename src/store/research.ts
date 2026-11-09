// Research library store (T5-UI scaffold — the developer pass finalizes/owns
// this file; the T5 brief pinned the contract it implements).
//
// Contract: root (localStorage "nexus.researchRoot.v1"), status/search data,
// an honest error surface, and init/setRoot/runSearch/reindex. A transport
// failure lands in `error` — never a fake-empty library.
//
// Design decisions beyond the bare contract (flagged to the coordinator):
//  - NO selectDoc/doc state: the document detail fetches component-locally
//    via the transport (ephemeral view state — see ResearchDocDetail).
//  - `collection` scopes runSearch to one collection (the collections-grid
//    filter); ResearchSearch re-runs through its debounce when it changes.
//  - `initializing` covers the first status load AND setRoot's path check so
//    the unset-root form gets one honest busy flag.

import { create } from "zustand"

import { transport } from "@/lib/transport"
import type {
  ResearchCollectionSummary,
  ResearchSearchHit,
  ResearchStatus,
} from "@/lib/transport/types"

type ResearchCollectionId = ResearchCollectionSummary["id"]

const ROOT_STORAGE_KEY = "nexus.researchRoot.v1"

export interface ResearchSearchState {
  query: string
  hits: ResearchSearchHit[]
  tookMs: number
  at: number
}

export interface ResearchState {
  root: string | null
  status: ResearchStatus | null
  search: ResearchSearchState | null
  /** Collection scope for runSearch (collections grid); null = all. */
  collection: ResearchCollectionId | null
  searching: boolean
  reindexing: boolean
  /** First status load AND setRoot's path check — one honest busy flag. */
  initializing: boolean
  error: string | null
  init(): Promise<void>
  setRoot(root: string): Promise<void>
  setCollection(id: ResearchCollectionId | null): void
  runSearch(q: string): Promise<void>
  reindex(): Promise<void>
}

function loadStoredRoot(): string | null {
  try {
    return localStorage.getItem(ROOT_STORAGE_KEY)
  } catch {
    return null
  }
}

function persistRoot(root: string): void {
  try {
    localStorage.setItem(ROOT_STORAGE_KEY, root)
  } catch {
    // quota/private-mode — the path degrades to session-scoped
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Monotonic search sequence — only the latest request may land (a slow
 *  response for an earlier query must never overwrite newer results). */
let searchSeq = 0

export const useResearch = create<ResearchState>()((set, get) => ({
  root: null,
  status: null,
  search: null,
  collection: null,
  searching: false,
  reindexing: false,
  initializing: false,
  error: null,

  async init() {
    if (get().initializing || get().status !== null) return
    set({ initializing: true })
    const stored = loadStoredRoot()
    try {
      // root=null lets the host resolve it (browser: engine walk-up from cwd;
      // desktop: RESEARCH_LIBRARY_ROOT — an honest error when unset)
      const status = await transport.researchStatus(stored)
      if (stored === null) persistRoot(status.root) // seed the stored path from the payload
      set({ root: status.root, status, error: null })
    } catch (err) {
      // keep whatever was stored so the recovery field can prefill
      set({ root: stored, error: errorMessage(err) })
    } finally {
      set({ initializing: false })
    }
  },

  async setRoot(root) {
    const trimmed = root.trim()
    if (trimmed.length === 0) {
      set({
        error: "Library path is empty — pick the folder that contains research-library/",
      })
      return
    }
    if (get().initializing) return
    set({ initializing: true })
    try {
      // persist only on success — a bad path must not stick
      const status = await transport.researchStatus(trimmed)
      persistRoot(status.root)
      set({ root: status.root, status, error: null, search: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    } finally {
      set({ initializing: false })
    }
  },

  setCollection(id) {
    set({ collection: id })
  },

  async runSearch(q) {
    const trimmed = q.trim()
    if (trimmed.length === 0) {
      // an empty query clears the result set — honest, not a stale window
      set({ search: null, searching: false })
      return
    }
    const root = get().root
    if (root === null) {
      set({ error: "No library connected — set a library path first" })
      return
    }
    const seq = ++searchSeq
    set({ searching: true })
    try {
      const collection = get().collection
      const res = await transport.researchSearch(root, trimmed, {
        ...(collection !== null ? { collection } : {}),
      })
      if (seq !== searchSeq) return
      set({
        search: { query: res.q, hits: res.hits, tookMs: res.tookMs, at: Date.now() },
        searching: false,
        error: null,
      })
    } catch (err) {
      if (seq !== searchSeq) return
      set({ searching: false, error: errorMessage(err) })
    }
  },

  async reindex() {
    const root = get().root
    if (root === null || get().reindexing) return
    set({ reindexing: true, error: null })
    try {
      const result = await transport.researchReindex(root)
      // counts + lastReindexAt live on status — refresh it while we're here
      const status = await transport.researchStatus(root)
      set({
        status,
        reindexing: false,
        // skipped manifests are not a failure (skip isolation is by design)
        // but hiding them would be dishonest — surface the first with context
        ...(result.skipped.length > 0
          ? {
              error:
                `Reindex finished with ${result.skipped.length} skipped manifest` +
                `${result.skipped.length === 1 ? "" : "s"} — ${result.skipped[0]!.manifest}: ` +
                result.skipped[0]!.error,
            }
          : {}),
      })
    } catch (err) {
      set({ reindexing: false, error: errorMessage(err) })
    }
  },
}))
