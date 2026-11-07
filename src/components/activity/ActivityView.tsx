// Activity Center (Phase E1): every section is answerable at a glance —
// what's running, what needs me, what's queued, what broke, what finished.
// Purely a subscriber: all data already lives in the nexus/workspace stores
// and arrives via SSE (no poll of its own; Refresh mirrors the Agents-tab
// reconciliation: resync + reconcileSessions + the server-truth active map).
//
// Real data only: tool rows show the CURRENT tool + per-session run counts;
// the store keeps per-session recent tool NAMES (refs only — never
// input/output), surfaced as the expandable strip on active rows. Inbox
// counts exist only for sessions whose inbox has been polled (noted).
// Approvals never gain reply buttons here — PermissionCard is the single
// reply call-site (reviewer gate §12.1); rows navigate to the session.

import { useId, useMemo, useState, type ReactNode } from "react"
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleDashed,
  Gauge,
  Inbox,
  ListTree,
  RefreshCw,
  ShieldAlert,
  Terminal,
} from "lucide-react"

import { useNexus } from "@/store/nexus"
import { useWorkspace } from "@/store/workspace"
import { usePermissionRequests, useSessionRecentTools } from "@/store/selectors"
import { PanelCard } from "@/components/dashboard/PanelCard"
import { useNow } from "@/components/agents/useNow"
import { fmtDuration } from "@/components/agents/AgentListView"

import type { ToolCallRef } from "@/lib/agentState"
import {
  ACTIVITY_STATE_DOT,
  buildActivitySnapshot,
  fmtRelative,
  type ActivityRow,
} from "./activityData"

// ---------------------------------------------------------------------------
// shared row rendering

function AgentChip({ agent }: { agent: string }) {
  return (
    <span className="shrink-0 rounded border border-primary/40 px-1 font-mono text-[9px] text-primary">
      {agent}
    </span>
  )
}

function StateDot({ state }: { state: ActivityRow["state"] }) {
  return (
    <span
      className={"size-1.5 shrink-0 rounded-full " + ACTIVITY_STATE_DOT[state]}
      aria-hidden
    />
  )
}

function PriorityBadge({ row }: { row: ActivityRow }) {
  if (row.priority === "normal") return null
  const tone =
    row.priority === "critical"
      ? "border-destructive/60 text-destructive"
      : row.priority === "high"
        ? "border-warning/60 text-warning"
        : "border-accent/60 text-accent"
  return (
    <span
      className={
        "shrink-0 rounded border px-1 font-mono text-[9px] " + tone
      }
      title={`Jerry-side priority: ${row.priority} (organizational only)`}
    >
      {row.priority}
    </span>
  )
}

