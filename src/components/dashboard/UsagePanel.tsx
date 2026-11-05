// Usage stats view (SPEC-PHASE2 §5) from /api/experimental/session/stats.
// Poll discipline: at most one request / 30 s, ONLY while the dashboard tab is
// visible (starts/stops with tab visibility) + a manual refresh button.
// Requested with tools=detail so tools.usage[] (per-tool, durationP50) exists.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { RefreshCw } from "lucide-react"

import { api } from "@/lib/opencode/client"
import type { SessionStatsInfo } from "@/lib/opencode/types"
import { fmtTokens } from "@/lib/format"
import { useNexus } from "@/store/nexus"
import { AXIS_TICK, ChartTooltip, CURSOR_RECT, GRID, useAnimateOnce } from "./chart-utils"
import { ContextBar } from "./ContextBar"
import { PanelCard } from "./PanelCard"

const POLL_MS = 30_000

export function UsagePanel({ visible }: { visible: boolean }) {
  const [stats, setStats] = useState<SessionStatsInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const activeProjectId = useNexus((s) => s.activeProjectId)
  const scope = useNexus((s) =>
    s.activeProjectId
      ? (s.projects.find((p) => p.id === s.activeProjectId)?.canonical ?? null)
      : null,
  )
  const animate = useAnimateOnce()

  const fetchStats = useCallback(async () => {
    setRefreshing(true)
    try {
      // project= takes a Project.ID (verified live — a path matches nothing)
      const data = await api.getSessionStats({
        tools: "detail",
        ...(activeProjectId ? { project: activeProjectId } : {}),
      })
      setStats(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }, [activeProjectId])

  useEffect(() => {
    if (!visible) return
    // deferred initial fetch: keeps synchronous setState out of the effect body
    const t = setTimeout(() => void fetchStats(), 0)
    const iv = setInterval(() => void fetchStats(), POLL_MS)
    return () => {
      clearTimeout(t)
      clearInterval(iv)
    }
  }, [visible, fetchStats])

  // activity: zero-fill days across range.from/to so sparse data reads
  // honestly instead of looking full (§5.4); capped defensively.
  // activity[].date is a UTC calendar day — day keys must use UTC getters or a
  // real activity day renders as zero in non-UTC timezones
  const activityRows = useMemo(() => {
    if (!stats) return []
    const byDate = new Map(stats.activity.map((a) => [a.date, a.steps]))
    const rows: { date: string; steps: number }[] = []
    const cursor = new Date(stats.range.from)
    cursor.setUTCHours(0, 0, 0, 0)
    const end = new Date(stats.range.to)
    while (cursor.getTime() <= end.getTime() && rows.length < 400) {
      const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`
      rows.push({ date: key, steps: byDate.get(key) ?? 0 })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return rows
  }, [stats])

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-semibold tracking-tight">Usage</h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">
            {scope ? `scope ${scope}` : "scope all projects"} · ≤1 req / 30 s
          </span>
          <button
            type="button"
            onClick={() => void fetchStats()}
            disabled={refreshing || !visible}
            className="inline-flex size-7 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors duration-150 hover:bg-secondary/50 hover:text-foreground disabled:opacity-50"
            aria-label="Refresh usage stats"
          >
            <RefreshCw className={"size-3.5" + (refreshing ? " animate-spin" : "")} aria-hidden />
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          stats request failed — retrying while visible ({error})
        </div>
      )}

      {!stats ? (
        <PanelCard title="Usage" degraded={{ ok: false, error: error ?? "loading…" }} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 xl:grid-cols-6">
            <Kpi label="sessions" value={String(stats.sessions)} />
            <Kpi label="subagents" value={String(stats.subagents)} />
            <Kpi label="prompts" value={String(stats.prompts)} />
            <Kpi label="steps" value={String(stats.steps)} />
            <Kpi label="cost" value={`$${stats.cost.toFixed(4)}`} />
            <Kpi label="active" value={`${stats.activeDays}d`} chip={`streak ${stats.streak}`} />
          </div>

          <PanelCard title="Token totals">
            <div className="space-y-3">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-3">
                <Stat k="input" v={fmtTokens(stats.tokens.input)} />
                <Stat k="output" v={fmtTokens(stats.tokens.output)} />
                <Stat k="reasoning" v={fmtTokens(stats.tokens.reasoning)} />
                <Stat k="cache read" v={fmtTokens(stats.tokens.cache?.read ?? 0)} />
                <Stat k="cache write" v={fmtTokens(stats.tokens.cache?.write ?? 0)} />
                <Stat k="cost" v={`$${stats.cost.toFixed(4)}`} />
              </dl>
              <div className="space-y-2 border-t border-border/70 pt-2.5">
                {stats.models.map((m) => (
                  <div key={`${m.model.providerID}/${m.model.id}/${m.model.variant ?? ""}`}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
                        <span className="truncate">{m.model.id}</span>
                        <span className="shrink-0 text-muted-foreground">@{m.model.providerID}</span>
                        {m.model.variant && (
                          <span className="shrink-0 rounded-full border border-border/70 px-1.5 text-[10px] text-muted-foreground">
                            {m.model.variant}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {m.steps} steps
                      </span>
                    </div>
                    <ContextBar tokens={m.tokens} ctxLimit={null} relative />
                  </div>
                ))}
              </div>
            </div>
          </PanelCard>

          <PanelCard
            title="Tool reliability"
            right={
              <span className="font-mono text-[10px] text-muted-foreground">
                mode {stats.tools.mode}
              </span>
            }
          >
            <div className="space-y-3">
              <div>
                <div className="flex h-2.5 overflow-hidden rounded-full bg-muted/50">
                  <Seg color="var(--chart-3)" n={stats.tools.totals.succeeded} d={stats.tools.totals.calls} />
                  <Seg color="var(--chart-5)" n={stats.tools.totals.failed} d={stats.tools.totals.calls} />
                  <Seg color="var(--muted-foreground)" n={stats.tools.totals.unfinished} d={stats.tools.totals.calls} />
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-muted-foreground">
                  <span>calls {stats.tools.totals.calls}</span>
                  <span className="text-[color:var(--chart-3)]">ok {stats.tools.totals.succeeded}</span>
                  <span className="text-destructive">fail {stats.tools.totals.failed}</span>
                  <span>unfinished {stats.tools.totals.unfinished}</span>
                </div>
              </div>
              {stats.tools.mode === "detail" && stats.tools.usage ? (
                <div className="overflow-x-auto">
                  <table className="w-full font-mono text-[11px]">
                    <thead>
                      <tr className="border-b border-border/70 text-left text-[10px] tracking-wider text-muted-foreground uppercase">
                        <th className="pb-1.5 font-medium">tool</th>
                        <th className="pb-1.5 text-right font-medium">calls</th>
                        <th className="pb-1.5 text-right font-medium">ok</th>
                        <th className="pb-1.5 text-right font-medium">fail</th>
                        <th className="pb-1.5 text-right font-medium">p50 ms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.tools.usage.map((u) => (
                        <tr
                          key={u.name}
                          className="border-t border-border/40 transition-colors duration-100 first:border-t-0 hover:bg-secondary/30"
                        >
                          <td className="py-1.5">{u.name}</td>
                          <td className="py-1.5 text-right tabular-nums">{u.calls}</td>
                          <td className="py-1.5 text-right tabular-nums">{u.succeeded}</td>
                          <td className={"py-1.5 text-right tabular-nums" + (u.failed > 0 ? " text-destructive" : "")}>
                            {u.failed}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">{u.durationP50}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="font-mono text-[10px] text-muted-foreground">
                  per-tool rows need tools=detail (requested with detail on next refresh)
                </p>
              )}
            </div>
          </PanelCard>

          <PanelCard title="Activity">
            {activityRows.length === 0 ? (
              <p className="py-1 text-xs text-muted-foreground">no activity data</p>
            ) : (
              <div className="h-[130px]">
                {/* unmount while hidden — display:none measures 0 → warnings (§3.4) */}
                {visible ? (
                <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 130 }}>
                  <BarChart data={activityRows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="nexus-activity-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.9} />
                        <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={40} />
                    <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                    <Tooltip
                      cursor={CURSOR_RECT}
                      content={<ChartTooltip formatter={(v) => [String(v), "steps"]} />}
                    />
                    <Bar
                      dataKey="steps"
                      fill="url(#nexus-activity-fill)"
                      isAnimationActive={animate}
                      radius={[3, 3, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
                ) : (
                  <div className="h-full rounded-lg bg-muted/20" aria-hidden />
                )}
              </div>
            )}
            <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
              steps per day across the stats range (zero-days rendered honestly)
            </p>
          </PanelCard>
        </>
      )}
    </section>
  )
}

function Kpi({ label, value, chip }: { label: string; value: string; chip?: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3 shadow-[inset_0_1px_0_0_oklch(1_0_0/0.03)]">
      <div className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1.5 font-mono text-lg leading-none tabular-nums">{value}</div>
      {chip && <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">{chip}</div>}
    </div>
  )
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  )
}

function Seg({ color, n, d }: { color: string; n: number; d: number }) {
  if (d <= 0 || n <= 0) return null
  return <div style={{ background: color, width: `${(n / d) * 100}%` }} />
}
