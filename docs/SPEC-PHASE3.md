# OpenCode Nexus — Phase 3 Implementation Spec

**Scope:** agent/subagent activity graph (xyflow), session history browser, project management + worktrees, memory visibility (read-only markdown), permission inbox, skills/plugins/MCP status panels, plus the Phase 1 leftover basket (sidebar child sessions, synthetic message dividers, T-hardening drills).
**Pipeline position:** Architect spec → Developer (this doc is the build contract) → Reviewer gate (QA + security) → Playwright visual pass.
**Repo root:** `/home/mg-12623-8/ai-workbench/projects/NExus` (branch master). All paths relative to repo root.
**Builds on SPEC-PHASE1.md** (§1 layout, §4 events, §6 tokens, §8 components) **and SPEC-PHASE2.md** (MainTabs view switcher, telemetry middleware pattern, EMPTY_* selector rules). Task numbering continues from T19.
**Ground truth verified 2026-11-05** against the live v2.2.0 service through the dev proxy (read-only GETs), the v2.2.0 OpenAPI (`/tmp/opencode/nexus-openapi.json`, 130 paths), and `/tmp/opencode/nexus-api-samples/`. Where this doc contradicts API-NOTES.md, **this doc wins**.
---
## 0. Verified ground truth & corrections

1. **There is no `session.child.*` event type.** The full `types` enum of `GET /api/event` (97 entries, extracted verbatim) contains no child/subagent-specific event. The real-time subagent signals are:
   - `session.created` — fires for **child sessions too**; its payload is a Session.Info carrying `parentID`, `agent`, `title` (verified in `sessions.json`: 6 of 16 sessions are children with `parentID`, e.g. agents "reviewer", "developer", "ui-designer", "architect").
   - `session.execution.started / .succeeded / .failed / .interrupted` — fire per session **including children** (the Phase 1 reducer already tracks `busy` for every sessionID, active or not).
   - `session.usage.updated`, `session.renamed`, `session.idle`, `session.status` — all carry plain `sessionID`.
   The Phase 1 store therefore **already ingests everything the graph needs**; the graph is a projection of `sessions` + `busy`, not a new event pipeline.
2. **OpenAPI does not document per-event payloads** (the only occurrence of event type strings is the `types` query-param enum; `V2EventEncoded` is an opaque string). Event data shapes in this spec are from live captures, same discipline as Phase 1.
3. **`GET /api/session` is a full query engine** (verified live): query params `limit` (string, default newest 50), `order` (asc|desc), **`search`** (string — live test `?search=notes` matched titles), **`parentID`** (Session.ID or the literal string `"null"` — live test returned only root sessions), `archived` ("true"|"false"), `directory` (AbsolutePath), `project` (Project.ID), `subpath`, `cursor`. Response = `SessionsResponse` = `{ data: Session.Info[], cursor: { previous: string|null, next: string|null } }` (cursor required in schema; opaque `SessionsCursor` passed through verbatim). ⚠ The Phase 1 client (`api.listSessions`) reads this as a bare array via `unwrap()` — that still works because `unwrap` unwraps `{data}`, but the cursor is currently **discarded**. Phase 3 adds a cursor-aware variant (§3).
4. **Permissions (exact schemas):**
   - `GET /api/permission/request` (optional `location` query = `{directory}`) → `{ location, data: Permission.Request[] }` (verified live, currently empty).
   - `Permission.Request` = `{ id, sessionID, action, resources: string[], save?: string[], metadata?: object, source?: { type: "tool", messageID, id }, message?: string }`.
   - `POST /api/session/{sessionID}/permission/{requestID}/reply` body `{ decision: Permission.Reply, message?: string|null }` → **204**. `Permission.Reply = "once" | "always" | "reject"`. **`once`/`always` EXECUTE the pending action; `always` additionally persists an allow rule. `reject` denies it.**
   - `GET /api/session/{sessionID}/permission` lists a session requests; `GET /api/session/{sessionID}/permission/{requestID}` gets one.
   - SSE: `permission.asked`, `permission.replied`, and `session.permissions` all exist in the event enum.
5. **`GET /api/fs/read/{path}` returns raw file bytes, not JSON** (OpenAPI: application/octet-stream; live: `text/markdown`). Both forms verified live:
   - absolute URL-encoded path: `/api/fs/read/%2Fhome%2Fmg-12623-8%2F.config%2Fopencode%2FMEMORY.md` → 200, 5885 bytes;
   - relative path + location query: `/api/fs/read/.config/opencode/MEMORY.md?location[directory]=/home/mg-12623-8` → 200.
   Missing/unreadable → 404 `{"_tag":"FileNotFoundError"}`. A relative `../../` traversal attempt 404d, and `/etc/hostname` (absolute) returned 404 FileNotFoundError — the server applies its own path validation. **The client must use `res.text()`, not the JSON `request<T>` wrapper.** All five memory/workspace files verified 200: `~/.config/opencode/MEMORY.md`, `~/.config/opencode/USER.md`, `~/Documents/.opencode/memory/DECISIONS.md`, `~/Documents/.opencode/TEAM.md`, `~/Documents/.opencode/agents/architect.md` (agent roster readable via the same endpoint — include it, it is small and useful).
