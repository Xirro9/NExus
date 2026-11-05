// One session row: truncated title, relative time, mono id suffix, busy dot.

import type { SessionInfo } from "@/lib/opencode/types"

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "now"
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function SessionListItem({
  session,
  active,
  busy,
  onSelect,
}: {
  session: SessionInfo
  active: boolean
  busy: boolean
  onSelect(id: string): void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        aria-current={active ? "true" : undefined}
        className={
          "w-full rounded-lg px-2 py-1.5 text-left transition-colors duration-150 " +
          (active
            ? "bg-secondary text-secondary-foreground ring-1 ring-border/60"
            : "hover:bg-secondary/50")
        }
      >
        <div className="flex items-center gap-2">
          {/* dot slot always present so titles never shift when busy flips */}
          <span className="flex size-1.5 shrink-0 items-center justify-center">
            {busy && (
              <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[var(--glow-primary)]" />
            )}
          </span>
          <span
            className={
              "min-w-0 flex-1 truncate text-[13px] " +
              (active ? "font-medium" : "")
            }
          >
            {session.title || "Untitled session"}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80">
            {relativeTime(session.time.updated || session.time.created)}
          </span>
        </div>
        <div className="mt-0.5 pl-3.5 font-mono text-[10px] text-muted-foreground/80">
          …{session.id.slice(-6)}
        </div>
      </button>
    </li>
  )
}
