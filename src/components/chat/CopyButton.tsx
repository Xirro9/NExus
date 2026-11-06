// Copy affordance for tool cards (C1): copies the given text with the same
// clipboard + execCommand fallback pattern as the agents session menu, then
// briefly flips to a check for feedback.

import { useRef, useState } from "react"
import { Check, Copy } from "lucide-react"

export function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onCopy = () => {
    const done = () => {
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 1400)
    }
    const fallbackCopy = () => {
      try {
        const ta = document.createElement("textarea")
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        document.execCommand("copy")
        ta.remove()
        done()
      } catch {
        // silent — the button stays "Copy"; the text is selectable anyway
      }
    }
    navigator.clipboard?.writeText(text).then(done, fallbackCopy)
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className={
        "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors duration-150 " +
        (copied
          ? "border-success/40 bg-background/60 text-success"
          : "border-border/60 bg-background/60 text-muted-foreground hover:border-border hover:text-foreground") +
        " " +
        className
      }
      aria-label={copied ? "Copied" : label}
    >
      {copied ? (
        <Check className="size-3 text-success" aria-hidden />
      ) : (
        <Copy className="size-3" aria-hidden />
      )}
      {copied ? "Copied" : label}
    </button>
  )
}
