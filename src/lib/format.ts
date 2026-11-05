// Shared display formatting for telemetry numerals (mono contexts).

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

/** Decimal GB (matches `free -b` math). */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB"
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB"
  return (bytes / 1e3).toFixed(1) + " KB"
}

export function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour12: false })
}
