// Pure formatters + the ticking clock for the Research view (T5-UI). No
// components, no store — see researchBits.tsx for the split rationale.
// fmtRelative/useNow mirror agents/useNow and activityData's copy: those
// modules are view internals and this chunk must stay one lazy unit, so the
// small pure versions live here (ProjectCard keeps its own copy too — the
// established precedent).

import { useEffect, useState } from "react"

/** Compact relative age ("now", "4m ago", "3h ago", "2d ago"). */
export function fmtRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  const m = Math.floor(diff / 60_000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Human absolute timestamp for library metadata ("Nov 9, 2026, 14:32"). */
export function fmtTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
}

/** Live-ticking clock so relative ages stay honest on an idle view. 30 s
 *  cadence — the research surfaces show ages, not per-second durations. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
