// Context window panel (SPEC-PHASE2 §4): footprint bar vs the resolved context
// limit + per-message stacked breakdown from GET /session/{id}/context.
// Honesty labels are contractual (§4.2/§4.3): the top bar is cumulative since
// session start, the chart is the current window after the last compaction —
// they can legitimately disagree.

import { useEffect, useState } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { api } from "@/lib/opencode/client"
import type { ContextMessage } from "@/lib/opencode/types"
import { useActiveSession } from "@/store/selectors"
import { useNexus } from "@/store/nexus"
import { useContextLimit } from "@/hooks/useContextLimit"
import { AXIS_TICK, TOOLTIP_PROPS, useAnimateOnce } from "./chart-utils"
import { ContextBar } from "./ContextBar"
import { PanelCard } from "./PanelCard"

export function ContextPanel({ visible }: { visible: boolean }) {
  const session = useActiveSession()
  const activeSessionId = useNexus((s) => s.activeSessionId)
  const ctx = useContextLimit(session)
  const animate = useAnimateOnce()

  // per-message context: refetch on dashboard open, session change, and
  // session.usage.updated (tokens identity) — debounced 1 s, dashboard-visible
  // only (single-slot glm-server discipline, §9.2)
  const [ctxMsgs, setCtxMsgs] = useState<ContextMessage[] | null>(null)
  const [ctxErr, setCtxErr] = useState<string | null>(null)
  const tokens = session?.tokens
  useEffect(() => {
    if (!visible || !activeSessionId) return
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .getSessionContext(activeSessionId)
        .then((msgs) => {
          if (!cancelled) {
            setCtxMsgs(msgs)
            setCtxErr(null)
          }
        })
        .catch((err) => {
          if (!cancelled) setCtxErr(err instanceof Error ? err.message : String(err))
        })
    }, 1000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [visible, activeSessionId, tokens])

  const msgRows = (ctxMsgs ?? [])
    .filter((m) => m.type === "assistant" && m.tokens)
    .map((m, i) => ({
      i,
      suffix: m.id.slice(-6),
      model: m.model?.id ?? "?",
      input: m.tokens?.input ?? 0,
      output: m.tokens?.output ?? 0,
      reasoning: m.tokens?.reasoning ?? 0,
      cacheRead: m.tokens?.cache?.read ?? 0,
    }))

  return (
    <PanelCard
      title="Context window"
      right={
        session?.model ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            {ctx.source === "props"
              ? `n_ctx /props${ctx.stale ? " · stale" : ""}`
              : ctx.source === "catalog"
                ? "limit /api/model"
                : "limit unknown"}
          </span>
        ) : null
      }
    >
      {!session ? (
        <p className="py-1 text-xs text-muted-foreground">No active session.</p>
      ) : (
        <div className="space-y-3">
          <div>
            <ContextBar tokens={session.tokens} ctxLimit={ctx.limit} />
            <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
              footprint = sum of reported token classes, cumulative since session
              start; providers attribute cache differently — treat as an estimate.
            </p>
            {ctx.limit === null && session.model && (
              <p className="mt-1 font-mono text-[10px] text-warning">
                context limit unknown for {session.model.id}
              </p>
            )}
          </div>

          <div className="border-t border-border/70 pt-2.5">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                per-message (current window)
              </span>
              {ctxErr && (
                <span className="rounded-full border border-destructive/50 px-2 py-0.5 font-mono text-[10px] text-destructive">
                  {ctxErr}
                </span>
              )}
            </div>
            {msgRows.length < 2 ? (
              <p className="py-1 text-xs text-muted-foreground">
                {ctxErr
                  ? "context fetch failed — retrying on next usage update"
                  : "warming up (needs ≥2 assistant messages in context)"}
              </p>
            ) : (
              <div className="h-[130px]">
                {/* unmount while hidden — display:none measures 0 → warnings (§3.4) */}
                {visible ? (
                <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 130 }}>
                  <BarChart data={msgRows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="i"
                      tick={AXIS_TICK}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={24}
                    />
                    <YAxis
                      tick={AXIS_TICK}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
                    />
                    <Tooltip
                      {...TOOLTIP_PROPS}
                      labelFormatter={(label) => {
                        const r = msgRows[Number(label)]
                        return r ? `#${r.i} · …${r.suffix} · ${r.model}` : `#${String(label)}`
                      }}
                    />
                    <Bar dataKey="input" name="input" stackId="t" fill="var(--chart-1)" isAnimationActive={animate} />
                    <Bar dataKey="output" name="output" stackId="t" fill="var(--chart-2)" isAnimationActive={animate} />
                    <Bar dataKey="reasoning" name="reasoning" stackId="t" fill="var(--chart-4)" isAnimationActive={animate} />
                    <Bar dataKey="cacheRead" name="cache read" stackId="t" fill="var(--chart-3)" isAnimationActive={animate} />
                  </BarChart>
                </ResponsiveContainer>
                ) : (
                  <div className="h-full rounded-lg bg-muted/20" aria-hidden />
                )}
              </div>
            )}
            <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
              GET /session/…/context — all messages after the last compaction.
              Differs from the cumulative totals above by design.
            </p>
          </div>
        </div>
      )}
    </PanelCard>
  )
}
