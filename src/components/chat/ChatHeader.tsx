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
    <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
        {session?.title || "Untitled session"}
      </h1>
      {session?.agent && (
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {session.agent}
        </span>
      )}
      {session?.model && (
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          {session.model.id}
        </span>
      )}
      {busy && (
        <button
          type="button"
          onClick={onInterrupt}
          className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/50 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
        >
          <Square className="h-3 w-3" aria-hidden />
          Interrupt
        </button>
      )}
    </header>
  )
}