6. **Worktrees:** `GET /api/worktree?projectID=<Project.ID>` (**required** param) → **bare array** of `Worktree.Directory` = `{ directory: AbsolutePath, strategy?: string }` (live: `[]` for the Documents project). Mutations exist: `POST /api/worktree` (`Worktree.CreateInput`: `projectID` required, optional `from`, `branch`, `directory`, `name`) and `DELETE /api/worktree` (`Worktree.RemoveInput`: `projectID`, `directory`, `force` **all required**) → 204. `POST /api/worktree/refresh` body `{ projectID }` → 204. SSE: `worktree.updated`, `worktree.resolved`.
7. **Extensions (all `{location, data: []}` envelopes, all read-only):**
   - `GET /api/skill` → `Skill.Info[]` = `{ id, name, description?, autoinvoke?, path, content }` — `content` is the **full markdown body** (sample: 7 skills, 56 KB total).
   - `GET /api/plugin` → `Plugin.Info[]` = `{ id?, source: {type:"builtin"}|{type:"package",target,version?,outdated?,updating?}|{type:"local",path}|{type:"sdk"}, features: {server?,tui?,rpc?,gui?}, state: {status:"active"}|{status:"failed",error,ref?} }` (sample: 92 plugins, mostly builtin).
   - `GET /api/mcp` → `Mcp.Server[]` = `{ name, status: {status:"connected"}|{status:"pending"}|{status:"disabled"}|{status:"failed",error?}|{status:"needs_auth",error?}, title?, integrationID? }` (sample: motion + playwright, both "pending"). SSE: `mcp.status.changed`.
8. **`GET /api/session/active`** → `{ data: { "ses_…": { type: "running" } } }` — a server-truth map of currently-running sessions (verified live). Cheap one-shot; use it as the graph authoritative "running" signal and as the SSE-gap fallback.
9. **`GET /api/project`** (bare array, verified live, 3 projects) → `Project` = `{ id, canonical, vcs?, name?, icon?, commands?, time: {created, updated, active, archived?}, sandboxes: string[] }`. The Phase 1 `ProjectInfo` type is a subset — extend it, do not replace it.
10. **Agent mode taxonomy** (`Agent.Info.mode`): `"subagent" | "primary" | "all"` — the agents list already in the nexus store classifies graph nodes (e.g. "build" primary; "general", "explore" subagent).
11. **Phase 1/2 code facts this spec extends (do not re-imagine):** `applyEvent` is a pure reducer with a `pendingRefetch: RefetchTarget[]` marker consumed by `scheduleRefetch` in `nexus.ts`; `session.created` upserts **any** session (children included) into `sessions`/`sessionOrder`; `MainTabs` owns `MainView = "chat" | "dashboard"` with `localStorage["nexus.mainView"]`; `AppShell` lazy-mounts `DashboardView` on first open and keeps `ChatPanel` hidden-mounted; `StatusRail` renders a `pendingPermissions` badge placeholder; `pendingPermissions` exists in the nexus store and increments on `permission.asked`. xyflow is installed as **`@xyflow/react ^12.12.1`**.
12. **Phase 2 gotcha that applies to the graph:** charts inside `display:none` containers warn "width(0)/height(0)" on every re-render (recharts precedent). xyflow measures the same way — **the graph canvas must unmount when its tab is hidden** (state lives in the store, remount is cheap), not sit hidden like ChatPanel.
---
## 1. Navigation model — DECIDED: MainTabs gains four flat tabs

`MainView` becomes `"chat" | "dashboard" | "agents" | "history" | "projects" | "system"`. Six tabs, one row (≈540 px at typical tab width — fits the ≥1000 px main area; below 900 px the tab row scrolls horizontally).

Justification:
- The six views are **peer-level destinations** (monitor / watch / browse / manage / inspect) used at independent cadences — a second-level nav would add a click to every switch and hide the showpiece (Agents) behind Dashboard.
- The only true sub-topics are inside **System** (extensions status + memory docs — both are "inspect the OpenCode installation"), and those get a small segmented control **inside** the view, not a second nav tier.
- **Permissions deliberately get NO tab.** Approval is event-driven and time-critical: the user is usually watching Chat or Agents when an agent blocks. It ships as a **slide-over drawer** reachable from the rail badge (already rendered) and a shield button in the MainTabs row, overlaying any view.
- Persistence: `localStorage["nexus.mainView"]` keeps working (values are just strings); unknown stored values fall back to "chat".

Mounting rules (extend the AppShell pattern):
- `ChatPanel` stays mounted + `hidden` (unchanged, Phase 2 rule).
- `DashboardView`: lazy-mount on first open, stays mounted with `visible` prop (unchanged).
- `AgentsView`, `HistoryView`, `ProjectsView`, `SystemView`: **lazy-mount on first open AND unmount on tab leave** (`{mounted && view === "agents" && <AgentsView/>}`). Rationale: xyflow measures zero in hidden containers (§0.12); history/projects/system hold no streaming state worth keeping alive; their stores (`workspace.ts`) persist the data so remounts are instant.
- Every view is wrapped in `React.lazy(() => import(...))` so xyflow and view code never enter the main chunk (§12 risk 3).
---
## 2. Agents view — live agent/subagent graph

### 2.1 Data model (pure projection, `src/components/agents/graph.ts`)

~~~ts
export type AgentNodeStatus = "running" | "idle" | "succeeded" | "failed" | "interrupted"

