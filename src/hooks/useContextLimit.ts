// Context-limit resolution chain (SPEC-PHASE2 §4.1 — exact, honest):
//  1. providerID === "llamacpp" && llama /props nCtx → ground truth for the
//     local server (the /api/model catalog limit for llamacpp is stale: 200000
//     vs the real n_ctx 1048576 — verified live, see docs/API-NOTES.md).
//  2. else the model catalog (GET /api/model, limit.context).
//  3. else null → "ctx unknown" — never guess, never fabricate.

import { useMemo } from "react"

import type { SessionInfo } from "@/lib/opencode/types"
import { useModels } from "@/store/selectors"
import { useLlm } from "@/store/telemetry"

export interface CtxLimit {
  limit: number | null
  /** /props data older than 120 s → "stale" chip (§4.1) */
  stale: boolean
  source: "props" | "catalog" | null
}

export function useContextLimit(session: SessionInfo | null): CtxLimit {
  const models = useModels()
  const llm = useLlm()
  return useMemo(() => {
    const model = session?.model
    if (!model) return { limit: null, stale: false, source: null }
    if (model.providerID === "llamacpp" && llm?.model?.nCtx != null) {
      return {
        limit: llm.model.nCtx,
        stale: (llm.propsStaleMs ?? 0) > 120_000,
        source: "props",
      }
    }
    const entry = models.find(
      (m) => m.providerID === model.providerID && m.id === model.id,
    )
    const limit = entry?.limit?.context ?? null
    return { limit, stale: false, source: limit !== null ? "catalog" : null }
  }, [session, models, llm])
}
