// Tool call card (C1): kind-appropriate icon + human title/detail from
// formatToolCall, status chip, and an expandable body with per-kind formatted
// content — file chips + patch excerpt (edit), command + output (bash),
// subagent child-session affordance, safe input-key summary for unknown
// tools (never a JSON dump). Copy buttons ride every block. Collapsed by
// default; ActivityTimeline passes defaultOpen for the technical view.

import { useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import type { ToolPart } from "@/lib/opencode/types"
import { formatToolCall, type ToolKind } from "@/lib/toolDisplay"
import {
  Bot,
  BookOpen,
  Check,
  ChevronRight,
  Eye,
  FilePen,
  FilePlus,
  FolderSearch,
  Search,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react"
import { useNexus } from "@/store/nexus"
import { CopyButton } from "./CopyButton"

const KIND_ICONS: Record<ToolKind, typeof Wrench> = {
  read: Eye,
  edit: FilePen,
  write: FilePlus,
  bash: Terminal,
  grep: Search,
  glob: FolderSearch,
  subagent: Bot,
  // research-library tools (T5): library reads — same book icon as the
  // sidebar's Research destination
  research: BookOpen,
  other: Wrench,
}

// kind → icon tint (two brand hues only: cyan = execution, violet = mutation;
// inspection tools stay neutral so the accents read as signal, not decoration)
const KIND_TINT: Record<ToolKind, string> = {
  read: "border-border/60 bg-muted/60 text-muted-foreground",
  grep: "border-border/60 bg-muted/60 text-muted-foreground",
  glob: "border-border/60 bg-muted/60 text-muted-foreground",
  // read-only library inspection — neutral like the other inspection tools
  research: "border-border/60 bg-muted/60 text-muted-foreground",
  other: "border-border/60 bg-muted/60 text-muted-foreground",
  bash: "border-primary/25 bg-primary/10 text-primary",
  subagent: "border-primary/25 bg-primary/10 text-primary",
  edit: "border-accent/25 bg-accent/10 text-accent",
  write: "border-accent/25 bg-accent/10 text-accent",
}

function StatusChip({ status }: { status: string }) {
  if (status === "running") {
    return (
      <span className="nexus-dots rounded-full border border-primary/40 bg-primary/5 px-1.5 py-0.5 font-mono text-[10px] leading-none text-primary">
        running
      </span>
    )
  }
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-success/30 px-1.5 py-0.5 font-mono text-[10px] leading-none text-success/90">
        <Check className="size-2.5" aria-hidden /> done
      </span>
    )
  }
  // live-verified status values are completed/error (types.ts) — treat both
  // spellings as the failure state
  if (status === "failed" || status === "error") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-destructive">
        <TriangleAlert className="size-2.5" aria-hidden /> failed
      </span>
    )
  }
  return (
    <span className="rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
      {status}
    </span>
  )
}

// ---------------------------------------------------------------------------
// body building blocks