export interface AgentNode {
  id: string              // sessionID
  parentId: string | null
  agent: string           // "build", "reviewer", … (fallback "build")
  agentMode: "primary" | "subagent" | "all"  // resolved from the agents list
  title: string
  status: AgentNodeStatus
  tokens: number          // sum of the five TokenUsage classes
  cost: number
  createdAt: number
  updatedAt: number
  depth: number           // 0 = root
}

export interface AgentEdge { id: string; source: string; target: string }

export function buildGraph(
  sessions: Record<string, SessionInfo>,
  busy: Record<string, boolean>,
  activeMap: Record<string, { type: "running" }> | null,  // from GET /api/session/active
  scopeProjectId: string | null,                          // null = all projects
): { nodes: AgentNode[]; edges: AgentEdge[] }

export function layoutForest(
  nodes: AgentNode[],
  edges: AgentEdge[],
): Map<string, { x: number; y: number }>   // deterministic tidy-forest, §2.3
~~~

Status derivation (in priority order): `busy[sid] === true` → "running"; else `activeMap[sid]` → "running"; else `outcome ?? "idle"`. Tokens/cost may be undefined on bare sessions (Phase 1 guard precedent) — default 0.

### 2.2 Event → graph mapping table

All SSE rows are **free** — the existing reducer already applies them; the graph just re-derives on store change.

| Signal | Source | Graph effect | New code? |
| --- | --- | --- | --- |
| `session.created` with `data.parentID` | SSE | new child node + edge parent→child appears | none (store already upserts) |
| `session.created` without `parentID` | SSE | new root node | none |
| `session.execution.started` | SSE | node → running (busy map) | none |
| `session.execution.succeeded/.failed/.interrupted` | SSE | busy → false; node shows outcome **after** the next session refresh (event payload may lack `outcome`) | poll heals (below) |
| `session.usage.updated` | SSE | node tokens/cost live | none |
| `session.renamed` | SSE | node label | none |
| `session.idle` / `session.status` | SSE | running → idle | none |
| `session.deleted` | SSE | node + edge removed | none (reducer handles) |
| `server.connected` after reconnect | SSE state | full graph rebuild | rebuild from store |
| 5 s poll while Agents tab visible | `GET /api/session?limit=200` + `GET /api/session/active` | reconciliation: spawns missed during SSE gaps, outcome/idle truth, removes vanished sessions | **new**, the only poll |

**Honest fallback (required by the coordinator):** the OpenAPI does not document event payloads, so "every child spawn emits a `session.created` carrying `parentID`" is a live-behavior assumption, not a schema fact. The 5 s reconciliation poll (Agents-tab-visible only, two cheap GETs) is the safety net and also heals terminal `outcome` values that execution events do not carry. If the SSE path proves complete in the T25 acceptance drill, the poll interval may be relaxed to 10 s — never removed.

Scope: default = sessions of `activeProjectId`; a toggle switches to all projects. Fetch for the graph: `api.listSessionsQuery({ limit: "200" })` (no directory filter — children across the workspace must appear).

### 2.3 Layout — DECIDED: hand-rolled tidy forest, no dagre

`layoutForest` (~60 lines, deterministic, pure):
1. Build parent→children maps from `edges`; orphaned `parentID`s (parent not in scope) promote the child to a root.
2. Compute `depth` per node (longest parent chain; the data is a shallow forest — observed max depth 1, code handles more).
3. Roots ordered by `createdAt` desc, laid out left→right at x = i × 300. Leaves of each tree stack vertically (y = running cursor × 130); parent y = mean of its children y. Per-depth x offset: root 300 px, depth ≥ 1 +240 px.
4. Return positions; xyflow `fitView` handles the viewport.

dagre/elk rejected: this is a forest of shallow trees with one edge kind — no cycles, no dense routing — so a dependency buys nothing. Revisit only if subagent-of-subagent graphs with crossing edges become common (note in §12).

### 2.4 Canvas & interaction (`@xyflow/react`)

- `AgentGraphCanvas.tsx` — default export (React.lazy target). `<ReactFlow nodes edges nodeTypes={{ agent: AgentNodeCard }} fitView proOptions={{ hideAttribution: false }} minZoom={0.2}>`. Background dots + Controls + MiniMap (node color = status). Edge type `smoothstep`, `animated` when source-or-target is running.
- `AgentNodeCard.tsx` — custom node: agent name + mode chip (subagent = violet accent, primary = cyan), truncated title, status ring (running = pulsing `--glow-primary`; failed = `--destructive` border), mono token count. `Handle`s top (target) / bottom (source).
- Click node → select in `workspace` store → `AgentDetailPanel` (right side, 280 px): full title, agent, project path, duration (`(time.idle ?? time.updated) − time.created`), tokens/cost, outcome chip, **"Open in Chat"** button → `setActiveSession(id)` + `changeView("chat")`.
- prefers-reduced-motion: no pulsing/animated edges (static status colors).
- **Unmount on tab leave** (§1); graph state (selection, scope, activeMap) lives in the workspace store so remount is lossless.
---
## 3. API client extensions — types.ts + client.ts

### types.ts (new exports, contractual)

~~~ts
export interface SessionQuery {
  limit?: string; order?: "asc" | "desc"; search?: string
  parentID?: string | "null"; archived?: "true" | "false"
  directory?: string; project?: string; cursor?: string
}

