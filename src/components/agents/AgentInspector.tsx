// Agent inspector (Phase D3): replaces the 280px facts card with a tabbed
// inspector mounted at the same point. Tabs:
//   Overview   — facts + Jerry-side controls (priority, End/Delete/Copy/Open)
//   Delegation — the parent's `subagent` tool call that spawned THIS child
//                (correlated via state.metadata.sessionID; honest empty
//                states when the parent history isn't loaded or the call
//                isn't in the fetched window — never fabricated)
//   Timeline   — the child's real conversation history rendered with the
//                SAME primitives as chat (MessageBubble / ToolPartCard)
//   Files      — filesTouched from activity (real tool data only)
//   Results    — last error from activity + final assistant text
//
// History fetching goes through the store's loadMessages (cached per
// session; forced while the session is running so a live child's timeline
// stays fresh — SSE only maintains the ACTIVE chat session's messages).

import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowRight,
  ArrowUpLeft,
  Copy,
  FilePlus,
  RefreshCw,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import {
  DEFAULT_PRIORITY,
  PRIORITY_BADGE,
  SESSION_PRIORITIES,
} from "@/lib/sessionPriority"
import { fmtTokens } from "@/lib/format"
import { MESSAGE_LIST_CAP } from "@/lib/opencode/client"
import { useNexus } from "@/store/nexus"
import { useWorkspace } from "@/store/workspace"
import type { AgentNode } from "./graph"
import { findDelegation, type DelegationInfo } from "./delegation"
import { useNow } from "./useNow"
import { fmtDuration, durationMs, STATUS_DOT } from "./AgentListView"
import { MessageBubble, TextBody } from "@/components/chat/MessageBubble"
import { CopyButton } from "@/components/chat/CopyButton"

type InspectorTab = "overview" | "delegation" | "timeline" | "files" | "results"

const TABS_LABEL: Record<InspectorTab, string> = {
  overview: "Overview",
  delegation: "Delegation",
  timeline: "Timeline",
  files: "Files",
  results: "Results",
}

const OUTCOME_CHIP: Record<AgentNode["status"], string> = {
  running: "text-primary border-primary/50",
  idle: "text-muted-foreground border-border/60",
  succeeded: "text-success border-success/40",
  failed: "text-destructive border-destructive/40",
  interrupted: "text-warning border-warning/40",
}

/** Segmented tab strip — same sliding-pill treatment as the chat header's
 *  view toggle (one system, two toolbars). Roving tabindex + arrow keys. */
