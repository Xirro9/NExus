// ModelSelect: sidebar dropdown showing the LLM currently in use. Closed
// state = the active session's model, falling back to the server default
// (GET /api/model/default — fresh sessions report model:null until first
// use). Options come from the /api/model catalog (model × reasoning-effort
// variants); switching POSTs /api/session/{id}/model through
// nexus.setSessionModel (single call site — the server validates nothing,
// see API-NOTES). The endpoint is per-session: disabled with no session.

import { useMemo, type ChangeEvent } from "react"
import { Cpu } from "lucide-react"

import { useNexus } from "@/store/nexus"
import { useModels, useStatus } from "@/store/selectors"

/** Option value encoding: "providerID/modelID" or "providerID/modelID#variant".
 *  modelIDs may contain "/" — the provider is always the first segment. */
function optionValue(providerID: string, id: string, variant?: string): string {
  const clean = variant && variant !== "default" ? variant : undefined
  return `${providerID}/${id}${clean ? `#${clean}` : ""}`
}

export function ModelSelect() {
  const status = useStatus()
  const session = useNexus((s) =>
    s.activeSessionId ? (s.sessions[s.activeSessionId] ?? null) : null,
  )
  const models = useModels()
  const defaultModel = useNexus((s) => s.defaultModel)

  const options = useMemo(() => {
    const list: { value: string; label: string }[] = []
    for (const m of models) {
      if (m.enabled === false) continue
      const name = m.name || m.id
      list.push({ value: optionValue(m.providerID, m.id), label: name })
      for (const v of m.variants ?? []) {
        list.push({
          value: optionValue(m.providerID, m.id, v.id),
          label: `${name} · ${v.id}`,
        })
      }
    }
    return list
  }, [models])

  // current LLM: the session's model, else the server default
  const current = session?.model
    ? optionValue(session.model.providerID, session.model.id, session.model.variant)
    : defaultModel
      ? optionValue(defaultModel.providerID, defaultModel.id)
      : ""

  // catalog drift edge (model set outside the UI, catalog not yet loaded):
  // keep the current ref selectable — label is the raw ref, no invented name
  const visible = options.some((o) => o.value === current)
    ? options
    : current
      ? [{ value: current, label: current }, ...options]
      : options

  const disabled = status !== "online" || !session || visible.length === 0

  const onChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const raw = e.target.value
    const hash = raw.indexOf("#")
    const head = hash === -1 ? raw : raw.slice(0, hash)
    const variant = hash === -1 ? undefined : raw.slice(hash + 1)
    const slash = head.indexOf("/")
    const providerID = head.slice(0, slash)
    const modelID = head.slice(slash + 1)
    if (!providerID || !modelID) return
    void useNexus.getState().setSessionModel(providerID, modelID, variant)
  }

  return (
    <div className="px-3 pb-3">
      <label
        className="flex items-center gap-2 rounded-lg border border-border bg-input/60 px-2.5 py-1.5 transition-colors hover:border-muted-foreground/30"
        title={session ? "Current LLM — switch models" : "Open a session to switch models"}
      >
        <Cpu className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <select
          value={current}
          onChange={onChange}
          disabled={disabled}
          className="w-full cursor-pointer truncate bg-transparent text-xs text-foreground outline-none disabled:cursor-not-allowed disabled:text-muted-foreground"
          aria-label="Current LLM — switch models"
        >
          {visible.length === 0 ? (
            <option value="">—</option>
          ) : (
            visible.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          )}
        </select>
      </label>
    </div>
  )
}