/** SessionsResponse.cursor — opaque, pass through verbatim. */
export interface SessionCursor { previous: string | null; next: string | null }

export type PermissionReply = "once" | "always" | "reject"
export interface PermissionRequest {
  id: string; sessionID: string; action: string; resources: string[]
  save?: string[]; metadata?: Record<string, unknown>
  source?: { type: "tool"; messageID: string; id: string }
  message?: string
}

export interface WorktreeDirectory { directory: string; strategy?: string }

export interface SkillInfo { id: string; name: string; description?: string;
  autoinvoke?: boolean; path: string; content: string }

export type PluginSource =
  | { type: "builtin" } | { type: "sdk" }
  | { type: "package"; target: string; version?: string; outdated?: true; updating?: true }
  | { type: "local"; path: string }
export interface PluginInfo {
  id?: string; source: PluginSource
  features: { server?: true; tui?: true; rpc?: true; gui?: true }
  state: { status: "active" } | { status: "failed"; error: string; ref?: string }
}

export type McpStatus =
  | { status: "connected" } | { status: "pending" } | { status: "disabled" }
  | { status: "failed"; error?: string } | { status: "needs_auth"; error?: string }
export interface McpServerInfo { name: string; status: McpStatus; title?: string; integrationID?: string }

// extend the existing ProjectInfo (§0.9) — additive fields only:
//   vcs?: unknown; name?: string; icon?: unknown; sandboxes?: string[]
~~~

### client.ts (new api.* methods — all through `request<T>`/`unwrap` except fs/read)

~~~ts
/** Cursor-aware session query (Phase 1 listSessions stays as-is for the sidebar). */
listSessionsQuery(q: SessionQuery): Promise<{ sessions: SessionInfo[]; cursor: SessionCursor }>
// GET /api/session?… — unwrap gives { data, cursor }; map data → sessions

listPermissionRequests(directory?: string): Promise<PermissionRequest[]>
// GET /api/permission/request (+ ?location[directory]=… when given)

listSessionPermissions(sessionID: string): Promise<PermissionRequest[]>
// GET /api/session/{id}/permission

replyPermission(sessionID: string, requestID: string,
  decision: PermissionReply, message?: string): Promise<void>
// POST …/permission/{requestID}/reply — body { decision, message? }; 204

listWorktrees(projectID: string): Promise<WorktreeDirectory[]>
// GET /api/worktree?projectID=… (bare array)

refreshWorktrees(projectID: string): Promise<void>
// POST /api/worktree/refresh { projectID }; 204

listSkills(): Promise<SkillInfo[]>         // GET /api/skill
listPlugins(): Promise<PluginInfo[]>       // GET /api/plugin
listMcpServers(): Promise<McpServerInfo[]> // GET /api/mcp
listActiveSessions(): Promise<Record<string, { type: "running" }>>
// GET /api/session/active → unwrap gives the { ses_…: {type:"running"} } map

/** Raw file text — BYPASSES request<T>: fs/read returns bytes, not JSON envelopes.
 *  Build the URL by string concatenation: "/api/fs/read/" + encodeURIComponent(absolutePath).
 *  On ok return res.text(); on !ok parse the {_tag} body and throw ApiError. */
readFsFile(absolutePath: string): Promise<string>
~~~
---
## 4. State — nexus extensions + new workspace store

### 4.1 nexus store (surgical additions only)

- `permissionRequests: PermissionRequest[]` (initial `[]`).
- `RefetchTarget` gains **"permissions"**; `scheduleRefetch` fetches `api.listPermissionRequests()` when targeted (same 500 ms debounce).
- `events.ts` reducer additions (pure):
  - `permission.asked` → `pendingPermissions + 1` **plus** refetch marker "permissions" (the count alone cannot render the drawer list);
  - `permission.replied` → refetch marker "permissions" (authoritative removal);
  - `session.permissions` → refetch marker "permissions" (defensive; enum-verified type).
- New action `replyPermission(sessionID, requestID, decision, message?)`: optimistic removal of the request from `permissionRequests` + `pendingPermissions` decrement → POST → on failure restore + toast. **No other code path may call `api.replyPermission`** (reviewer gate item).
- `resync()` fetches the permission list once after the existing fetches (so the drawer is populated on boot/reconnect).

### 4.2 New store — `src/store/workspace.ts` (zustand, NOT a nexus slice)

Separate store, same rationale as Phase 2 telemetry store: different cadence (on-demand tab data), keeps the nexus event path untouched.

~~~ts
export type MemoryFileId = "memory" | "user" | "decisions" | "team" | "agent-architect"
export interface MemoryFileEntry {
  status: "idle" | "loading" | "ok" | "missing" | "error"
  content: string | null; fetchedAt: number | null
}

