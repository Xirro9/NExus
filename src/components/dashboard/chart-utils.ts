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

export const TOOLTIP_PROPS = {
  contentStyle: {
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    fontSize: 12,
    fontFamily: "var(--font-mono)",
    color: "var(--popover-foreground)",
  },
  labelStyle: { color: "var(--muted-foreground)", fontSize: 11 },
  itemStyle: { fontSize: 12 },
} as const
