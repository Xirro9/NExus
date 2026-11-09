// Researcher activity (T5-UI): sessions run by the `researcher` agent, with an
// internal-vs-external research tally from each session's recent tool NAMES
// (refs only — the store never keeps input/output). Row descriptions come from
// the parent's `subagent` delegation input (findDelegation — the same source
// the Agents inspector uses); parents whose messages are not loaded are
// fetched once via the store's cached loadMessages. Unresolved tool names
// count as NEITHER library nor web — never guessed.
//
// LIVE-DATA NOTE on membership: SessionInfo.agent is the RUNNER, not the
// delegated agent — child sessions report "general" and roots report null,
// so a bare `s.agent === "researcher"` filter matches nothing real. The
// researcher identity rides ONLY on the parent's `subagent` tool input, so
// membership is resolved through collectDelegations over parent messages
// (candidate parents = every session's parentID, loaded once, cached).
// Delegations that are not loaded yet resolve to NEITHER match — the row is
// simply omitted until the messages arrive, never guessed.

import { useEffect, useMemo, useRef } from "react"
import { FlaskConical } from "lucide-react"

import { collectDelegations, findDelegation } from "@/components/agents/delegation"
import { researchSourceOf } from "@/lib/toolDisplay"
import type { ChatMessage, SessionInfo } from "@/lib/opencode/types"
import { useNexus } from "@/store/nexus"
import { useSessionRecentTools } from "@/store/selectors"
import { useWorkspace } from "@/store/workspace"
import { PanelCard } from "@/components/dashboard/PanelCard"

import { fmtRelative, useNow } from "./researchFmt"
import { CountChip, EmptyNote, SourceTally, StateDot, type RunKind } from "./researchBits"

const RESEARCHER_AGENT = "researcher"
const ROW_CAP = 12

const EMPTY_MESSAGES: ChatMessage[] = []

const OUTCOME_LABEL = {
  succeeded: "completed",
  failed: "failed",
  interrupted: "interrupted",
} as const

const ROW_CLICK_CLASSES =
  "flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50"

const ROW_PLAIN_CLASSES =
  "flex w-full items-center gap-2 px-2 py-1.5 text-left"

export function ResearcherActivity({
  onOpenSession,
}: {
  onOpenSession?: (sessionID: string) => void
}) {
  const sessions = useNexus((s) => s.sessions)
  const messages = useNexus((s) => s.messages)
  const loadMessages = useNexus((s) => s.loadMessages)

  // Candidate parents: every session's parentID (deduped). Membership can
  // only be resolved from parent messages, so this must not depend on the
  // filtered rows — that would be circular (rows need delegations,
  // delegations need parents).
  const candidateParentIds = useMemo(
    () =>
      new Set(
        Object.values(sessions)
          .map((s) => s.parentID)
          .filter((id): id is string => typeof id === "string"),
      ),
    [sessions],
  )

  // childSessionID → delegation, from every LOADED parent conversation.
  const delegations = useMemo(
    () => collectDelegations(messages, candidateParentIds),
    [messages, candidateParentIds],
  )

  const { rows, total } = useMemo(() => {
    const all = Object.values(sessions).filter(
      (s) =>
        s.agent === RESEARCHER_AGENT ||
        delegations.get(s.id)?.agent === RESEARCHER_AGENT,
    )
    all.sort((a, b) => b.time.updated - a.time.updated)
    return { rows: all.slice(0, ROW_CAP), total: all.length }
  }, [sessions, delegations])

  // Load candidate parents' messages once (cached in the store) so
  // collectDelegations/findDelegation can read the delegation input. A
  // parent that is gone from the sessions map is skipped — no description
  // is fabricated and no 404 toast is risked. A parent that exists but is
  // not yet visible during an SSE gap stays unresolved until the next
  // mount or the next sessions-map change that adds it.
  const requestedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const pid of candidateParentIds) {
      if (requestedRef.current.has(pid)) continue
      requestedRef.current.add(pid)
      if (sessions[pid] !== undefined) void loadMessages(pid)
    }
  }, [candidateParentIds, loadMessages, sessions])

  const now = useNow()

  return (
    <PanelCard
      title="Researcher activity"
      icon={<FlaskConical className="size-3.5 text-primary" aria-hidden />}
      right={<CountChip n={total} tone="live" />}
    >
      {rows.length === 0 ? (
        <EmptyNote label="No research sessions yet." />
      ) : (
        <ul className="divide-y divide-border/40">
          {rows.map((s) => (
            <ResearcherRow key={s.id} session={s} now={now} onOpen={onOpenSession} />
          ))}
        </ul>
      )}
      {total > rows.length && (
        <p className="px-2 pt-2 text-[10px] text-muted-foreground/60">
          Showing the latest {ROW_CAP} of {total} research sessions.
        </p>
      )}
    </PanelCard>
  )
}

function ResearcherRow({
  session,
  now,
  onOpen,
}: {
  session: SessionInfo
  now: number
  onOpen?: (id: string) => void
}) {
  // running = Jerry's busy signal OR the server-truth active map (the
  // ActivityView derivation; the map lives in the workspace store)
  const busy = useNexus((s) => s.busy[session.id] === true)
  const active = useWorkspace((s) => s.activeMap?.[session.id] != null)
  const running = busy || active
  const activityState = useNexus((s) => s.activity[session.id]?.state ?? null)
  const recentTools = useSessionRecentTools(session.id)
  const parentMessages = useNexus((s) =>
    session.parentID
      ? (s.messages[session.parentID] ?? EMPTY_MESSAGES)
      : EMPTY_MESSAGES,
  )

  // delegation description first (the brief's source), session title fallback
  const delegation = useMemo(
    () => findDelegation(parentMessages, session.id),
    [parentMessages, session.id],
  )
  const title =
    delegation?.description ?? session.title ?? "Untitled session"

  const tally = useMemo(() => {
    let internal = 0
    let external = 0
    for (const t of recentTools) {
      const source = researchSourceOf(t.name)
      if (source === "internal") internal += 1
      else if (source === "external") external += 1
    }
    return { internal, external }
  }, [recentTools])

  const kind: RunKind = running
    ? activityState === "awaiting-permission"
      ? "awaiting"
      : "running"
    : activityState === "completed" ||
        activityState === "failed" ||
        activityState === "interrupted"
      ? activityState
      : session.outcome
        ? OUTCOME_LABEL[session.outcome]
        : "idle"

  const content = (
    <>
      <StateDot kind={kind} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{title}</span>
        <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/80">
          {kind} · started {fmtRelative(session.time.created, now)}
        </span>
      </span>
      <SourceTally internal={tally.internal} external={tally.external} />
    </>
  )

  return (
    <li className="nexus-row-in">
      {onOpen ? (
        <button type="button" onClick={() => onOpen(session.id)} className={ROW_CLICK_CLASSES}>
          {content}
        </button>
      ) : (
        <div className={ROW_PLAIN_CLASSES}>{content}</div>
      )}
    </li>
  )
}