export interface WorkspaceState {
  // history browser
  historyQuery: string; historyProjectId: string | null; historyArchived: boolean
  historyResults: SessionInfo[]; historyCursor: SessionCursor | null
  historyLoading: boolean; historyError: string | null
  searchHistory(opts?: { query?: string; projectId?: string | null; archived?: boolean }): Promise<void>
  loadMoreHistory(): Promise<void>
  // graph support
  graphScopeAll: boolean; activeMap: Record<string, { type: "running" }> | null
  selectedGraphNode: string | null
  toggleGraphScopeAll(): void; refreshActiveMap(): Promise<void>
  // projects
  worktrees: Record<string, WorktreeDirectory[]>
  worktreeStatus: Record<string, "idle" | "loading" | "error">
  loadWorktrees(projectID: string): Promise<void>
  refreshWorktrees(projectID: string): Promise<void>
  // system / extensions
  skills: SkillInfo[] | null; plugins: PluginInfo[] | null; mcpServers: McpServerInfo[] | null
  extensionsStatus: "idle" | "loading" | "error"
  loadExtensions(force?: boolean): Promise<void>
  // memory
  memory: Record<MemoryFileId, MemoryFileEntry>
  loadMemoryFile(id: MemoryFileId): Promise<void>
}
export const useWorkspace = create<WorkspaceState>()(/* … */)
~~~

Selectors follow the Phase 2 rule: module-level `EMPTY_WORKTREES`, `EMPTY_HISTORY` constants; components select stable references (`s.historyResults ?? EMPTY_HISTORY`), never freshly-built arrays. The **graph deliberately has no store slice**: `AgentGraphView` selects `useNexus(s => s.sessions)` and `useNexus(s => s.busy)` (stable object references, patched not rebuilt) and derives nodes/edges in `useMemo` — building arrays inside a selector would loop `useSyncExternalStore` (zustand v5 hazard).

### 4.3 Memory file table (client-side whitelist — the ONLY allowed fs/read paths)

~~~ts
export const MEMORY_FILES: { id: MemoryFileId; label: string; path: string }[] = [
  { id: "memory",          label: "MEMORY.md",        path: "/home/mg-12623-8/.config/opencode/MEMORY.md" },
  { id: "user",            label: "USER.md",          path: "/home/mg-12623-8/.config/opencode/USER.md" },
  { id: "decisions",       label: "DECISIONS.md",     path: "/home/mg-12623-8/Documents/.opencode/memory/DECISIONS.md" },
  { id: "team",            label: "TEAM.md",          path: "/home/mg-12623-8/Documents/.opencode/TEAM.md" },
  { id: "agent-architect", label: "agents/architect.md", path: "/home/mg-12623-8/Documents/.opencode/agents/architect.md" },
]
~~~

Absolute paths are machine-local config, same precedent as Phase 2 `NEXUS_LLM_URL` (documented in README). No user-editable path input exists anywhere in the UI (§12 risk 2).
---
## 5. Permission inbox (drawer, not a tab)

### 5.1 Components

- `PermissionDrawer.tsx` — right slide-over (420 px, motion slide 300 ms, Esc closes, focus-trapped). Header: "Permission requests" + live count. List of `PermissionCard`s; empty state: "No pending requests — agents run freely within their rules."
- `PermissionCard.tsx` — props `{ request: PermissionRequest; onReply(decision, message?) }`. Shows: `action` (mono chip), `resources[]` (mono, wrapped, truncated beyond 5 with a "+n more" expander), `message?` (blockquote), `source` ("tool call · message msg_…123"), requesting session title (resolved from `sessions[request.sessionID]?.title ?? sessionID`). Buttons: **Reject** (secondary/destructive outline) and **Approve once** (primary). **"Always allow"** is a third, visually muted button requiring a second confirming click on an inline warning ("adds a saved rule — future identical requests run without asking") before it fires `"always"`. Default button focus = Reject (safest).
- Rail badge (existing `pendingPermissions` block) becomes a **button** that opens the drawer; a shield icon with count badge joins the MainTabs row too.

### 5.2 Data flow & safety rules

1. Open → `api.listPermissionRequests()` (no directory param — §12 open question (a)) → populate; refresh on every "permissions" refetch marker.
2. `permission.asked` (any session) → badge count + debounced refetch; drawer re-renders. `permission.replied` → refetch (removes authoritatively, healing optimistic removals).
3. Reply → optimistic remove → POST → 204 silently; ApiError → restore + toast.
4. **HARD RULES (reviewer gate):** no auto-reply anywhere (no timers, no default-on-timeout, no "approve all"); every reply originates from an explicit click; `"always"` double-confirmation; replying to an already-resolved request → 404 → toast "request already resolved", list refetches.
5. The drawer never blocks SSE/chat; replying does not navigate away.
---
## 6. History view — session history browser

- Toolbar: search input (debounced 400 ms → `searchHistory`), project filter (reuse the projects list; "All projects" default — independent of the sidebar `activeProjectId`), archived toggle (default off), result count (mono).
- Query: `api.listSessionsQuery({ search, project, archived, limit: "50", order: "desc" })`; "Load more" appends with `cursor.next` (hidden when null). All server-side — no client-side filtering over a truncated 50-session window.
- Results: card list (not a dense table — matches the design language), each row: title, project canonical (resolve via `projects`), agent chip, outcome chip (succeeded = success, failed = destructive, interrupted = warning, absent = dim "open"), duration mono (`(time.idle ?? time.updated) − time.created`, humanized), total tokens mono (5-class sum), cost. **No per-session "steps" column** — steps are not in Session.Info and fetching messages per row would spam the single-slot server (honest omission, §13).
- Row click → `setActiveSession(id)` + switch to Chat. Children are NOT pre-filtered out: the list shows what the server returned; a child row carries a "↳ subagent of …" hint (parentID resolved via `sessions` or its title).
- Empty/degraded: "No sessions match" empty state; `historyError` → inline error + retry; never blocks the rest of the app.
---
## 7. Projects view — projects, scoping, worktrees

