// Chat orchestration: header + message list + composer, or the empty state.

import { useActiveMessages, useActiveSession, useIsBusy } from "@/store/selectors"
import { useNexus } from "@/store/nexus"
import { AiCore } from "@/components/rail/AiCore"
import { Plus } from "lucide-react"
import { ChatHeader } from "./ChatHeader"
import { Composer } from "./Composer"
import { MessageList } from "./MessageList"

export function ChatPanel() {
  const session = useActiveSession()
  const messages = useActiveMessages()
  const busy = useIsBusy()
  const sendPrompt = useNexus((s) => s.sendPrompt)
  const interruptActive = useNexus((s) => s.interruptActive)
  const newSession = useNexus((s) => s.newSession)
  const version = useNexus((s) => s.connection.version)

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-7 px-6 text-center">
        <AiCore state="idle" />
        <div>
          <h2 className="text-[26px] leading-tight font-semibold tracking-[-0.01em]">
            Command your OpenCode
          </h2>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Select a session from the sidebar, or start a new one to begin.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void newSession()}
          className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground shadow-[var(--glow-primary)] transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
        >
          <Plus className="size-4" aria-hidden />
          New session
        </button>
        {version && (
          <p className="font-mono text-[11px] text-muted-foreground/80">
            opencode v{version}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader
        session={session}
        busy={busy}
        onInterrupt={() => void interruptActive()}
      />
      <MessageList messages={messages} />
      <div className="border-t border-border/70 p-3 pb-4">
        <Composer
          disabled={false}
          busy={busy}
          onSend={(text) => void sendPrompt(text)}
          onInterrupt={() => void interruptActive()}
        />
      </div>
    </div>
  )
}