function InspectorTabs({
  tabs,
  active,
  onChange,
}: {
  /** [key, label, optional count chip text (null hides the chip)] */
  tabs: [InspectorTab, string, string | null][]
  active: InspectorTab
  onChange(tab: InspectorTab): void
}) {
  const reduced = useReducedMotion()
  const listRef = useRef<HTMLDivElement>(null)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
    e.preventDefault()
    const idx = tabs.findIndex(([k]) => k === active)
    const next =
      e.key === "ArrowRight"
        ? tabs[(idx + 1) % tabs.length]!
        : tabs[(idx - 1 + tabs.length) % tabs.length]!
    onChange(next[0])
    // move focus with the selection (roving tabindex)
    const btns = listRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']")
    btns?.[tabs.findIndex(([k]) => k === next[0])]?.focus()
  }
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Inspector sections"
      onKeyDown={onKeyDown}
      className="inline-flex max-w-full shrink-0 flex-wrap gap-0.5 rounded-lg border border-border/80 bg-card/60 p-0.5"
    >
      {tabs.map(([key, label, count]) => {
        const isActive = active === key
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(key)}
            className={
              "relative rounded-md px-2 py-1 text-[11px] leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 " +
              (isActive
                ? "font-medium text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {isActive && (
              <motion.span
                layoutId="inspector-tab-pill"
                aria-hidden
                className="absolute inset-0 rounded-md bg-secondary shadow-sm shadow-black/20"
                transition={
                  reduced
                    ? { duration: 0 }
                    : { type: "spring", bounce: 0.18, duration: 0.32 }
                }
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1">
              {label}
              {count !== null && (
                <span className="rounded-sm bg-muted-foreground/20 px-1 font-mono text-[9px] tabular-nums">
                  {count}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Labeled block with an optional copy button (delegation prompt, errors). */
function Block({
  label,
  copyText,
  tone = "neutral",
  children,
}: {
  label: string
  copyText?: string
  tone?: "neutral" | "destructive"
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] tracking-wider text-muted-foreground/70 uppercase">
          {label}
        </span>
        {copyText !== undefined && <CopyButton text={copyText} label={`Copy ${label.toLowerCase()}`} />}
      </div>
      <div
        className={
          "mt-1 max-h-64 overflow-y-auto rounded-md border p-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap " +
          (tone === "destructive"
            ? "border-destructive/40 bg-destructive/5 text-destructive"
            : "border-border/40 bg-background/60 text-muted-foreground")
        }
      >
        {children}
      </div>
    </div>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="py-3 text-xs leading-5 text-muted-foreground/80">{children}</p>
}

/** Tab count chip text — null hides the chip. At the server's message-list
 *  cap the list is TRUNCATED, so the chip reads "200+" (a floor), not a
 *  total (designer fix 3). */
function countChip(n: number | null | undefined): string | null {
  if (n === null || n === undefined || n <= 0) return null
  return n >= MESSAGE_LIST_CAP ? `${MESSAGE_LIST_CAP}+` : String(n)
}

export function AgentInspector({
  node,
  projectPath,
  onOpenInChat,
  onEnd,
  onDelete,
  onCopy,
  onSelectNode,
  onClose,
}: {
  node: AgentNode
  projectPath: string | null
  onOpenInChat(id: string): void
  onEnd(id: string): void
  onDelete(id: string): void
  onCopy(id: string): void
  /** navigate selection (parent breadcrumb) */
  onSelectNode(id: string): void
  /** deselect (X on narrow screens, where the inspector overlays the view) */
  onClose(): void
}) {
  const reduceMotion = useReducedMotion()
  const now = useNow(1000)
  const [tab, setTab] = useState<InspectorTab>("overview")

  // Drawer a11y (designer fix 2): Escape closes the inspector and focus
  // returns to the element that had it when the inspector opened. The
  // component unmounts on close in both sidebar and drawer (≤1100px) modes,
  // so a mount-scoped listener needs no mode check. onClose rides a ref —
  // upstream passes an inline arrow, and identity churn must not re-run
  // this effect (that would restore focus mid-session).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      // the opener may have unmounted meanwhile — focus() on a detached node is a no-op
      opener?.focus()
    }
  }, [])

  const activity = useNexus((s) => s.activity[node.id])
  const running = useNexus((s) => s.busy[node.id] === true)
  const childMessages = useNexus((s) => s.messages[node.id])
  const parentMessages = useNexus((s) =>
    node.parentId ? s.messages[node.parentId] : undefined,
  )
  const parentNode = useNexus((s) =>
    node.parentId ? s.sessions[node.parentId] : undefined,
  )
  const loadMessages = useNexus((s) => s.loadMessages)

  const inboxCount = useWorkspace((s) => s.inboxCounts[node.id] ?? null)
  const fetchInboxCount = useWorkspace((s) => s.fetchInboxCount)

  // child history: cached fetch, forced on a 5 s cadence while the session
  // is executing (live timeline), plain cached fetch otherwise
  useEffect(() => {
    if (!running) {
      void loadMessages(node.id)
      return
    }
    void loadMessages(node.id, { force: true })
    const timer = setInterval(() => {
      void loadMessages(node.id, { force: true })
    }, 5000)
    return () => clearInterval(timer)
  }, [node.id, running, loadMessages])

  // parent history on demand (cached — the Delegation tab correlates on it)
  useEffect(() => {
    if (node.parentId) void loadMessages(node.parentId)
  }, [node.parentId, loadMessages])

  // queued prompts are only observable while the session can have them
  useEffect(() => {
    if (node.status === "running") void fetchInboxCount(node.id)
  }, [node.id, node.status, fetchInboxCount])

  const delegation: DelegationInfo | null = useMemo(
    () =>
      node.parentId && parentMessages
        ? findDelegation(parentMessages, node.id)
        : null,
    [node.parentId, node.id, parentMessages],
  )

  // final assistant text — last assistant message carrying text parts
  const finalText = useMemo(() => {
    if (!childMessages) return null
    for (let i = childMessages.length - 1; i >= 0; i--) {
      const msg = childMessages[i]!
      if (msg.role !== "assistant") continue
      const text = msg.parts
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("\n")
      if (text.trim() !== "") return text
    }
    return null
  }, [childMessages])

  const files = activity?.filesTouched ?? []
  const lastError = activity?.lastError ?? null
  const currentTool = activity?.currentTool ?? null
  // real telemetry state when present; the coarse outcome stands in when
  // the session has produced no activity events yet
  const runState = activity?.state ?? node.status

  const loadParent = () => {
    if (node.parentId) void loadMessages(node.parentId, { force: true })
  }

  return (
    <motion.aside
      initial={reduceMotion ? false : { x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      aria-label={`Inspector for ${node.title}`}
      className={
        "flex w-[320px] max-w-[85vw] shrink-0 flex-col gap-2 overflow-hidden border-l border-border/70 bg-sidebar p-3 " +
        // narrow screens: the inspector overlays the view instead of squeezing it
        "max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-20 max-[1100px]:shadow-2xl max-[1100px]:shadow-black/50"
      }
    >
      <h2 className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Agent inspector
        <span className="ml-auto font-mono text-[10px] normal-case" title={node.id}>
          …{node.id.slice(-6)}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          title="Close inspector"
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </h2>

      <InspectorTabs
        tabs={[
          ["overview", "Overview", null],
          ["delegation", "Delegation", null],
          ["timeline", "Timeline", countChip(childMessages?.length)],
          ["files", "Files", countChip(files.length)],
          ["results", "Results", null],
        ]}
        active={tab}
        onChange={setTab}
      />

      <div
        role="tabpanel"
        aria-label={TABS_LABEL[tab]}
        className="min-h-0 flex-1 overflow-y-auto pr-0.5"
      >
        {tab === "overview" && (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium break-words">{node.title}</p>
              <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                <span>{node.agent}</span>
                <span className="rounded border border-border/60 px-1 text-[9px]">
                  {node.agentMode}
                </span>
                <span className="text-muted-foreground/60">d{node.depth}</span>
              </p>
            </div>

            {/* parent breadcrumb — navigates selection upstream */}
            <div className="rounded-xl border border-border/70 bg-card p-2.5">
              <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                Parent
              </span>
              {node.parentId && parentNode ? (
                <button
                  type="button"
                  onClick={() => onSelectNode(node.parentId!)}
                  className="mt-1 flex w-full items-center gap-1.5 rounded-lg border border-border/60 px-2 py-1.5 text-left text-xs text-foreground transition-colors duration-150 hover:border-primary/40 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                  title="Select the parent session"
                >
                  <ArrowUpLeft className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{parentNode.title || "Untitled session"}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                    …{node.parentId.slice(-6)}
                  </span>
                </button>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground/80">
                  Root session — no parent.
                </p>
              )}
            </div>

            <dl className="space-y-1.5 rounded-xl border border-border/70 bg-card p-3 font-mono text-xs tabular-nums">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">state</dt>
                <dd>
                  <span
                    className={
                      "rounded border px-1.5 py-0.5 text-[10px] " +
                      OUTCOME_CHIP[node.status]
                    }
                  >
                    {runState}
                  </span>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">status</dt>
                <dd className="flex items-center gap-1.5">
                  <span
                    className={"size-1.5 rounded-full " + STATUS_DOT[node.status]}
                    aria-hidden
                  />
                  {node.status}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">started</dt>
                <dd>{new Date(node.createdAt).toLocaleTimeString()}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">elapsed</dt>
                <dd>{fmtDuration(durationMs(node, now))}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">current tool</dt>
                <dd className="max-w-[170px] truncate" title={currentTool ?? undefined}>
                  {currentTool ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">project</dt>
                <dd className="max-w-[170px] truncate" title={projectPath ?? undefined}>
                  {projectPath ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">tokens</dt>
                <dd>{fmtTokens(node.tokens)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">cost</dt>
                <dd>${node.cost.toFixed(4)}</dd>
              </div>
              {node.status === "running" && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">queued</dt>
                  <dd title="Unconsumed prompts in the session inbox (— when unknown)">
                    {inboxCount === null ? "—" : String(inboxCount)}
                  </dd>
                </div>
              )}
            </dl>

            {/* priority — organizational only, labeled as such */}
            <label className="block rounded-xl border border-border/70 bg-card p-2.5">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Priority
                </span>
                <span className="font-mono text-[9px] text-muted-foreground/60">
                  {node.priority !== DEFAULT_PRIORITY ? (
                    <span className={"rounded border px-1 " + PRIORITY_BADGE[node.priority]}>
                      {node.priority}
                    </span>
                  ) : (
                    "unset"
                  )}
                </span>
              </span>
              <select
                value={node.priority}
                onChange={(e) =>
                  useNexus
                    .getState()
                    .setSessionPriority(node.id, e.target.value as (typeof SESSION_PRIORITIES)[number])
                }
                aria-label="Jerry-side organizational priority (does not affect execution order)"
                className="mt-1.5 h-7 w-full cursor-pointer rounded-lg border border-border bg-input/60 px-1.5 font-mono text-[11px] text-foreground"
              >
                {SESSION_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                    {p === DEFAULT_PRIORITY ? " (default)" : ""}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[9px] leading-3 text-muted-foreground/70">
                Jerry-side organization only — OpenCode has no scheduling API.
              </span>
            </label>

            {/* session control */}
            <div className="space-y-1.5">
              {node.status === "running" && (
                <button
                  type="button"
                  onClick={() => onEnd(node.id)}
                  className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-warning/60 px-3 text-sm font-medium text-warning transition-all duration-150 hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-warning/60 active:scale-[0.98]"
                >
                  <Square className="size-3.5" aria-hidden />
                  End Session
                </button>
              )}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => onCopy(node.id)}
                  className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-2 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                  title="Copy the full OpenCode session ID"
                >
                  <Copy className="size-3" aria-hidden />
                  Copy ID
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(node.id)}
                  className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-destructive/50 px-2 text-xs font-medium text-destructive transition-colors duration-150 hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/60"
                  title="Permanently delete this session and its history"
                >
                  <Trash2 className="size-3" aria-hidden />
                  Delete…
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onOpenInChat(node.id)}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground shadow-[var(--glow-primary)] transition-all duration-150 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar active:scale-[0.98]"
            >
              Open in Chat
              <ArrowRight className="size-3.5" aria-hidden />
            </button>
          </div>
        )}

        {tab === "delegation" && (
          <div className="flex flex-col gap-3">
            {!node.parentId ? (
              <EmptyHint>
                Root session — not spawned by a delegation.
              </EmptyHint>
            ) : !parentMessages ? (
              <>
                <EmptyHint>
                  The parent conversation isn't loaded yet — load it to
                  correlate the delegation call.
                </EmptyHint>
                <button
                  type="button"
                  onClick={loadParent}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border px-2 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                >
                  <RefreshCw className="size-3" aria-hidden />
                  Load parent history
                </button>
              </>
            ) : delegation ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] tracking-wider text-muted-foreground/70 uppercase">
                    agent
                  </span>
                  <span className="rounded border border-accent/50 px-1.5 py-0.5 font-mono text-[10px] text-accent">
                    {delegation.agent ?? "—"}
                  </span>
                </div>
                {delegation.description !== null && (
                  <Block label="description" copyText={delegation.description}>
                    {delegation.description}
                  </Block>
                )}
                {delegation.prompt !== null ? (
                  <Block label="prompt" copyText={delegation.prompt}>
                    {delegation.prompt}
                  </Block>
                ) : (
                  <EmptyHint>
                    The delegation call carries no prompt text in its input.
                  </EmptyHint>
                )}
              </>
            ) : (
              <EmptyHint>
                No matching subagent call in the parent's loaded history — the
                delegation may sit beyond the fetched message window.
              </EmptyHint>
            )}
          </div>
        )}

        {tab === "timeline" && (
          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              onClick={() => void loadMessages(node.id, { force: true })}
              className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 self-end rounded-lg border border-border px-2 text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title="Refetch this session's messages from the server"
            >
              <RefreshCw className="size-3" aria-hidden />
              Refresh
            </button>
            {!childMessages ? (
              <EmptyHint>No messages loaded yet.</EmptyHint>
            ) : childMessages.length === 0 ? (
              <EmptyHint>No messages in this session yet.</EmptyHint>
            ) : (
              // same quiet rail spine as the chat Activity view (Phase C) —
              // the hairline gives the history its backbone; the bubbles
              // carry the role semantics themselves
              <div className="flex flex-col gap-2.5 border-l border-border/40 pl-3">
                {childMessages.map((msg) => (
                  <MessageBubble key={msg.id} message={msg} />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "files" && (
          <div>
            {files.length === 0 ? (
              <EmptyHint>
                No files touched yet (only real tool activity feeds this list).
              </EmptyHint>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {files.map((p) => (
                  <span
                    key={p}
                    className="flex max-w-full items-center gap-1 truncate rounded border border-border/50 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-foreground/90"
                    title={p}
                  >
                    <FilePlus className="size-2.5 shrink-0 text-muted-foreground/70" aria-hidden />
                    <span className="truncate">{p}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "results" && (
          <div className="flex flex-col gap-3">
            {lastError !== null && (
              <Block label="last error" tone="destructive" copyText={lastError}>
                <span className="inline-flex items-start gap-1.5">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>{lastError}</span>
                </span>
              </Block>
            )}
            {!childMessages ? (
              <EmptyHint>
                Load the Timeline tab to see this session's final output.
              </EmptyHint>
            ) : finalText !== null ? (
              <div>
                <span className="font-mono text-[10px] tracking-wider text-muted-foreground/70 uppercase">
                  final output
                </span>
                <div className="mt-1 rounded-md border border-border/40 bg-background/60 p-2.5 text-xs">
                  <TextBody text={finalText} cursor={false} streaming={false} />
                </div>
              </div>
            ) : (
              <EmptyHint>No assistant output yet.</EmptyHint>
            )}
            {lastError === null && childMessages && finalText !== null && (
              <p className="text-[10px] text-muted-foreground/60">
                No tool or execution errors recorded in the activity stream.
              </p>
            )}
          </div>
        )}
      </div>
    </motion.aside>
  )
}