- `ProjectCard` per project: name/canonical (mono), `time.active` ("last active …"), `vcs` if present, `sandboxes` count chip, session count (derived client-side from the nexus sessions map — labeled "recent (loaded)" honestly, since the sidebar window is 50).
- Card expand → recent sessions of that project via `api.listSessionsQuery({ project: id, parentID: "null", limit: "10" })` + "Browse all →" button (jumps to History with `historyProjectId` preset). **This is the per-project session scoping extension** of the Phase 1 sidebar filter.
- Worktrees section per card (loaded lazily via `loadWorktrees`): `WorktreeDirectory` rows (directory mono, strategy chip) + **Refresh** button (`refreshWorktrees` → POST /worktree/refresh → reload; `worktree.updated`/`worktree.resolved` SSE events also trigger a reload of visible worktrees, debounced).
- **DECIDED: worktree mutations are OUT (no create, no delete).** `DELETE` requires `force` and removes directories from disk; `POST` creates branches/directories. Neither is reversible from a status UI and both can destroy work — the value/risk ratio fails for Phase 3. Read-only + refresh only (coordinator pre-authorized this judgment). Revisit in Phase 4 if wanted.
---
## 8. System view — extensions status + memory viewer

Second-level segmented control: **Extensions | Memory** (default Extensions).

### 8.1 Extensions panels (read-only status cards)

- `SkillsPanel` — one row per skill: name, description (2-line clamp), `autoinvoke` chip, path (mono, truncated). Click → expands inline to render `content` through the markdown renderer (lazy: fetched once in `loadExtensions`, rendered on expand — 56 KB of markdown must not render eagerly).
- `PluginsPanel` — grouped: active count header; rows: id/source ("builtin", "package target@version" + outdated/updating chips, "local path"), features as tiny chips (server/tui/rpc/gui); failed plugins pinned first with `state.error` in destructive.
- `McpPanel` — row per server: name, status dot + label (connected = success, pending = muted pulse, disabled = muted, failed/needs_auth = destructive with `error`), integrationID mono if present.
- Data: one `loadExtensions()` on first view open (`Promise.all` of the three GETs, `extensionsStatus` gates); SSE `skill.updated`/`plugin.updated`/`mcp.status.changed`/`config.updated` → invalidate (set `skills/plugins/mcpServers` to null) so the next view-open refetches; **no polling**.

### 8.2 Markdown rendering — DECIDED: markdown-it, html disabled

Add **`markdown-it`** (one dep, ~110 KB min inside the lazy System chunk, zero React coupling). Config: `{ html: false, linkify: true, breaks: false }`.
- With `html:false` every raw HTML tag in the source is **escaped**, and markdown-it default `validateLink` blocks `javascript:`/`data:` URLs — safe by default with no second sanitizer dependency.
- marked rejected: raw HTML is on by default and its sanitizer was removed in v5 — it would force a second dependency (DOMPurify) to meet the "must escape HTML" requirement. react-markdown rejected: heavy AST + React component pipeline for a read-only viewer.
- Output → `dangerouslySetInnerHTML` inside a fixed `.md-body` container styled by ~40 hand-rolled CSS rules in `index.css` (headings, lists, code in `--font-mono` + `--card`, links `--primary`, blockquote left rule) — no @tailwindcss/typography dependency.
- Scope: the renderer lives in `src/lib/markdown.ts` and is used by the memory viewer and skill-content expander ONLY. **Chat message markdown stays out of Phase 3** (Phase 1 deferral stands; §13).

### 8.3 Memory viewer

- Left: file list (`MEMORY_FILES`, §4.3) with per-file status dot; Right: rendered markdown. Click loads via `readFsFile` (`loading` → skeleton, `missing`/404 → "file not present on this machine", `error` → retry). Manual **Reload** button per file; **no polling, no fs.watch** (these files change on /remember and session end — explicit reload is honest and free).
- Footer note: "read-only · loaded HH:MM:SS". No edit affordances whatsoever.
---
## 9. Leftover basket (Phase 1 debt, folded into the task list)

1. **Child sessions in the sidebar** (`parentID` verified): `Sidebar` groups children under their parent root — nested `<ul>` indented 20 px with a hairline guide, collapsed by default with a chevron + count badge on the parent row; child rows show agent chip (mono, e.g. "reviewer") instead of a model chip. Children whose parent is not loaded (outside the 50-session window) render at top level with the agent chip. `SessionListItem` gains optional `child?: { agent?: string }` props — keep the existing props intact.
2. **Synthetic message dividers** (`MessageBubble`): roles `idle`, `synthetic`, `system`, `skill`, `shell`, `compaction`, `agent-switched`, `model-switched`, `location-switched` render as a centered divider — hairline rules with a tiny uppercase label pill ("idle", "system", "skill", "shell", "compaction", "agent switched", "model switched", "location switched") in `--muted-foreground` 10 px mono — replacing the current dim raw-bracket text.
3. **T-hardening drills** → folded into T28.
---
## 10. Exact file list

### New files

