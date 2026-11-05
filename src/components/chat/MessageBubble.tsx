// Message dispatch: user card / assistant card with ordered parts / centered
// divider for synthetic roles (SPEC-PHASE3 §9.2). Assistant TEXT parts render
// markdown (SPEC-PHASE4 §8); reasoning stays plain dim italic, user input
// stays literal whitespace-pre-wrap, tool parts stay ToolPartCard.

import { renderMarkdown } from "@/lib/markdown"
import type { ChatMessage, MessagePart, TextPart } from "@/lib/opencode/types"
import { ReasoningBlock } from "./ReasoningBlock"
import { ToolPartCard } from "./ToolPartCard"

/**
 * Streaming fence-fixup (§8): while `message.streaming`, count ``` occurrences
 * in the partial text; if odd, append a closing fence to the RENDER SOURCE
 * ONLY (never to the store) so a half-fenced code block doesn't jump layouts.
 */
function renderSource(text: string, streaming: boolean): string {
  if (!streaming) return text
  const fenceCount = (text.match(/```/g) ?? []).length
  return fenceCount % 2 === 1 ? `${text}\n\n\`\`\`` : text
}

function TextBody({
  text,
  cursor,
  streaming,
}: {
  text: string
  cursor: boolean
  streaming: boolean
}) {
  return (
    <div
      className={`md-body md-chat${cursor ? " nexus-cursor" : ""}`}
      // renderMarkdown escapes raw HTML (html:false) and validates links —
      // see src/lib/markdown.ts for the security contract
      dangerouslySetInnerHTML={{ __html: renderMarkdown(renderSource(text, streaming)) }}
    />
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
        return <TextBody key={i} text={part.text} cursor={cursor} streaming={streaming} />
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
