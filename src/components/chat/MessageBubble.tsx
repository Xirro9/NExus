// Message dispatch: user card / assistant card with ordered parts / dim
// system line. No markdown library in Phase 1 — fenced code via a trivial
// triple-backtick splitter (§8).

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
            className="my-1.5 overflow-x-auto rounded-lg border border-border bg-muted/60 p-2.5 font-mono text-xs leading-relaxed"
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
    <div className="flex flex-col gap-1.5">
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
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-xl bg-secondary px-3.5 py-2 text-secondary-foreground">
          <div className="whitespace-pre-wrap">{text}</div>
        </div>
      </div>
    )
  }

  if (message.role === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-xl border border-border px-3.5 py-2">
          <AssistantParts parts={message.parts} streaming={message.streaming === true} />
        </div>
      </div>
    )
  }

  // system / synthetic / skill / compaction / idle / agent-switched / …
  const line = message.parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join(" ")
  return (
    <div className="text-center font-mono text-[11px] text-muted-foreground/70">
      [{message.role}
      {line ? `: ${line}` : ""}]
    </div>
  )
}
