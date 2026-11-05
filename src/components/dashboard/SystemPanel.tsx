// System panel (SPEC-PHASE2 §7): CPU% + RAM% area charts from the 2 s /proc
// samples (server ring buffer, 300 pts ≈ 10 min) + load1 / memory readouts.

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { fmtBytes, fmtClock } from "@/lib/format"
import { useSystemSamples, useTelemetry } from "@/store/telemetry"
import { AXIS_TICK, TOOLTIP_PROPS, useAnimateOnce } from "./chart-utils"
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
          <div className="grid grid-cols-2 gap-3">
            <ChartCell label="cpu %" visible={visible}>
              <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="nexus-cpu-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
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
                <YAxis domain={[0, 100]} tick={AXIS_TICK} tickLine={false} axisLine={false} width={30} />
                <Tooltip {...TOOLTIP_PROPS} labelFormatter={(label) => fmtClock(Number(label))} />
                <Area
                  dataKey="cpu"
                  name="cpu %"
                  stroke="var(--chart-1)"
                  strokeWidth={1.5}
                  fill="url(#nexus-cpu-fill)"
                  dot={false}
                  isAnimationActive={animate}
                />
              </AreaChart>
            </ChartCell>
            <ChartCell label="ram %" visible={visible}>
              <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="nexus-ram-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
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
                <YAxis domain={[0, 100]} tick={AXIS_TICK} tickLine={false} axisLine={false} width={30} />
                <Tooltip {...TOOLTIP_PROPS} labelFormatter={(label) => fmtClock(Number(label))} />
                <Area
                  dataKey="ramPct"
                  name="ram %"
                  stroke="var(--chart-2)"
                  strokeWidth={1.5}
                  fill="url(#nexus-ram-fill)"
                  dot={false}
                  isAnimationActive={animate}
                />
              </AreaChart>
            </ChartCell>
          </div>
          {latest && (
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              load1 {latest.load1.toFixed(2)} · /proc-sourced
            </p>
          )}
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
    <div>
      <div className="mb-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
        {label}
      </div>
      <div className="h-[130px]">
        {/* charts unmount while the dashboard is hidden (display:none measures
            0 → recharts warnings); the server ring keeps the data (§3.4) */}
        {visible ? (
          <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 130 }}>
            {children}
          </ResponsiveContainer>
        ) : (
          <div className="h-full rounded-lg bg-muted/20" aria-hidden />
        )}
      </div>
    </div>
  )
}
