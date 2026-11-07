// Live-ticking clock hook (Phase D1): elapsed columns in the Agents tab were
// computed from a `now` captured at mount and went stale between the 5 s
// polls. This re-renders on the given cadence so durations tick.

import { useEffect, useState } from "react"

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
