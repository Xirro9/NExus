// Shared loading placeholder for the System panels (skills / plugins / MCP) —
// pulse rows in the same visual language as the memory viewer's skeleton.

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="space-y-1.5" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <li
          key={i}
          className="animate-pulse rounded-lg border border-border/70 bg-card px-3 py-2.5"
          style={{ animationDelay: `${i * 120}ms`, opacity: 1 - i * 0.18 }}
        >
          <div className="h-3 w-1/3 rounded bg-muted" />
          <div className="mt-2 h-2.5 w-2/3 rounded bg-muted/70" />
        </li>
      ))}
    </ul>
  )
}
