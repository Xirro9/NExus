// Shared recharts styling + the "animate on first render only" rule
// (SPEC-PHASE2 §6: per-poll animation at 2 s cadence is jank).

import { useEffect, useRef } from "react"

/** true during the first render pass, false afterwards — feed straight into
 *  recharts' `isAnimationActive`. */
export function useAnimateOnce(): boolean {
  const first = useRef(true)
  useEffect(() => {
    first.current = false
  }, [])
  // intentional: ref read during render is the "animate once" pattern — the
  // value is only consumed to seed the first isAnimationActive
  // oxlint-disable-next-line react/refs
  return first.current
}

export const AXIS_TICK = {
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  fill: "var(--muted-foreground)",
} as const

/** horizontal-only gridlines, quieter than the default full border */
export const GRID = {
  stroke: "var(--border)",
  strokeOpacity: 0.55,
  strokeDasharray: "3 4",
  vertical: false,
} as const

/** hover cursor for time-series charts: hairline vertical rule */
export const CURSOR_LINE = {
  stroke: "var(--muted-foreground)",
  strokeOpacity: 0.35,
  strokeWidth: 1,
} as const

/** hover cursor for categorical/bar charts: soft column highlight */
export const CURSOR_RECT = { fill: "oklch(1 0 0 / 0.04)" } as const

interface TooltipEntry {
  dataKey?: string | number
  name?: string | number
  value?: string | number
  color?: string
}

interface ChartTooltipProps {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string | number
  // recharts forwards its Tooltip `formatter`/`labelFormatter` into the
  // custom content element
  formatter?: (value: unknown, name: unknown) => [string, string] | string
  labelFormatter?: (label: unknown) => string
}

/** Custom recharts tooltip: popover surface, mono, per-series dots,
 *  tabular numerals. Replaces the default white-box look. */
export function ChartTooltip({ active, payload, label, formatter, labelFormatter }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="rounded-lg border border-border bg-popover/95 px-2.5 py-2 shadow-lg shadow-black/40 backdrop-blur-sm">
      {label !== undefined && (
        <div className="mb-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
          {labelFormatter ? labelFormatter(label) : String(label)}
        </div>
      )}
      <div className="space-y-0.5">
        {payload.map((entry, i) => {
          const raw = formatter
            ? formatter(entry.value, entry.name)
            : [entry.value, entry.name]
          const [value, name] = Array.isArray(raw) ? raw : [raw, entry.name]
          return (
            <div key={entry.dataKey ?? i} className="flex items-center gap-1.5 font-mono text-[11px] whitespace-nowrap">
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: entry.color ?? "var(--muted-foreground)" }}
                aria-hidden
              />
              <span className="text-muted-foreground">{String(name)}</span>
              <span className="ml-auto pl-3 tabular-nums text-foreground">{String(value)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
