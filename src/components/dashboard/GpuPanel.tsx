// GPU panel (SPEC-PHASE2 §7): per-GPU util% lines + mem/temp/power readouts +
// compute-apps list. `source:"unavailable"` → empty state, never zero-filled.

import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { fmtClock } from "@/lib/format"
import { useComputeApps, useGpuSamples, useTelemetry } from "@/store/telemetry"
import { AXIS_TICK, ChartTooltip, CURSOR_LINE, GRID, useAnimateOnce } from "./chart-utils"
import { PanelCard, Warming } from "./PanelCard"

const GPU_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]

export function GpuPanel({ visible }: { visible: boolean }) {
  const samples = useGpuSamples()
  const ok = useTelemetry((s) => s.snapshot?.gpu.ok ?? false)
  const error = useTelemetry((s) => s.snapshot?.gpu.error ?? null)
  const source = useTelemetry((s) => s.snapshot?.gpu.source ?? "unavailable")
  const computeApps = useComputeApps()
  const animate = useAnimateOnce()

  // nvidia-smi not installed → first-class empty state (§2.8), no chart swap
  if (source === "unavailable") {
    return (
      <PanelCard title="GPU" degraded={{ ok: false, error: error ?? "nvidia-smi unavailable" }} />
    )
  }

  const latest = samples.length > 0 ? samples[samples.length - 1]! : null
  const gpus = latest?.gpus ?? []
  const data = samples.map((s) => {
    const row: Record<string, number> = { t: s.t }
    for (const g of s.gpus) row[`g${g.index}`] = g.utilGpu
    return row
  })

  return (
    <PanelCard
      title="GPU"
      dim={!ok}
      right={
        !ok ? (
          <span className="rounded-full border border-destructive/50 px-2 py-0.5 font-mono text-[10px] text-destructive">
            {error ?? "unavailable"}
          </span>
        ) : (
          <span className="font-mono text-[10px] text-muted-foreground">nvidia-smi</span>
        )
      }
    >
      {samples.length < 2 || gpus.length === 0 ? (
        <Warming n={samples.length} />
      ) : (
        <>
          <div className="h-[130px]">
            {/* unmount while hidden — display:none measures 0 → recharts warnings;
                the server ring keeps the data (§3.4) */}
            {visible ? (
            <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 130 }}>
              <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
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
                      formatter={(value, name) => [`${Number(value).toFixed(1)}%`, `GPU ${String(name).slice(1)}`]}
                    />
                  }
                />
                {gpus.map((g) => (
                  <Line
                    key={g.index}
                    dataKey={`g${g.index}`}
                    name={`g${g.index}`}
                    stroke={GPU_COLORS[g.index % GPU_COLORS.length]}
                    strokeWidth={1.75}
                    dot={false}
                    activeDot={{ r: 2.5, strokeWidth: 0 }}
                    isAnimationActive={animate}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
            ) : (
              <div className="h-full rounded-lg bg-muted/20" aria-hidden />
            )}
          </div>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {gpus.map((g) => (
              <li key={g.index} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: GPU_COLORS[g.index % GPU_COLORS.length] }}
                    aria-hidden
                  />
                  <span className="truncate text-muted-foreground">{g.name}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {g.memUsed}/{g.memTotal} MiB ·{" "}
                  <span className={g.tempGpu >= 80 ? "text-warning" : undefined}>{g.tempGpu}°C</span> ·{" "}
                  {g.powerDraw.toFixed(1)}W
                </span>
              </li>
            ))}
          </ul>
          {computeApps.length > 0 && (
            <div className="mt-2 border-t border-border/70 pt-2">
              <div className="mb-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                compute apps
              </div>
              <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                {computeApps.map((a, i) => (
                  <li key={`${a.pid}-${i}`} className="flex justify-between gap-2">
                    <span className="truncate">
                      {a.pid} · {a.name}
                    </span>
                    <span className="shrink-0 tabular-nums">{a.memUsedMiB} MiB</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </PanelCard>
  )
}
