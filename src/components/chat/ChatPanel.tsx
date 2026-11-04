// Chat orchestration: header + message list + composer, or the empty state.

import { useActiveMessages, useActiveSession, useIsBusy } from "@/store/selectors"
import { useNexus } from "@/store/nexus"
import { AiCore } from "@/components/rail/AiCore"
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

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
        <AiCore state="idle" />
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            No session selected
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Select or create a session to start chatting.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void newSession()}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-[var(--glow-primary)] hover:opacity-90"
        >
          New session
        </button>
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
      <div className="border-t border-border p-3">
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