/** One navigable session row — shared by most sections. */
function SessionRow({
  row,
  now,
  onOpen,
  trailing,
  detail,
}: {
  row: ActivityRow
  now: number
  onOpen(id: string): void
  /** section-specific middle content (tool name, error text, queue count…) */
  trailing?: ReactNode
  /** optional expandable region rendered under the row INSIDE the li but
   *  OUTSIDE the navigational button — an expand toggle must never nest
   *  inside a button (invalid HTML, breaks activation semantics) */
  detail?: ReactNode
}) {
  return (
    <li className="nexus-row-in">
      <button
        type="button"
        onClick={() => onOpen(row.id)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50"
      >
        <StateDot state={row.state} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium">{row.title}</span>
            <AgentChip agent={row.agent} />
            <PriorityBadge row={row} />
            {row.isSubagent && (
              <span className="shrink-0 rounded border border-accent/50 px-1 font-mono text-[9px] text-accent">
                subagent
              </span>
            )}
          </span>
          {trailing != null && (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/80">
              {trailing}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {row.running
            ? fmtDuration(Math.max(0, now - row.createdAt))
            : fmtRelative(row.updatedAt, now)}
        </span>
      </button>
      {detail != null && detail}
    </li>
  )
}

/** How many calls the expanded strip shows. The store keeps up to 25 refs
 *  per session; the strip stays a glanceable few — the full list is
 *  inspector territory. */
const RECENT_TOOLS_SHOWN = 5

/** Expandable recency strip under an active row: collapsed it is one toggle
 *  line, expanded it lists the last few tool calls most-recent-first — by
 *  reference only (name + event time; the store never keeps input/output).
 *  The chevron rotation is the one CSS transition here, clamped under
 *  prefers-reduced-motion by the global rule in index.css. */
function RecentToolsStrip({
  tools,
  now,
}: {
  tools: ToolCallRef[]
  now: number
}) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  // the store keeps entries most-recent-LAST — display most-recent-FIRST
  const shown = useMemo(() => {
    const out: ToolCallRef[] = []
    for (let i = tools.length - 1; i >= 0 && out.length < RECENT_TOOLS_SHOWN; i--) {
      out.push(tools[i]!)
    }
    return out
  }, [tools])

  return (
    <div className="px-2 pb-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={listId}
        className="inline-flex items-center gap-1 rounded font-mono text-[10px] text-muted-foreground/80 transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
      >
        <ChevronDown
          className={
            "size-3 transition-transform duration-150" +
            (open ? " rotate-180" : "")
          }
          aria-hidden
        />
        {tools.length} recent tool{tools.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul id={listId} className="mt-1 space-y-0.5 border-l border-border/60 pl-4">
          {shown.map((t, i) => (
            <li
              key={`${t.at}-${t.name}-${i}`}
              className="flex items-center justify-between gap-2 font-mono text-[10px]"
            >
              <span className="min-w-0 truncate text-foreground/90">{t.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground/70">
                {fmtRelative(t.at, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return (
    <p className="px-2 py-4 text-center text-xs text-muted-foreground">
      {label}
    </p>
  )
}

function CountChip({ n, tone }: { n: number; tone?: "live" | "warn" | "error" }) {
  if (n === 0) return null
  const cls =
    tone === "error"
      ? "border-destructive/50 text-destructive"
      : tone === "warn"
        ? "border-warning/50 text-warning"
        : "border-primary/50 text-primary"
  return (
    <span className={"rounded border px-1.5 font-mono text-[10px] " + cls}>
      {n}
    </span>
  )
}

// ---------------------------------------------------------------------------
// sections

/** One Active-panel row plus its recency strip. The recentTools hook lives
 *  HERE, not in shared SessionRow, so only active rows subscribe — a tool
 *  event updates one row's strip without touching the others (the view root
 *  still re-renders on the activity slice, as before — the hook narrows the
 *  subscription, not the tree's existing activity dependency). */
function ActiveRow({
  row,
  now,
  onOpen,
}: {
  row: ActivityRow
  now: number
  onOpen(id: string): void
}) {
  const recentTools = useSessionRecentTools(row.id)
  return (
    <SessionRow
      row={row}
      now={now}
      onOpen={onOpen}
      trailing={row.currentTool ? `▸ ${row.currentTool}` : null}
      detail={
        recentTools.length > 0 ? (
          <RecentToolsStrip tools={recentTools} now={now} />
        ) : null
      }
    />
  )
}

function ActivePanel({
  rows,
  now,
  onOpen,
}: {
  rows: ActivityRow[]
  now: number
  onOpen(id: string): void
}) {
  return (
    <PanelCard
      title="Active sessions"
      icon={<Activity className="size-3.5 text-primary" aria-hidden />}
      right={<CountChip n={rows.length} tone="live" />}
    >
      {rows.length === 0 ? (
        <Empty label="No active sessions — nothing is running." />
      ) : (
        <ul className="divide-y divide-border/40">
          {rows.map((r) => (
            <ActiveRow key={r.id} row={r} now={now} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </PanelCard>
  )
}

function SubagentsPanel({
  groups,
  onOpen,
}: {
  groups: { parent: ActivityRow; children: ActivityRow[] }[]
  onOpen(id: string): void
}) {
  return (
    <PanelCard
      title="Running agents"
      icon={<ListTree className="size-3.5 text-primary" aria-hidden />}
      right={<CountChip n={groups.length} tone="live" />}
    >
      {groups.length === 0 ? (
        <Empty label="No subagent activity — delegations appear here while they run." />
      ) : (
        <ul className="divide-y divide-border/40">
          {groups.map((g) => (
            <li key={g.parent.id} className="nexus-row-in px-2 py-1.5">
              <button
                type="button"
                onClick={() => onOpen(g.parent.id)}
                className="flex w-full items-center gap-2 text-left transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50"
              >
                <ListTree className="size-3.5 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {g.parent.title}
                </span>
                <CountChip n={g.children.length} tone="live" />
              </button>
              <ul className="mt-1 space-y-0.5 border-l border-border/60 pl-4">
                {g.children.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(c.id)}
                      className="flex w-full items-center gap-2 py-0.5 text-left transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50"
                    >
                      <StateDot state={c.state} />
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        {c.title}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                        {c.currentTool ?? c.state}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  )
}

function QueuedPanel({
  rows,
  now,
  onOpen,
}: {
  rows: ActivityRow[]
  now: number
  onOpen(id: string): void
}) {
  return (
    <PanelCard
      title="Queued operations"
      icon={<Inbox className="size-3.5 text-warning" aria-hidden />}
      right={<CountChip n={rows.length} tone="warn" />}
    >
      {rows.length === 0 ? (
        <>
          <Empty label="No sessions with queued prompts." />
          <p className="px-2 pb-2 text-center text-[10px] text-muted-foreground/60">
            Counts appear once a session's inbox has been polled (Agents
            inspector) — an empty list is not a guarantee.
          </p>
        </>
      ) : (
        <ul className="divide-y divide-border/40">
          {rows.map((r) => (
            <SessionRow
              key={r.id}
              row={r}
              now={now}
              onOpen={onOpen}
              trailing={
                <span className="inline-flex items-center gap-1">
                  <Inbox className="size-3" aria-hidden />
                  {r.inboxCount} queued prompt{(r.inboxCount ?? 0) === 1 ? "" : "s"}
                </span>
              }
            />
          ))}
        </ul>
      )}
    </PanelCard>
  )
}

function ApprovalsPanel({
  requests,
  sessionTitles,
  onOpen,
}: {
  requests: { id: string; sessionID: string; action: string; resources: string[]; message?: string }[]
  sessionTitles: Record<string, string>
  onOpen(id: string): void
}) {
  return (
    <PanelCard
      title="Pending approvals"
      icon={<ShieldAlert className="size-3.5 text-warning" aria-hidden />}
      right={<CountChip n={requests.length} tone="warn" />}
    >
      {requests.length === 0 ? (
        <Empty label="No pending approvals — nothing is waiting on you." />
      ) : (
        <ul className="divide-y divide-border/40">
          {requests.map((req) => (
            <li key={req.id} className="nexus-row-in">
              <button
                type="button"
                onClick={() => onOpen(req.sessionID)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50"
              >
                <ShieldAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {sessionTitles[req.sessionID] ?? "Unknown session"}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground/80">
                    {req.action}
                    {req.resources.length > 0
                      ? ` · ${req.resources.length} resource${req.resources.length === 1 ? "" : "s"}`
                      : ""}
                    {req.message ? ` · ${req.message}` : ""}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">
                  open →
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  )
}

function ToolsPanel({
  rows,
  now,
  onOpen,
}: {
  rows: ActivityRow[]
  now: number
  onOpen(id: string): void
}) {
  return (
    <PanelCard
      title="Tool executions"
      icon={<Terminal className="size-3.5 text-primary" aria-hidden />}
      right={<CountChip n={rows.length} tone="live" />}
    >
      {rows.length === 0 ? (
        <Empty label="No tool activity yet." />
      ) : (
        <>
          <ul className="divide-y divide-border/40">
            {rows.map((r) => (
              <SessionRow
                key={r.id}
                row={r}
                now={now}
                onOpen={onOpen}
                trailing={
                  <>
                    {r.currentTool ? `▸ ${r.currentTool}` : "idle"}
                    {" · "}
                    {r.toolsRun} tool call{r.toolsRun === 1 ? "" : "s"} this run
                  </>
                }
              />
            ))}
          </ul>
          <p className="px-2 pt-2 text-[10px] text-muted-foreground/60">
            Counts are run-scoped; recent tool NAMES are kept session-wide
            (refs only, never input/output) — see the strip on active rows.
          </p>
        </>
      )}
    </PanelCard>
  )
}

function ErrorsPanel({
  rows,
  now,
  onOpen,
}: {
  rows: ActivityRow[]
  now: number
  onOpen(id: string): void
}) {
  return (
    <PanelCard
      title="Errors"
      icon={<CircleAlert className="size-3.5 text-destructive" aria-hidden />}
      right={<CountChip n={rows.length} tone="error" />}
    >
      {rows.length === 0 ? (
        <Empty label="No errors — all quiet." />
      ) : (
        <ul className="divide-y divide-border/40">
          {rows.map((r) => (
            <SessionRow
              key={r.id}
              row={r}
              now={now}
              onOpen={onOpen}
              trailing={
                <span className="text-destructive/90">
                  {r.lastError ?? r.state}
                </span>
              }
            />
          ))}
        </ul>
      )}
    </PanelCard>
  )
}

function CompletedPanel({
  rows,
  now,
  onOpen,
}: {
  rows: ActivityRow[]
  now: number
  onOpen(id: string): void
}) {
  return (
    <PanelCard
      title="Recently finished"
      icon={<CheckCircle2 className="size-3.5 text-success/80" aria-hidden />}
      right={<CountChip n={rows.length} />}
    >
      {rows.length === 0 ? (
        <Empty label="Nothing has finished yet." />
      ) : (
        <ul className="divide-y divide-border/40">
          {rows.map((r) => (
            <SessionRow
              key={r.id}
              row={r}
              now={now}
              onOpen={onOpen}
              trailing={
                <span className="inline-flex items-center gap-1">
                  {r.state === "interrupted" ? (
                    <CircleDashed className="size-3 text-warning/80" aria-hidden />
                  ) : (
                    <CheckCircle2 className="size-3 text-success/80" aria-hidden />
                  )}
                  {r.state}
                  {r.projectPath ? ` · ${r.projectPath}` : ""}
                </span>
              }
            />
          ))}
        </ul>
      )}
    </PanelCard>
  )
}

function StatsPanel({
  stats,
  projectName,
}: {
  stats: {
    activeCount: number
    toolsRunTotal: number
    errorCount: number
    approvalCount: number
    queuedSessionCount: number
    completedCount: number
  }
  projectName: string | null
}) {
  const cells: [string, number][] = [
    ["active", stats.activeCount],
    ["tool calls", stats.toolsRunTotal],
    ["errors", stats.errorCount],
    ["approvals", stats.approvalCount],
    ["queued sessions", stats.queuedSessionCount],
    ["completed", stats.completedCount],
  ]
  return (
    <PanelCard
      title="Current project + totals"
      icon={<Gauge className="size-3.5 text-muted-foreground/70" aria-hidden />}
    >
      <p className="mb-3 truncate font-mono text-xs text-foreground/90">
        <span className="text-muted-foreground/70">project · </span>
        {projectName ?? "none selected"}
      </p>
      <dl className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {cells.map(([label, n]) => (
          <div
            key={label}
            className="rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5"
          >
            <dt className="font-mono text-[9px] tracking-wide text-muted-foreground/70 uppercase">
              {label}
            </dt>
            <dd className="font-mono text-sm tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[10px] text-muted-foreground/60">
        Raw counts from the live session store — no derived rates.
      </p>
    </PanelCard>
  )
}

// ---------------------------------------------------------------------------

export function ActivityView({
  onOpenSession,
}: {
  onOpenSession(id: string): void
}) {
  const sessions = useNexus((s) => s.sessions)
  const busy = useNexus((s) => s.busy)
  const activity = useNexus((s) => s.activity)
  const priorities = useNexus((s) => s.priorities)
  const activeProjectId = useNexus((s) => s.activeProjectId)
  const projects = useNexus((s) => s.projects)
  const permissionRequests = usePermissionRequests()
  const activeMap = useWorkspace((s) => s.activeMap)
  const inboxCounts = useWorkspace((s) => s.inboxCounts)

  const now = useNow(1000)
  const [refreshing, setRefreshing] = useState(false)

  const snap = useMemo(
    () =>
      buildActivitySnapshot({
        sessions,
        busy,
        activity,
        priorities,
        activeMap,
        inboxCounts,
        permissionRequests,
        projects,
      }),
    [sessions, busy, activity, priorities, activeMap, inboxCounts, permissionRequests, projects],
  )

  // session titles for the approvals rows (rows already carry them; this
  // lookup only needs ids → titles)
  const sessionTitles = useMemo(() => {
    const out: Record<string, string> = {}
    for (const req of permissionRequests) {
      out[req.sessionID] =
        sessions[req.sessionID]?.title || "Untitled session"
    }
    return out
  }, [permissionRequests, sessions])

  const activeProject = activeProjectId
    ? (projects.find((p) => p.id === activeProjectId) ?? null)
    : null

  /** Manual refresh — mirrors the Agents-tab reconciliation set. */
  const refresh = () => {
    setRefreshing(true)
    void Promise.all([
      useWorkspace.getState().refreshActiveMap(),
      useNexus.getState().reconcileSessions(),
      useNexus.getState().resync(),
    ]).finally(() => setRefreshing(false))
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1360px] p-5 pb-10">
        <div className="mb-4 flex items-center gap-3 px-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Activity className="size-4 text-primary" aria-hidden />
            Activity
          </h1>
          <span className="font-mono text-[10px] tracking-wider text-muted-foreground/80 uppercase">
            live · event-driven
          </span>
          {/* glance line: the three counts that decide "do I need to act?" —
              quiet at zero so an all-clear reads as no noise */}
          <span className="min-w-0 truncate font-mono text-[10px] tabular-nums text-muted-foreground/60">
            {snap.stats.activeCount} running
            {snap.stats.approvalCount > 0 &&
              ` · ${snap.stats.approvalCount} awaiting you`}
            {snap.stats.errorCount > 0 &&
              ` · ${snap.stats.errorCount} error${snap.stats.errorCount === 1 ? "" : "s"}`}
          </span>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors duration-150 hover:bg-secondary/50 hover:text-foreground disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            aria-label="Refresh activity (re-sync with the server)"
            title="Refresh — re-sync with the server"
          >
            <RefreshCw
              className={"size-3.5" + (refreshing ? " animate-spin" : "")}
              aria-hidden
            />
          </button>
        </div>

        {/* items-start + h-auto: list panels keep their natural height — an
            empty section must not stretch into a hollow box beside a tall one
            (PanelCard's h-full is for the dashboard's equal-height chart grid) */}
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2 [&>*]:h-auto">
          <div className="xl:col-span-2">
            <ActivePanel rows={snap.active} now={now} onOpen={onOpenSession} />
          </div>
          <ApprovalsPanel
            requests={permissionRequests}
            sessionTitles={sessionTitles}
            onOpen={onOpenSession}
          />
          <QueuedPanel rows={snap.queued} now={now} onOpen={onOpenSession} />
          <SubagentsPanel groups={snap.subagentRuns} onOpen={onOpenSession} />
          <ToolsPanel rows={snap.toolActivity} now={now} onOpen={onOpenSession} />
          <ErrorsPanel rows={snap.errors} now={now} onOpen={onOpenSession} />
          <CompletedPanel rows={snap.completed} now={now} onOpen={onOpenSession} />
          <div className="xl:col-span-2">
            <StatsPanel
              stats={snap.stats}
              projectName={activeProject ? (activeProject.name || activeProject.canonical) : null}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
