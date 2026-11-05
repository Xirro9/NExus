// Message dispatch: user card / assistant card with ordered parts / centered
// divider for synthetic roles (SPEC-PHASE3 §9.2). No markdown library in chat
// (deferred) — fenced code via a trivial triple-backtick splitter (§8).

import type { ChatMessage, MessagePart, TextPart } from "@/lib/opencode/types"
import { ReasoningBlock } from "./ReasoningBlock"
import { ToolPartCard } from "./ToolPartCard"

/** Split text into plain and fenced-code chunks. */
function splitFences(text: string): { code: boolean; content: string }[] {
  const chunks: { code: boolean; content: string }[] = []
  const re = /```[^\n]*\n?/g
  let last = 0
  let match: RegExpExecArray | null
  let inCode = false
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      chunks.push({ code: inCode, content: text.slice(last, match.index) })
    }
    inCode = !inCode
    last = match.index + match[0].length
  }
  if (last < text.length) chunks.push({ code: inCode, content: text.slice(last) })
  return chunks
}

function TextBody({
  text,
  cursor,
}: {
  text: string
  cursor: boolean
}) {
  const chunks = splitFences(text)
  return (
    <div className={cursor ? "nexus-cursor" : undefined}>
      {chunks.map((chunk, i) =>
        chunk.code ? (
          <pre
            key={i}
            className="my-2 overflow-x-auto rounded-lg border border-border/70 bg-muted/70 p-3 font-mono text-xs leading-relaxed"
          >
            {chunk.content.replace(/\n$/, "")}
          </pre>
        ) : (
          <span key={i} className="whitespace-pre-wrap">
            {chunk.content}
          </span>
        ),
      )}
    </div>
  )
}

function AssistantParts({
  parts,
  streaming,
}: {
  parts: MessagePart[]
  streaming: boolean
}) {
  // cursor attaches to the last part while streaming
  const lastIncomplete = streaming ? parts.length - 1 : -1
  return (
    <div className="flex flex-col gap-2">
      {parts.map((part, i) => {
        const cursor = i === lastIncomplete
        if (part.type === "reasoning") {
          return (
            <ReasoningBlock key={i} part={part} streaming={streaming && cursor} />
          )
        }
        if (part.type === "tool") {
          return <ToolPartCard key={part.id || i} part={part} />
        }
        return <TextBody key={i} text={part.text} cursor={cursor} />
      })}
    </div>
  )
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    const text = message.parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")
    if (text === "") {
      // slash-command invocations arrive as user messages with no text part
      return (
        <div className="text-center font-mono text-[11px] text-muted-foreground/80">
          [/command]
        </div>
      )
    }
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-secondary px-4 py-2.5 text-secondary-foreground shadow-sm shadow-black/20">
          <div className="whitespace-pre-wrap">{text}</div>
        </div>
      </div>
    )
  }

  if (message.role === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-xl rounded-bl-sm border border-border/70 bg-card/40 px-4 py-2.5">
          <AssistantParts parts={message.parts} streaming={message.streaming === true} />
        </div>
      </div>
    )
  }

  // synthetic roles → centered divider: hairline rules + uppercase label pill
  // (§9.2) — replaces the raw bracket text
  const DIVIDER_LABELS: Record<string, string> = {
    idle: "idle",
    synthetic: "synthetic",
    system: "system",
    skill: "skill",
    shell: "shell",
    compaction: "compaction",
    "agent-switched": "agent switched",
    "model-switched": "model switched",
    "location-switched": "location switched",
  }
  const label = DIVIDER_LABELS[message.role] ?? message.role
  const line = message.parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim()
  return (
    <div className="flex items-center gap-2 px-6" aria-label={label}>
      <span className="h-px min-w-6 flex-1 bg-border/60" aria-hidden />
      <span className="shrink-0 font-mono text-[10px] tracking-wider text-muted-foreground/80 uppercase">
        {label}
      </span>
      {line && (
        <span className="min-w-0 max-w-[60%] truncate font-mono text-[10px] text-muted-foreground/60">
          {line}
        </span>
      )}
      <span className="h-px min-w-6 flex-1 bg-border/60" aria-hidden />
    </div>
  )
}
