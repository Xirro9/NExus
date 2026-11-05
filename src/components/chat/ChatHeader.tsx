// Session title, agent/model mono chips, interrupt button while busy.

import type { SessionInfo } from "@/lib/opencode/types"
import { Square } from "lucide-react"

export function ChatHeader({
  session,
  busy,
  onInterrupt,
}: {
  session: SessionInfo | null
  busy: boolean
  onInterrupt(): void
}) {
  return (
    <header className="flex items-center gap-2.5 border-b border-border/70 px-4 py-2.5">
      <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">
        {session?.title || "Untitled session"}
      </h1>
      {session?.agent && (
        <span className="shrink-0 rounded-full border border-border bg-card/60 px-2 py-0.5 text-[11px] leading-none text-muted-foreground">
          {session.agent}
        </span>
      )}
      {session?.model && (
        <span className="hidden shrink-0 rounded-full border border-border bg-card/60 px-2 py-0.5 font-mono text-[11px] leading-none text-muted-foreground sm:inline">
          {session.model.id}
        </span>
      )}
      {busy && (
        <button
          type="button"
          onClick={onInterrupt}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-destructive/50 px-2.5 py-1 text-xs text-destructive transition-colors duration-150 hover:bg-destructive/10"
        >
          <Square className="size-3" aria-hidden />
          Interrupt
        </button>
      )}
    </header>
  )
}
