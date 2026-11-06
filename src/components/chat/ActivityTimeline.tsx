// Technical timeline renderer (C2) — same messages[] as Conversation mode,
// no new fetches. Differences from the conversation render: per-entry
// timestamps, tool parts expanded by default with inputs/outputs/file paths,
// reasoning blocks inline (no collapse), synthetic roles (idle markers,
// interruptions, role dividers) as explicit event rows.
// Phase C designer pass: quiet left rail (hairline + role-tinted node) gives
// the timeline its spine; row semantics ride typography, not noise.

import type {
  ChatMessage,
  MessagePart,
  ReasoningPart,
  TextPart,
  ToolPart,
} from "@/lib/opencode/types"
import { fmtClock } from "@/lib/format"
import { TextBody } from "./MessageBubble"
import { ToolPartCard } from "./ToolPartCard"

function TimeCell({ at }: { at?: number }) {
  return (
    <span className="w-14 shrink-0 pt-0.5 text-right font-mono text-[10px] leading-5 text-muted-foreground/60 tabular-nums">
      {at ? fmtClock(at) : "—"}
    </span>
  )
}

/** Rail node tint per row semantics — cyan = you, violet = Jerry,
 *  hollow = synthetic event. */
const RAIL_NODE: Record<"user" | "assistant" | "event", string> = {
  user: "border-primary/60 bg-primary/20",
  assistant: "border-accent/60 bg-accent/20",
  event: "border-border bg-transparent",
}

function RailNode({ kind }: { kind: keyof typeof RAIL_NODE }) {
  return (
    <span className="relative flex h-5 w-3 shrink-0 justify-center" aria-hidden>
      <span className="absolute inset-y-0.5 w-px bg-border/40" />
      <span
        className={
          "relative z-10 mt-1.5 size-1.5 rounded-full border " + RAIL_NODE[kind]
        }
      />
    </span>
  )
}

/** Reasoning shown inline in activity mode — no collapse affordance. */
function InlineReasoning({ part }: { part: ReasoningPart }) {
  return (
    <div className="border-l border-accent/30 pl-3">
      <span className="font-mono text-[10px] tracking-wider text-muted-foreground/70 uppercase">
        reasoning
      </span>
      <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground italic">
        {part.text}
      </p>
    </div>
  )
}

function AssistantParts({ parts }: { parts: MessagePart[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      {parts.map((part, i) => {
        if (part.type === "reasoning") {
          return <InlineReasoning key={i} part={part} />
        }
        if (part.type === "tool") {
          const tool = part as ToolPart
          return <ToolPartCard key={tool.id || i} part={tool} defaultOpen />
        }
        return (
          <TextBody key={i} text={(part as TextPart).text} cursor={false} streaming={false} />
        )
      })}
    </div>
  )
}

/** Synthetic roles → explicit event rows: mono label pill + raw text
 *  (idle records carry outcomes like "interrupted" — kept verbatim). */
function EventRow({ role, text }: { role: string; text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5">
      <span className="shrink-0 rounded-full border border-border bg-card/60 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
        {role}
      </span>
      {text && (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80">
          {text}
        </span>
      )}
    </div>
  )
}

function TimelineRow({ message }: { message: ChatMessage }) {
  const isAssistant = message.role === "assistant"
  const isUser = message.role === "user"
  const railKind = isUser ? "user" : isAssistant ? "assistant" : "event"
  return (
    <li className="flex gap-2.5">
      <TimeCell at={message.time?.created} />
      <RailNode kind={railKind} />
      <div className="min-w-0 flex-1 pb-2">
        {(isAssistant || isUser) && (
          <span className="font-mono text-[10px] tracking-wider text-muted-foreground/70 uppercase">
            {isUser ? "user" : `assistant${message.agent ? ` · ${message.agent}` : ""}`}
          </span>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap text-sm text-foreground/90">
            {message.parts
              .filter((p): p is TextPart => p.type === "text")
              .map((p) => p.text)
              .join("\n")}
          </div>
        ) : isAssistant ? (
          <AssistantParts parts={message.parts} />
        ) : (
          <EventRow
            role={message.role}
            text={message.parts
              .filter((p): p is TextPart => p.type === "text")
              .map((p) => p.text)
              .join(" ")
              .trim()}
          />
        )}
      </div>
    </li>
  )
}

export function ActivityTimeline({ messages }: { messages: ChatMessage[] }) {
  if (messages.length === 0) return null
  return (
    <ol className="mx-auto flex max-w-3xl flex-col gap-3 pb-1">
      {messages.map((m) => (
        <TimelineRow key={m.id} message={m} />
      ))}
    </ol>
  )
}