/** A labeled block with a copy button — `text` is what gets copied. */
function Section({
  label,
  copyText,
  children,
}: {
  label: string
  copyText: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] tracking-wider text-muted-foreground/70 uppercase">
          {label}
        </span>
        <CopyButton text={copyText} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function PreText({
  text,
  maxHeight = "max-h-48",
}: {
  text: string
  maxHeight?: string
}) {
  return (
    <pre
      className={`${maxHeight} overflow-auto rounded-md border border-border/40 bg-background/60 p-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground`}
    >
      {text}
    </pre>
  )
}

function FileChips({ paths }: { paths: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {paths.map((p) => (
        <span
          key={p}
          className="flex max-w-full items-center gap-1 truncate rounded border border-border/50 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-foreground/90 transition-colors duration-150 hover:border-border/80"
          title={p}
        >
          <FilePlus className="size-2.5 shrink-0 text-muted-foreground/70" aria-hidden />
          <span className="truncate">{p}</span>
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// output/input text extraction — defensive, string-shaped when possible

/** Human-readable text from a tool output value, or null when the shape
 *  carries no text (copy falls back to formatted JSON). */
function outputText(output: unknown): string | null {
  if (output === undefined || output === null) return null
  if (typeof output === "string") return output
  if (Array.isArray(output)) {
    const parts = output
      .map((p) =>
        typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).text === "string"
          ? ((p as Record<string, unknown>).text as string)
          : null,
      )
      .filter((t): t is string => t !== null)
    if (parts.length > 0) return parts.join("\n")
    return null
  }
  if (
    typeof output === "object" &&
    typeof (output as Record<string, unknown>).text === "string"
  ) {
    return (output as Record<string, unknown>).text as string
  }
  return null
}

/** edit metadata: { files: [{ file, patch }] } — verified live (Phase B). */
function metadataPatches(metadata: unknown): { file: string; patch: string }[] {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !Array.isArray((metadata as Record<string, unknown>).files)
  ) {
    return []
  }
  const out: { file: string; patch: string }[] = []
  for (const f of (metadata as Record<string, unknown>).files as unknown[]) {
    if (typeof f === "object" && f !== null) {
      const file = (f as Record<string, unknown>).file
      const patch = (f as Record<string, unknown>).patch
      if (typeof file === "string" && typeof patch === "string") {
        out.push({ file, patch })
      }
    }
  }
  return out
}

const PATCH_LINES = 12

/** Diff-like line tinting — class per leading marker, verbatim text. */
function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "diff-meta"
  }
  if (line.startsWith("@@")) return "diff-hunk"
  if (line.startsWith("+")) return "diff-add"
  if (line.startsWith("-")) return "diff-del"
  return ""
}

function PatchExcerpt({ file, patch }: { file: string; patch: string }) {
  const lines = patch.split("\n")
  const excerpt = lines.slice(0, PATCH_LINES)
  const more = lines.length - PATCH_LINES
  return (
    <div className="space-y-1">
      <p className="truncate font-mono text-[10px] text-muted-foreground/80" title={file}>
        {file}
      </p>
      <pre className="max-h-40 overflow-auto rounded-md border border-border/40 bg-background/60 p-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
        {excerpt.map((line, i) => {
          const cls = diffLineClass(line)
          return (
            <span key={i} className={cls || undefined}>
              {line + "\n"}
            </span>
          )
        })}
        {more > 0 && (
          <span className="text-muted-foreground/60">… {more} more lines</span>
        )}
      </pre>
    </div>
  )
}

/** Unknown-tool input: one line per key — scalar values truncated, objects
 *  shown as shape placeholders. Never a JSON dump (formatToolCall contract). */
function InputKeySummary({ input }: { input: unknown }) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null
  }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return null
  return (
    <ul className="space-y-0.5">
      {entries.map(([key, value]) => {
        let shown: string
        if (typeof value === "string") {
          shown = value.length > 120 ? value.slice(0, 119) + "…" : value
        } else if (typeof value === "number" || typeof value === "boolean") {
          shown = String(value)
        } else if (value === null || value === undefined) {
          shown = "—"
        } else {
          shown = Array.isArray(value) ? `[…${value.length} items]` : "{…object}"
        }
        return (
          <li key={key} className="font-mono text-[11px] text-muted-foreground">
            <span className="text-foreground/80">{key}</span>: {shown}
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------

export function ToolPartCard({
  part,
  defaultOpen = false,
}: {
  part: ToolPart
  /** Activity mode expands tool cards by default (conversation stays collapsed). */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const reduced = useReducedMotion()
  const display = formatToolCall(part.name, part.state.input, part.state.metadata)
  const Icon = KIND_ICONS[display.kind]

  // subagent child-session navigation — only offered when the child session
  // is actually known to the store (setActiveSession would otherwise open a
  // blank untitled view for a pruned/unknown id)
  const childID = display.subagentSessionID
  const childKnown = useNexus((s) =>
    childID ? s.sessions[childID] !== undefined : false,
  )
  const setActiveSession = useNexus((s) => s.setActiveSession)

  const input = part.state.input
  const output = part.state.output
  const inputCopy =
    input === undefined ? "" : JSON.stringify(input, null, 2)
  const outText = outputText(output)
  const outputCopy = outText ?? (output === undefined ? "" : JSON.stringify(output, null, 2))
  const patches = metadataPatches(part.state.metadata)

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/40 transition-colors duration-150 hover:border-border/80">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-muted/70"
        aria-expanded={open}
      >
        <ChevronRight
          className={
            "size-3 shrink-0 text-muted-foreground/70 transition-transform duration-150 " +
            (open ? "rotate-90" : "")
          }
          aria-hidden
        />
        <span
          className={
            "flex size-5 shrink-0 items-center justify-center rounded border " +
            KIND_TINT[display.kind]
          }
          aria-hidden
        >
          <Icon className="size-3" />
        </span>
        <span className="shrink-0 font-mono text-xs text-foreground/95">
          {display.title}
        </span>
        {display.detail && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
            {display.detail}
          </span>
        )}
        {!display.detail && <span className="min-w-0 flex-1" />}
        <StatusChip status={part.state.status} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="space-y-3 border-t border-border/40 px-2.5 py-3">
              {display.filePaths.length > 0 && (
                <Section label="files" copyText={display.filePaths.join("\n")}>
                  <FileChips paths={display.filePaths} />
                </Section>
              )}
              {display.kind === "edit" &&
                patches.map((p) => (
                  <Section key={p.file} label="patch" copyText={p.patch}>
                    <PatchExcerpt file={p.file} patch={p.patch} />
                  </Section>
                ))}
              {display.kind === "bash" &&
                typeof input === "object" &&
                input !== null &&
                typeof (input as Record<string, unknown>).command === "string" && (
                  <Section
                    label="command"
                    copyText={(input as Record<string, unknown>).command as string}
                  >
                    <PreText
                      text={(input as Record<string, unknown>).command as string}
                      maxHeight="max-h-40"
                    />
                  </Section>
                )}
              {(display.kind === "grep" || display.kind === "glob") &&
                typeof input === "object" &&
                input !== null &&
                typeof (input as Record<string, unknown>).pattern === "string" && (
                  <Section
                    label="pattern"
                    copyText={(input as Record<string, unknown>).pattern as string}
                  >
                    <PreText
                      text={(input as Record<string, unknown>).pattern as string}
                      maxHeight="max-h-24"
                    />
                  </Section>
                )}
              {display.kind === "other" && input !== undefined && (
                <Section label="input" copyText={inputCopy}>
                  <InputKeySummary input={input} />
                </Section>
              )}
              {output !== undefined && (outText !== null || display.kind === "other") && (
                <Section label="output" copyText={outputCopy}>
                  {outText !== null ? (
                    <PreText text={outText} maxHeight="max-h-64" />
                  ) : (
                    <InputKeySummary input={output} />
                  )}
                </Section>
              )}
              {display.kind === "subagent" && childID && (
                <div className="flex items-center gap-2">
                  {childKnown ? (
                    <button
                      type="button"
                      onClick={() => void setActiveSession(childID)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 px-2.5 py-1 text-xs text-primary transition-colors duration-150 hover:bg-primary/10"
                    >
                      <Bot className="size-3.5" aria-hidden />
                      Open child session
                    </button>
                  ) : (
                    <>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
                        title={childID}
                      >
                        child session {childID}
                      </span>
                      <CopyButton text={childID} label="Copy ID" />
                    </>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