| File | Exports | Notes |
| --- | --- | --- |
| `src/lib/markdown.ts` | `renderMarkdown(src: string): string` | markdown-it singleton, `html:false`, §8.2 |
| `src/store/workspace.ts` | `useWorkspace`, `WorkspaceState`, `MemoryFileId`, `MemoryFileEntry`, `MEMORY_FILES`, `useHistoryResults()`, `useMemoryFiles()`, `useWorktrees(projectID)` | §4.2; EMPTY_* constants |
| `src/components/agents/graph.ts` | `AgentNode`, `AgentEdge`, `AgentNodeStatus`, `buildGraph()`, `layoutForest()` | pure, unit-testable, no React |
| `src/components/agents/AgentGraphView.tsx` | `AgentGraphView` (named) | scope toggle, wires store→buildGraph→layout→Canvas, detail panel |
| `src/components/agents/AgentGraphCanvas.tsx` | default | React.lazy chunk; xyflow lives only here |
| `src/components/agents/AgentNodeCard.tsx` | `AgentNodeCard` (+ nodeTypes entry) | custom xyflow node |
| `src/components/agents/AgentDetailPanel.tsx` | `AgentDetailPanel` | selected-node facts + Open in Chat |
| `src/components/history/HistoryView.tsx` | `HistoryView` | §6 |
| `src/components/history/HistoryCard.tsx` | `HistoryCard` | one session row |
| `src/components/projects/ProjectsView.tsx` | `ProjectsView` | §7 |
| `src/components/projects/ProjectCard.tsx` | `ProjectCard` | incl. worktree section |
| `src/components/projects/WorktreeList.tsx` | `WorktreeList` | rows + refresh |
| `src/components/system/SystemView.tsx` | `SystemView` | segmented control Extensions/Memory |
| `src/components/system/SkillsPanel.tsx` | `SkillsPanel` | skill rows + content expander |
| `src/components/system/PluginsPanel.tsx` | `PluginsPanel` | grouped status rows |
| `src/components/system/McpPanel.tsx` | `McpPanel` | status dot rows |
| `src/components/system/MemoryViewer.tsx` | `MemoryViewer` | file list + rendered pane |
| `src/components/permissions/PermissionDrawer.tsx` | `PermissionDrawer` | slide-over, §5 |
| `src/components/permissions/PermissionCard.tsx` | `PermissionCard` | reply buttons + double-confirm |

### Modified files (surgical)

- `src/lib/opencode/types.ts`, `src/lib/opencode/client.ts` — §3 additions; extend `ProjectInfo` additively.
- `src/store/nexus.ts` — `permissionRequests`, `replyPermission` action, "permissions" in `scheduleRefetch`, permission fetch in `resync()`.
- `src/store/events.ts` — `RefetchTarget += "permissions"`; three permission cases.
- `src/store/selectors.ts` — `usePermissionRequests()` (EMPTY constant).
- `src/components/shell/MainTabs.tsx` — `MainView` union + 4 tabs + shield button (opens drawer; badge count).
- `src/components/shell/AppShell.tsx` — view switch: lazy/unmount rules (§1); mount `PermissionDrawer` once (open state local to AppShell or a tiny workspace slice).
- `src/components/shell/Sidebar.tsx`, `SessionListItem.tsx` — §9.1 grouping.
- `src/components/chat/MessageBubble.tsx` — §9.2 dividers.
- `src/components/rail/StatusRail.tsx` — badge becomes a drawer-opening button; footer "nexus · phase 3".
- `src/index.css` — `.md-body` rules; xyflow overrides scoped under `.react-flow` to match tokens.
- `package.json` — add `markdown-it` + `@types/markdown-it` (dev). Nothing else.
---
## 11. Ordered task list (T20–T28; sequential — glm-server is single-slot)

Each task compiles (`tsc -b` green), lints (oxlint), and leaves the app runnable. Acceptance = demonstrable, not asserted.

