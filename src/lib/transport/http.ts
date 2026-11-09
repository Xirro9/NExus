// Browser transport — plain fetch + EventSource over origin-relative paths.
// Auth arrives via the Vite dev proxy; byte-identical to the pre-Phase-4 path.

import { connectEvents } from "@/lib/opencode/sse"
import { TELEMETRY_SNAPSHOT_PATH, type TelemetrySnapshot } from "@/lib/telemetry/types"

import type {
  CreateDirResult,
  GraphifyDetect,
  GraphifyExecResult,
  GraphifyStatus,
  ResearchCollectionSummary,
  ResearchDocumentRecord,
  ResearchReindexResult,
  ResearchSearchResult,
  ResearchStatus,
  Transport,
  TransportRequestInit,
  TransportResponse,
} from "./types"

/** 4xx/5xx {error} bodies carry the host-side validation message (createDir
 *  idiom) — surface it instead of a bare status line. */
async function errorFrom(res: Response, label: string): Promise<Error> {
  let message = `${label} HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: string }
    if (body.error) message = body.error
  } catch {
    // keep the status-line message
  }
  return new Error(message)
}

async function request(
  path: string,
  init?: TransportRequestInit,
): Promise<TransportResponse> {
  const headers = { ...init?.headers }
  if (init?.body !== undefined && init.body !== null) {
    headers["content-type"] = headers["content-type"] ?? "application/json"
  }
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined && init.body !== null ? { body: init.body } : {}),
    headers,
  })
  return {
    status: res.status,
    ok: res.ok,
    statusText: res.statusText,
    // 204 → "" (client.ts checks status before parsing)
    bodyText: res.status === 204 ? "" : await res.text(),
  }
}

export const httpTransport: Transport = {
  request,
  async telemetrySnapshot(): Promise<TelemetrySnapshot> {
    const res = await fetch(TELEMETRY_SNAPSHOT_PATH, { cache: "no-store" })
    if (!res.ok) throw new Error(`telemetry HTTP ${res.status}`)
    return (await res.json()) as TelemetrySnapshot
  },
  connectEvents,
  async graphifyDetect() {
    const res = await fetch("/graphify/detect", { cache: "no-store" })
    if (!res.ok) throw new Error(`graphify detect HTTP ${res.status}`)
    return (await res.json()) as GraphifyDetect
  },
  async graphifyStatus(cwd) {
    const res = await fetch(
      `/graphify/status?cwd=${encodeURIComponent(cwd)}`,
      { cache: "no-store" },
    )
    if (!res.ok) throw new Error(`graphify status HTTP ${res.status}`)
    return (await res.json()) as GraphifyStatus
  },
  async graphifyExec(cwd, args) {
    const res = await fetch("/graphify/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, args }),
    })
    if (!res.ok) {
      // the middleware returns 4xx with {error} for whitelist rejections
      let message = `graphify exec HTTP ${res.status}`
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) message = body.error
      } catch {
        // keep the status-line message
      }
      throw new Error(message)
    }
    return (await res.json()) as GraphifyExecResult
  },
  async createDir(path) {
    const res = await fetch("/dev/fs/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) {
      // the middleware returns 4xx with {error} for validation rejections
      let message = `fs mkdir HTTP ${res.status}`
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) message = body.error
      } catch {
        // keep the status-line message
      }
      throw new Error(message)
    }
    return (await res.json()) as CreateDirResult
  },
  async researchStatus(root) {
    const qs = root !== null ? `?root=${encodeURIComponent(root)}` : ""
    const res = await fetch(`/research/status${qs}`, { cache: "no-store" })
    if (!res.ok) throw await errorFrom(res, "research status")
    return (await res.json()) as ResearchStatus
  },
  async researchCollections(root) {
    const res = await fetch(`/research/collections?root=${encodeURIComponent(root)}`, {
      cache: "no-store",
    })
    if (!res.ok) throw await errorFrom(res, "research collections")
    return (await res.json()) as ResearchCollectionSummary[]
  },
  async researchSearch(root, q, opts) {
    const params = new URLSearchParams({ root, q })
    if (opts?.collection !== undefined) params.set("collection", opts.collection)
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit))
    if (opts?.scope !== undefined) params.set("scope", opts.scope)
    const res = await fetch(`/research/search?${params.toString()}`, { cache: "no-store" })
    if (!res.ok) throw await errorFrom(res, "research search")
    return (await res.json()) as ResearchSearchResult
  },
  async researchDocument(root, id, opts) {
    const params = new URLSearchParams({ root, id })
    if (opts?.section !== undefined) params.set("section", opts.section)
    if (opts?.maxChars !== undefined) params.set("maxChars", String(opts.maxChars))
    const res = await fetch(`/research/doc?${params.toString()}`, { cache: "no-store" })
    // honest not-found (missing doc OR a section filter that matched nothing)
    if (res.status === 404) return null
    if (!res.ok) throw await errorFrom(res, "research document")
    return (await res.json()) as ResearchDocumentRecord
  },
  async researchReindex(root) {
    const res = await fetch("/research/reindex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    })
    if (!res.ok) throw await errorFrom(res, "research reindex")
    return (await res.json()) as ResearchReindexResult
  },
}
