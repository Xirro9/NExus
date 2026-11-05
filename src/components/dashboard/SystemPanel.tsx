// System panel (SPEC-PHASE2 §7): CPU% + RAM% area charts from the 2 s /proc
// samples (server ring buffer, 300 pts ≈ 10 min) + load1 / memory readouts.

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { fmtBytes, fmtClock } from "@/lib/format"
import { useSystemSamples, useTelemetry } from "@/store/telemetry"
import { AXIS_TICK, ChartTooltip, CURSOR_LINE, GRID, useAnimateOnce } from "./chart-utils"
import { PanelCard, Warming } from "./PanelCard"

export function SystemPanel({ visible }: { visible: boolean }) {
  const samples = useSystemSamples()
  const ok = useTelemetry((s) => s.snapshot?.system.ok ?? false)
  const error = useTelemetry((s) => s.snapshot?.system.error ?? null)
  const animate = useAnimateOnce()

  const latest = samples.length > 0 ? samples[samples.length - 1]! : null
  const data = samples.map((s) => ({
    t: s.t,
    cpu: s.cpu,
    ramPct: s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : 0,
  }))

  return (
    <PanelCard
      title="System"
      right={
        latest ? (
          <span className="font-mono text-xs text-muted-foreground">
            {fmtBytes(latest.memUsed)} / {fmtBytes(latest.memTotal)}
          </span>
        ) : null
      }
      degraded={{ ok, error }}
    >
      {samples.length < 2 ? (
        <Warming n={samples.length} />
      ) : (
        <>
          <div className="grid flex-1 grid-cols-2 gap-4">
            <ChartCell label="cpu %" visible={visible}>
              <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="nexus-cpu-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.32} />
                    <stop offset="70%" stopColor="var(--chart-1)" stopOpacity={0.08} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...GRID} />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={48}
                  tickFormatter={fmtClock}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 50, 100]}
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={26}
                />
                <Tooltip
                  cursor={CURSOR_LINE}
                  content={
                    <ChartTooltip
                      labelFormatter={(label) => fmtClock(Number(label))}
                      formatter={(value) => [`${Number(value).toFixed(1)}%`, "cpu"]}
                    />
                  }
                />
                <Area
                  dataKey="cpu"
                  name="cpu %"
                  stroke="var(--chart-1)"
                  strokeWidth={1.75}
                  fill="url(#nexus-cpu-fill)"
                  dot={false}
                  activeDot={{ r: 2.5, strokeWidth: 0 }}
                  isAnimationActive={animate}
                />
              </AreaChart>
            </ChartCell>
            <ChartCell label="ram %" visible={visible}>
              <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="nexus-ram-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.32} />
                    <stop offset="70%" stopColor="var(--chart-2)" stopOpacity={0.08} />
                    <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...GRID} />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={48}
                  tickFormatter={fmtClock}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 50, 100]}
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={26}
                />
                <Tooltip
                  cursor={CURSOR_LINE}
                  content={
                    <ChartTooltip
                      labelFormatter={(label) => fmtClock(Number(label))}
                      formatter={(value) => [`${Number(value).toFixed(1)}%`, "ram"]}
                    />
                  }
                />
                <Area
                  dataKey="ramPct"
                  name="ram %"
                  stroke="var(--chart-2)"
                  strokeWidth={1.75}
                  fill="url(#nexus-ram-fill)"
                  dot={false}
                  activeDot={{ r: 2.5, strokeWidth: 0 }}
                  isAnimationActive={animate}
                />
              </AreaChart>
            </ChartCell>
          </div>
          {/* pinned to the card floor so the panel doesn't leave dead space
              when the GPU panel dictates the row height */}
          <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/70 pt-2.5 font-mono text-[11px] text-muted-foreground">
            <span className="tabular-nums">
              load1 <span className="text-foreground">{latest?.load1.toFixed(2) ?? "—"}</span>
            </span>
            <span>/proc-sourced</span>
          </div>
        </>
      )}
    </PanelCard>
  )
}

function ChartCell({
  label,
  visible,
  children,
}: {
  label: string
  visible: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-[130px] flex-col">
      <div className="mb-1 shrink-0 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
        {label}
      </div>
      {/* flex-1: grows with the row height (the GPU panel usually dictates it)
          instead of leaving dead space below the charts */}
      <div className="relative min-h-[110px] flex-1">
        {/* charts unmount while the dashboard is hidden (display:none measures
            0 → recharts warnings); the server ring keeps the data (§3.4) */}
        {visible ? (
          <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 130 }}>
            {children}
          </ResponsiveContainer>
        ) : (
          <div className="absolute inset-0 rounded-lg bg-muted/20" aria-hidden />
        )}
      </div>
    </div>
  )
}