- **T20 — Client extensions.** §3 types + client methods + `ProjectInfo` extension + `markdown-it` dependency + `src/lib/markdown.ts`. *Accept:* console-verify `listSessionsQuery({ search: "notes" })` returns matches + cursor object; `listPermissionRequests()` → array (empty ok); `listWorktrees("abec6f78…")` → array; `listSkills/listPlugins/listMcpServers` match sample shapes; `readFsFile(<MEMORY.md path>)` returns the markdown text; `renderMarkdown("# hi <script>alert(1)</script>")` output contains an **escaped** script tag (string-check in console).
- **T21 — Permission inbox.** nexus additions + reducer cases + drawer/card + rail-badge button + MainTabs shield. *Accept:* with a real pending request (generate one by prompting an agent to run a command needing approval — use a **dedicated test session**, never the operator live session per DECISIONS 2026-11-04), the badge increments live, the drawer lists it, Approve-once executes the action and removes the card, Reject denies, "Always allow" demands the second click; SSE `permission.replied` from another client heals the list. Verify **no code path** calls reply without a click (grep + reviewer).
- **T22 — View switcher expansion.** MainView union, 4 tabs, AppShell lazy/unmount wiring, placeholder views. *Accept:* all six tabs switch without touching chat streaming (prompt → switch mid-stream → back → deltas intact); `nexus.mainView` persists; each new view chunk loads on first open only (Network tab); no console warnings from hidden containers.
- **T23 — History browser.** §6. *Accept:* server-side search returns matching titles (cross-check with curl); project filter + archived toggle hit the API with the right params; "Load more" appends via `cursor.next` and hides at null; row click opens the session in Chat; durations/tokens match the rail numbers for the active session.
- **T24 — Sidebar children + chat dividers.** §9.1 + §9.2. *Accept:* the live child sessions (6 verified) nest under their parents with agent chips; a `/command` run and an interrupt produce labeled dividers, not raw bracket text; no regression in session switching.
- **T25 — Agents graph.** graph.ts + view + canvas + node card + detail panel + active-map poll. *Accept (the Phase 3 money shot per PLAN):* start a task in a dedicated session that spawns a subagent (e.g. ask for a code review, which spawns the reviewer subagent) → child node + edge appear live without reload; node flips to running (pulsing) then terminal; tokens tick via usage events; SSE-gap drill (restart the dev server mid-run) → the 5 s poll reconciles the spawned child; scope toggle works; the chunk containing xyflow is NOT in the entry bundle (`vite build` output check).
- **T26 — Projects view.** §7. *Accept:* 3 live projects render with real counts; worktree list loads (empty state honest); Refresh issues POST /worktree/refresh and reloads; "Browse all →" lands in History pre-filtered; no create/delete affordances exist anywhere.
- **T27 — System view.** panels + memory viewer. *Accept:* skills/plugins/MCP match live GETs (spot-check counts: 7-ish skills, ~92 plugins, 2 MCP servers "pending"); a skill markdown expands rendered and escaped; all five memory files render; a deliberately-wrong path in MEMORY_FILES (dev-only edit) shows the "not present" state; no polling requests while on other tabs.
- **T28 — Hardening + review handoff.** Drills: (a) offline recovery — stop the service, exercise every new view degraded state, restart, verify refetch of permissions/extensions/history; (b) rapid session-switch bleed — spam-switch sessions while a child runs; graph/history must not cross-contaminate; (c) permission-misuse audit with reviewer; (d) fs/read whitelist audit (no path input, only MEMORY_FILES); (e) reduced-motion pass over graph + drawer. Then **reviewer** gate (security focus: permission reply reachability, fs path handling, markdown XSS, no new auth material) and **ui-designer** visual pass.
---
## 12. Risks & open questions

1. **Permission reply misuse** — the highest-stakes surface in Nexus so far: `once`/`always` execute real agent actions and `always` persists rules. Mitigations: single call site, explicit-click-only, Reject default focus, double-confirm for `always`, optimistic-remove + authoritative refetch, reviewer grep-audit in T28.
2. **fs/read is host-wide** — the endpoint accepts absolute paths; only server-side validation stopped `/etc/hostname`. Nexus is local-first with the password confined to the dev proxy, and the UI exposes no path input — the client whitelist (§4.3) is the contract; reviewer verifies no other `readFsFile` call sites.
3. **xyflow bundle size** — mitigated by React.lazy chunk per §1; verified via build output in T25. If the lazy chunk exceeds ~300 KB gzip, consider dropping MiniMap (largest optional sub-feature) before reconsidering the dependency.
4. **SSE child-spawn assumption** — no schema backing for "session.created carries parentID"; the 5 s Agents-visible poll is the designed fallback and heals outcomes too (§2.2). If live events were directory-filtered somehow, the poll covers it.
5. **Permission location scoping** — the live sample returned `location.directory: "/home/mg-12623-8"` with empty data; whether requests from sessions rooted in `~/Documents` appear in the unscoped listing is unverified. T21 resolves (query with and without `location[directory]` while a request is pending) and records the answer in docs/API-NOTES.md; fallback = fetch per known project directory and merge by `id`.
6. **Cursor pagination semantics** — `SessionsCursor` is opaque and `cursor` is required in the response schema but the sample was captured cursorless; treat `cursor.next` as "pass back verbatim or stop", never inspected.
7. **Single-slot server load** — new request budget: graph poll 2 GET / 5 s **only while Agents is visible**; history = debounced manual search + explicit pagination; extensions/memory = on-open only; permissions = event-driven refetch. No polling from System/Projects. Within the Phase 2 discipline (§9.2 there).
8. **Hidden-container measurement** — xyflow in a `display:none` tab would zero-measure (recharts precedent); solved by unmounting view instances on tab leave, state kept in stores.
9. **Open questions for the coordinator:** (a) permission listing scope (§12.5) — T21 resolves; (b) worktree mutations stay out (§7) — confirm if Phase 4 should revisit; (c) chat markdown remains deferred even though the renderer now exists in-repo — recommend keeping it out of Phase 3 to bound the diff, revisit for Phase 4 polish.
---
## 13. What NOT to build (explicit exclusions)

- **No session deletion/archive UI.** `DELETE /api/session/{id}` and the archive endpoints exist, but the PLAN scope for the history browser is read/browse; destructive session ops belong to the OpenCode TUI. (Archive toggle = filter only.)
- **No worktree create/delete** (§7) — read-only + refresh.
- **No permission rule management** (`/api/permission/saved` read endpoints exist) — out of scope; the "always" reply path is the only rule-writing surface, guarded as specified.
- **No MCP connect/disconnect, plugin update/install** (`/api/experimental/mcp/*/connect`, `/api/plugin/update` exist) — status panels are read-only.
- **No chat markdown rendering** — the renderer ships for the System view only.
- **No session forking/moving/compaction UIs**, no `/api/session/{id}/shell`, no form/PTY surfaces — not in PLAN Phase 3.
- **No auto-anything in permissions** — no timers, no batch approve, no default approvals.