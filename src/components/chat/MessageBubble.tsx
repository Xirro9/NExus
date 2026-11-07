// Message dispatch: user card / assistant card with ordered parts / centered
// divider for synthetic roles (SPEC-PHASE3 §9.2). Assistant TEXT parts render
// markdown (SPEC-PHASE4 §8); reasoning stays plain dim italic, user input
// stays literal whitespace-pre-wrap, tool parts stay ToolPartCard.

import { resolveCopyTarget } from "@/lib/codeCopy"
import { renderMarkdown, useHighlighterReady } from "@/lib/markdown"
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

/** Clipboard fallback shared by the markdown copy buttons (no clipboard
 *  API → textarea + execCommand, same pattern as the agents session menu). */
function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand("copy")
    ta.remove()
    return true
  } catch {
    return false
  }
}

/**
 * Click delegation for the inert copy buttons the fence renderer emits
 * (data-md-copy — see src/lib/markdown.ts). Copies the fenced block's <pre>
 * text (scoped via .md-code — the button lives in the header row, the <pre>
 * is its SIBLING under the wrapper — see src/lib/codeCopy.ts) and flips the
 * button label; React never owns those nodes, so the feedback is a direct
 * DOM write scoped to the button.
 */
function onBodyClick(e: React.MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement
  const btn = target.closest<HTMLButtonElement>("[data-md-copy]")
  if (!btn) return
  const code = resolveCopyTarget(btn)
  if (code === null) return
  const done = () => {
    btn.textContent = "Copied"
    setTimeout(() => {
      btn.textContent = "Copy"
    }, 1400)
  }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).then(done, () => {
      if (!fallbackCopy(code)) btn.textContent = "Copy failed"
    })
  } else {
    fallbackCopy(code)
  }
}

export function TextBody({
  text,
  cursor,
  streaming,
}: {
  text: string
  cursor: boolean
  streaming: boolean
}) {
  // sugar-high loads lazily; this re-renders once it arrives so fences
  // upgrade from plain blocks to highlighted spans (render stays sync)
  useHighlighterReady()
  return (
    <div
      className={`md-body md-chat${cursor ? " nexus-cursor" : ""}`}
      onClick={onBodyClick}
      // renderMarkdown escapes raw HTML (html:false) and validates links —
      // see src/lib/markdown.ts for the security contract. codeCopy adds the
      // inert copy-button node to fences (handled by onBodyClick above).
      dangerouslySetInnerHTML={{
        __html: renderMarkdown(renderSource(text, streaming), { codeCopy: true }),
      }}
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
    <div className="flex flex-col gap-2.5">
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
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-secondary px-4 py-3 text-secondary-foreground shadow-sm shadow-black/20">
          <div className="whitespace-pre-wrap">{text}</div>
        </div>
      </div>
    )
  }

  if (message.role === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-xl rounded-bl-sm border border-border/60 bg-card/40 px-4 py-3">
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
