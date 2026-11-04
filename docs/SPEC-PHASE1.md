# OpenCode Nexus — Phase 1 Implementation Spec

**Scope:** connection, design tokens, app shell, live chat, connection status, animated AI core.
**Pipeline position:** Architect spec → Developer (this doc is the build contract) → Reviewer gate → Playwright visual pass.
**Ground truth verified 2026-11-04** against the live OpenCode v2.2.0 service (port 49374), its OpenAPI spec, and captured event/message samples. Where this doc contradicts docs/API-NOTES.md, **this doc wins** (corrections flagged inline).

---

## 0. Verified ground truth & corrections

1. **Event taxonomy correction (important).** API-NOTES.md guessed "message.updated" / "session.updated". The real v2.2.0 /api/event enum has **no such types**. Events are granular session.* stream events (session.text.delta, session.step.started, session.tool.success, ...) plus lifecycle events. Full handling table in §4.
2. **SSE frame shape (verified from /tmp/opencode/all-events.log):** each frame is a "data:" line whose JSON is one envelope:

   ~~~json
   { "id": "evt_...", "created": 1793815081618, "type": "session.text.delta",
     "location": { "directory": "/home/mg-12623-8/Documents" },
     "data": { "sessionID": "ses_...", "assistantMessageID": "msg_...", "ordinal": 0, "delta": "PING4" },
     "durable": { "aggregateID": "ses_...", "seq": 7, "version": 1 } }
   ~~~

   The first frame on subscribe has type "server.connected". Heartbeats arrive as SSE comment lines (": heartbeat"). Live-only: no replay, no Last-Event-ID resume.
3. **Envelope variance.** List/config endpoints return { location, data } or { data }; GET /api/project returns a **bare array**. The client must unwrap all three (§3 unwrap()).
4. **Auth:** HTTP Basic "opencode:<password>" from ~/.local/state/opencode/service.json (fields: id, version, url, pid, password). Password rotates if the service restarts → proxy must re-read the file (§2).
5. **Message shape (verified from session-messages.json sample):** items are
   { id, time:{created, streamed?}, type:"user"|"assistant"|..., agent?, model?:{id,providerID,variant}, content: Part[] }
   where Part is one of:
   - { type:"text", text }
   - { type:"reasoning", text, native?:{reasoningField}, time:{created, completed?} }
   - { type:"tool", id, name, executed: boolean, state:{status:"running"|..., input, output?}, metadata? }
   Message "type" enum from OpenAPI: user, assistant, synthetic, system, skill, shell, compaction, idle, agent-switched, model-switched, location-switched. Phase 1 renders "user" and "assistant"; others render as dim system lines.
6. Stack facts: Vite 8 (oxc — do **not** set minify:"esbuild"), React 19, TS 7 (tsc -b must pass), Tailwind 4 via @tailwindcss/vite, shadcn v4 radix-nova with CSS-var theme already in src/index.css (currently light values; @custom-variant dark exists). Alias "@" → "src/". Dev port 1420 strict. Build target chrome110.

---

## 1. Module layout & state approach

### New dependencies (the only ones)

- zustand (add via npm). **Rationale:** SSE deltas arrive from outside React at high frequency; a vanilla store with selector subscriptions avoids Context re-render storms and keeps the event reducer free of hook rules. Plain Context + useReducer would re-render the whole tree per delta. Redux rejected as overkill.
- @fontsource-variable/geist-mono for the mono voice (tokens, code, stats). Everything else already installed (motion, lucide-react).

### Tree

~~~
src/
  main.tsx                      (existing — keep)
  App.tsx                       (REWRITE: mounts <AppShell/>; delete hero boilerplate)
  App.css                       (DELETE — boilerplate)
  index.css                     (extend: dark-futuristic tokens, §6)
  lib/opencode/
    types.ts                    API domain types (SessionInfo, ChatMessage, Part, ...)
    client.ts                   fetch wrapper + typed endpoint functions + ApiError
    sse.ts                      EventSource manager for /api/event
  store/
    nexus.ts                    zustand store: connection + sessions + chat slices, actions
    events.ts                   pure reducer: applyEvent(state, NexusEvent) → state
    selectors.ts                selectors (activeSession, activeMessages, isBusy)
  hooks/
    useEventStream.ts           mounts SSE, feeds events.ts, drives resync on reconnect
    useHealthPoll.ts            degraded-mode /api/info polling
  components/
    shell/
      AppShell.tsx              grid layout: sidebar | main | status rail
      Sidebar.tsx               brand, connection badge, new-session, project filter, session list
      SessionListItem.tsx
      ConnectionBadge.tsx
      DegradedBanner.tsx
    chat/
      ChatPanel.tsx             header + message list + composer orchestration
      ChatHeader.tsx            title, agent/model chips, InterruptButton
      MessageList.tsx           scroll container, pin-to-bottom, autoscroll rules
      MessageBubble.tsx         user vs assistant vs system line dispatch
      ReasoningBlock.tsx        collapsible reasoning part
      ToolPartCard.tsx          tool call chip/card with status
      Composer.tsx              textarea, Enter-to-send, slash detection
      SlashMenu.tsx             command autocomplete popover
    rail/
      StatusRail.tsx            AI core + session stats + server card
      AiCore.tsx                animated idle/thinking orb (motion)
~~~

Rules: components never call client.ts directly — they call store actions; lib/opencode never imports React.

---

## 2. Vite dev proxy & auth injection (dev only)

Replace the server block in vite.config.ts with:

~~~ts
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { fileURLToPath, URL } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const SERVICE_JSON = homedir() + "/.local/state/opencode/service.json"

function readService(): { url: string; auth: string } | null {
  try {
    statSync(SERVICE_JSON)                     // mtime cache: re-parse only on change
    const svc = JSON.parse(readFileSync(SERVICE_JSON, "utf8")) as {
      url: string; password: string
    }
    return {
      url: svc.url,
      auth: "Basic " + Buffer.from("opencode:" + svc.password).toString("base64"),
    }
  } catch { return null }
}

const boot = readService()  // target pinned at boot; password re-read per request below

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": {
        target: boot?.url ?? "http://127.0.0.1:49374",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            const svc = readService()          // re-read (mtime-cached) per request
            if (svc) proxyReq.setHeader("authorization", svc.auth)
          })
          proxy.on("proxyRes", (proxyRes) => {
            if ((proxyRes.headers["content-type"] ?? "").includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform"
              proxyRes.headers["x-accel-buffering"] = "no"
            }
          })
        },
      },
      "/llm": {                                // reserved for Phase 2 telemetry middleware
        target: boot?.url ?? "http://127.0.0.1:49374",
        changeOrigin: true,
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "chrome110", sourcemap: false },
})
~~~

**Design notes**

- The password **never reaches the browser** — same decision as PLAN.md. Tauri later swaps this for a Rust command; the browser client is already origin-relative (fetch("/api/..."), new EventSource("/api/event")) so nothing changes.
- Re-read service.json inside proxyReq with an mtime cache (statSync → re-parse only when mtime changed) so a service restart with a new password self-heals without a dev-server restart. (Implement the cache with a module-level {mtime, result} pair; the statSync call above marks the spot.)
- Target URL is read once at boot (port changes are rare; a dev restart is acceptable — note it in README).
- /llm proxying to the same target yields a harmless 404 in Phase 1; Phase 2 mounts the telemetry middleware at /llm and can then drop the proxy entry.
- EventSource cannot set headers — it works here **only because** the proxy injects auth. Never bypass the proxy.

---

## 3. Typed API client — src/lib/opencode/types.ts + client.ts

### types.ts (exported names are contractual)

~~~ts
export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "offline"

export interface LocationRef { directory?: string }
export interface ModelRef { id: string; providerID: string; variant?: string }
export interface TokenUsage {
  input: number; output: number; reasoning: number
  cache: { read: number; write: number }
}

export interface SessionInfo {
  id: string
  projectID: string
  parentID?: string
  title?: string
  agent?: string
  model?: ModelRef
  cost: number
  tokens: TokenUsage
  outcome?: "succeeded" | "failed" | "interrupted"
  time: { created: number; updated: number; idle?: number; viewed?: number; archived?: number }
  location: LocationRef
}

export type MessageRole =
  | "user" | "assistant" | "synthetic" | "system" | "skill" | "shell"
  | "compaction" | "idle" | "agent-switched" | "model-switched" | "location-switched"

export interface TextPart      { type: "text"; text: string }
export interface ReasoningPart { type: "reasoning"; text: string;
  time?: { created: number; completed?: number } }
export interface ToolPart {
  type: "tool"; id: string; name: string; executed: boolean
  state: { status: string; input?: unknown; output?: unknown }
}
export type MessagePart = TextPart | ReasoningPart | ToolPart

export interface ChatMessage {
  id: string
  sessionID: string
  role: MessageRole
  agent?: string
  model?: ModelRef
  parts: MessagePart[]
  streaming?: boolean          // true while assistant deltas are arriving
  time: { created: number }
}

export interface AgentInfo   { id: string; name: string; mode: string; hidden: boolean; description?: string }
export interface CommandInfo { name: string; description?: string }
export interface ProjectInfo { id: string; canonical: string;
                               time: { created: number; updated: number; active?: number } }
export interface ServerInfo  { version?: string; [k: string]: unknown }

// request bodies (exact, §5)
export interface PromptBody {
  text: string
  files?: { uri: string; name?: string; description?: string }[]
  agents?: { name: string }[]
  skills?: { id: string }[]
  metadata?: Record<string, unknown>
  delivery?: "steer" | "queue" | null
  resume?: boolean | null
  id?: string | null
}
export interface CommandBody { name: string; text: string }
~~~

### client.ts

~~~ts
export class ApiError extends Error {
  constructor(public status: number, public tag: string | null, message: string)
}
// unwrap handles {data}, {location,data}, and bare arrays/objects
function unwrap<T>(json: unknown): T
async function request<T>(path: string, init?: RequestInit): Promise<T>
//   - throws ApiError on !res.ok; parses the {_tag, message} auth-failure body
//   - all paths origin-relative ("/api/...")

export const api = {
  info(): Promise<ServerInfo>                                    // GET /api/info
  listSessions(directory?: string): Promise<SessionInfo[]>       // GET /api/session?directory=&limit=50&order=desc
  createSession(directory: string): Promise<SessionInfo>         // POST /api/session {location:{directory}}
  listMessages(sessionID: string): Promise<ChatMessage[]>        // GET /api/session/{id}/message?order=asc&limit=200
  prompt(sessionID: string, body: PromptBody): Promise<unknown>  // POST /api/session/{id}/prompt
  runCommand(sessionID: string, body: CommandBody): Promise<void> // POST /api/session/{id}/command (204)
  interrupt(sessionID: string): Promise<{ interrupted: boolean }> // POST /api/session/{id}/interrupt
  listAgents(): Promise<AgentInfo[]>                             // GET /api/agent
  listCommands(): Promise<CommandInfo[]>                         // GET /api/command
  listProjects(): Promise<ProjectInfo[]>                         // GET /api/project (bare array)
}
~~~

listMessages maps server items → ChatMessage 1:1 (content → parts, type → role, inject sessionID).

---

## 4. SSE event stream & resync — sse.ts, useEventStream.ts, events.ts

### sse.ts

~~~ts
export interface NexusEvent {
  id: string | null
  created: number
  type: string
  data: Record<string, unknown>
  location?: LocationRef
}
export type StreamState = "open" | "error"
export interface EventStreamHandle { close(): void }
export function connectEvents(
  onEvent: (e: NexusEvent) => void,
  onState: (s: StreamState) => void,
): EventStreamHandle
~~~

Implementation: new EventSource("/api/event") (auth via proxy). Do **not** pass the "types" filter in Phase 1 — subscribe to everything, ignore unknown types in the reducer (future-proof, and server.connected comes through). onopen → onState("open"); onerror → onState("error"). EventSource auto-reconnects; do not close/retry manually.

### Event → store handling table (payload fields verified from live captures)

| Event type | data payload (verified) | Store effect |
| --- | --- | --- |
| server.connected | — | connection → online, trigger resync |
| session.created | session fields | upsert sessions |
| session.renamed | sessionID, title | patch title |
| session.deleted | sessionID | remove; if active, clear active + messages |
| session.inbox.delivered / .enqueued | sessionID, inboxID (inboxID = user message id) | reconcile optimistic user message id |
| session.execution.started | sessionID | busy[sessionID] = true |
| session.execution.succeeded / .failed / .interrupted | sessionID | busy = false; schedule reconcile fetch of messages (debounced 300 ms) |
| session.step.started | sessionID, agent, model, assistantMessageID, started | create assistant ChatMessage { id: assistantMessageID, streaming: true, parts: [] } if absent |
| session.step.streamed / .ended / .failed | sessionID, assistantMessageID | step bookkeeping (Phase 1: no-op beyond ordering) |
| session.text.started | sessionID, assistantMessageID, ordinal | ensure empty text part at index ordinal |
| session.text.delta | sessionID, assistantMessageID, ordinal, delta | append delta to text part at ordinal |
| session.text.ended | same minus delta | mark part complete |
| session.reasoning.started / .delta / .ended | same shape as text.* | same, for reasoning part at ordinal |
| session.tool.input.started / .delta / .ended | tool input streaming | upsert tool part (keyed by id) with partial input |
| session.tool.called | sessionID, assistantMessageID, id, name, ... | tool part → state.status = "running" |
| session.tool.success / .failed | sessionID, assistantMessageID, id, content[], metadata | tool part → completed/failed with output |
| session.usage.updated | sessionID, cost, tokens{input,output,reasoning,cache{read,write}} | patch session tokens + cost (status rail live) |
| session.idle, session.status | — | defensive idle signal for busy |
| command.updated, agent.updated, config.updated, project.updated | — | invalidate + refetch the matching list (debounced 500 ms) |
| permission.asked | — | Phase 3 hook: store count only, render badge in rail |
| everything else | — | ignore |

Reducer rules: events.ts exports applyEvent(state: NexusState, e: NexusEvent): NexusState — pure, switch on e.type. Deltas append by (assistantMessageID, ordinal); parts array is sparse-indexed (create placeholders for gaps).

### Resync strategy (no replay exists — refetch on reconnect)

~~~ts
// useEventStream.ts
onState("error") → connection.status = "reconnecting"; start useHealthPoll
onState("open") after a prior "error" (or first open) → resync():
  1. api.info()            → version, connection online
  2. api.listSessions(directoryOfActiveProject)
  3. if activeSessionId: api.listMessages(activeSessionId) — REPLACE streamed messages wholesale
  4. api.listCommands(); api.listAgents(); api.listProjects()
All replaces bump a monotonically increasing syncGeneration; async results from a
stale generation are dropped (race guard for rapid reconnect cycles).
~~~

---

## 5. Exact request bodies (from the live OpenAPI, v2.2.0)

### POST /api/session/{sessionID}/prompt — operationId: session.prompt

Required: only "text". additionalProperties: false.

~~~json
{
  "text": "string (required)",
  "id": "msg_... | null (optional, client-supplied message id)",
  "files": [ { "uri": "string (required)", "name": "string?", "description": "string?" } ],
  "agents": [ { "name": "string (required)" } ],
  "skills": [ { "id": "string (required)" } ],
  "metadata": {},
  "delivery": "steer | queue | null",
  "resume": "true | false | null"
}
~~~

- Response 200 → { "data": Session.Inbox.User } where Session.Inbox.User =
  { id, sessionID, time:{created}, type:"user", payload, delivery:"steer"|"queue" }. Use data.id to replace the optimistic message.
- 409 ConflictError = another prompt is executing for that session → surface as "session busy" toast. Phase 1 default: omit "delivery" (server default) and handle 409 in UI.
- Phase 1 sends { text } only.

### POST /api/session/{sessionID}/command — operationId: session.command

~~~json
{ "name": "string (required, slash command name without /)",
  "text": "string (required, remainder text; may be empty string)",
  "files": "[] optional", "agents": "[] optional", "skills": "[] optional",
  "delivery": "steer | queue | null (optional)" }
~~~

Response: **204 No Content**. 404 = unknown command name.

### POST /api/session/{sessionID}/interrupt — operationId: session.interrupt

**No body.** Optional query param ?resume=true|false (omit in Phase 1).
Response 200 → { "interrupted": boolean } (true = active execution was interrupted; false = idle no-op).

### POST /api/session — operationId: session.create

~~~json
{ "location": { "directory": "/abs/path" }, "title": "string?", "agent": "string?" }
~~~

All fields optional; response { data: Session.Info }. Nexus sends location.directory = the selected project's canonical path.

---

## 6. Design token contract (hand to UI designer; developer implements verbatim)

Base: the existing shadcn radix-nova variable scaffold in src/index.css. Default the app to dark: put the values below under :root (no .dark toggle in Phase 1 — the app IS dark). Keep the existing @theme inline bridge pattern; add the new tokens (--color-success, --color-warning, --font-mono, --glow-*) to it.

~~~css
:root {
  /* surfaces — deep-space navy, cool hue 265 */
  --background:           oklch(0.145 0.018 265);
  --foreground:           oklch(0.93  0.012 250);
  --card:                 oklch(0.175 0.02  265);
  --card-foreground:      oklch(0.93  0.012 250);
  --popover:              oklch(0.19  0.022 265);
  --popover-foreground:   oklch(0.93  0.012 250);
  --sidebar:              oklch(0.13  0.016 265);
  --sidebar-foreground:   oklch(0.88  0.012 250);
  --secondary:            oklch(0.22  0.025 265);
  --secondary-foreground: oklch(0.9   0.012 250);
  --muted:                oklch(0.21  0.02  265);
  --muted-foreground:     oklch(0.65  0.02  255);
  --border:               oklch(0.28  0.02  265);
  --input:                oklch(0.24  0.022 265);
  --ring:                 oklch(0.82  0.16  195);

  /* brand — electric cyan primary, violet accent */
  --primary:              oklch(0.82 0.16 195);
  --primary-foreground:   oklch(0.13 0.02 265);
  --accent:               oklch(0.72 0.19 300);
  --accent-foreground:    oklch(0.14 0.02 265);
  --destructive:          oklch(0.62 0.22 25);

  /* semantic (new tokens) */
  --success:              oklch(0.75 0.16 155);
  --warning:              oklch(0.8  0.15 85);

  /* charts (recharts, Phase 2 but token now) */
  --chart-1: oklch(0.82 0.16 195);   /* cyan   */
  --chart-2: oklch(0.72 0.19 300);   /* violet */
  --chart-3: oklch(0.75 0.16 155);   /* green  */
  --chart-4: oklch(0.8  0.15 85);    /* amber  */
  --chart-5: oklch(0.62 0.22 25);    /* red    */

  --radius: 0.75rem;   /* existing sm..4xl calc() chain stays */

  /* signature glow (new) */
  --glow-primary: 0 0 24px oklch(0.82 0.16 195 / 0.35);
  --glow-accent:  0 0 24px oklch(0.72 0.19 300 / 0.30);
}
~~~

Typography: --font-sans "Geist Variable" (already wired); add --font-mono "Geist Mono Variable", ui-monospace, monospace. Mono is used for: token counts, session ids, tool input/output, model names, timestamps.

Scale (readability-first): 12 (meta/mono), 13 (body-secondary), 14 (body/chat), 16 (composer), 20 (panel titles), 24–32 (brand/empty states). Line-height 1.6 for chat body. Letter-spacing -0.01em on ≥20px.

Spacing/radii: Tailwind default 4px scale; radii from the existing --radius chain; cards rounded-xl, chips rounded-full. Elevation is expressed with --glow-* shadows + 1px --border, **no** gray drop-shadows.

Motion contract: durations 150 ms (micro) / 300 ms (panel) / spring for the core pulse; prefers-reduced-motion respected — AiCore falls back to a static ring.

---

## 7. State store — src/store/nexus.ts

~~~ts
interface NexusState {
  connection: { status: ConnectionStatus; version: string | null; lastEventAt: number }
  syncGeneration: number
  sessions: Record<string, SessionInfo>
  sessionOrder: string[]                       // newest first
  activeSessionId: string | null
  messages: Record<string, ChatMessage[]>      // per sessionID, oldest → newest
  busy: Record<string, boolean>                // sessionID → execution running
  commands: CommandInfo[]
  agents: AgentInfo[]
  projects: ProjectInfo[]
  activeProjectId: string | null               // sidebar filter
  toast: { kind: "error" | "info"; text: string } | null
  // actions
  bootstrap(): Promise<void>
  setActiveSession(id: string | null): Promise<void>
  newSession(): Promise<void>
  sendPrompt(text: string): Promise<void>
  sendSlashCommand(name: string, rest: string): Promise<void>
  interruptActive(): Promise<void>
  resync(): Promise<void>
  applyEvent(e: NexusEvent): void              // delegates to events.ts reducer
}
export const useNexus = create<NexusState>()(...)
~~~

### Optimistic append & streaming rules

1. sendPrompt: append { id: "tmp_" + crypto.randomUUID(), role: "user", parts: [{type:"text", text}], ... } immediately → api.prompt → on 200, replace the temp message using data.id (match by temp id); on ApiError, remove temp + toast.
2. Assistant messages exist **only** via session.step.started events (id = assistantMessageID) or the reconcile fetch — never fabricated locally.
3. Deltas append synchronously into the store; no buffering/debounce (zustand handles it; selectors keep re-renders scoped to the streaming bubble).
4. session.execution.succeeded/failed/interrupted → after a 300 ms debounce, api.listMessages(sessionID) replaces the session's messages (authoritative reconciliation — heals any missed delta).
5. interruptActive: disabled unless busy[activeSessionId]; optimistic busy = false on 200 interrupted:true.
6. Slash handling: if composer text starts with "/" and the first token matches a commands[] name → sendSlashCommand(name, rest) (POST /command, 204; the resulting user/assistant flow arrives via SSE). No match → keep text in composer, show "unknown command" hint in SlashMenu.

---

## 8. Component breakdown (props/state contracts)

### Shell

- AppShell.tsx — no props. Grid: [280px sidebar] [1fr main] [260px rail]; rail collapsible (useState, persisted to localStorage key "nexus.railCollapsed"). Mounts useEventStream() + bootstrap() once. Renders DegradedBanner above the grid when connection.status !== "online".
- Sidebar.tsx — no props; store-driven. Sections: brand row (Nexus mark + ConnectionBadge), "New session" button (calls newSession()), project filter (select of projects, sets activeProjectId, refilters sessionOrder by sessions[id].projectID), session list.
- SessionListItem.tsx — props: { session: SessionInfo; active: boolean; busy: boolean; onSelect(id: string): void }. Shows truncated title (fallback "Untitled session"), relative time, mono id suffix, pulsing dot when busy.
- ConnectionBadge.tsx — props: { status: ConnectionStatus; version: string | null }. Four states with distinct colors: connecting (muted pulse), online (success + version), reconnecting (warning pulse), offline (destructive).
- DegradedBanner.tsx — props: { status: ConnectionStatus }. One-line status + retry button calling resync().

### Chat

- ChatPanel.tsx — no props. Empty state (no active session): centered AiCore + "Select or create a session" CTA.
- ChatHeader.tsx — props: { session: SessionInfo | null; busy: boolean; onInterrupt(): void }. Title, agent name + model id (mono chips), Interrupt button (visible iff busy).
- MessageList.tsx — props: { messages: ChatMessage[] } (active session, from selector). Scroll rules: pin to bottom iff the user was within 80 px of the bottom before the delta; else show a "↓ new activity" pill that jumps to bottom. Virtualization deferred (fine up to a few hundred messages).
- MessageBubble.tsx — props: { message: ChatMessage }. Rules:
  - user: right-aligned card, --secondary surface, text parts joined, whitespace-pre-wrap.
  - assistant: left-aligned, transparent card with 1px border; render parts **in order**: reasoning → ReasoningBlock, text → paragraph flow, tool → ToolPartCard. Streaming cursor (blinking block, --primary) appended to the last incomplete part while message.streaming.
  - other roles (system/synthetic/skill/compaction/idle/…): centered dim mono line, no card.
  - No markdown renderer in Phase 1 (deliberate: minimal deps); fenced code in assistant text renders in font-mono blocks via a trivial triple-backtick splitter. Full markdown = Phase 2 decision.
- ReasoningBlock.tsx — props: { part: ReasoningPart; streaming: boolean }. Internal state "open": auto-open while streaming, auto-collapse when part.time.completed arrives (unless the user manually toggled). Style: --muted-foreground, italic, left rule accent.
- ToolPartCard.tsx — props: { part: ToolPart }. Compact row: tool icon (lucide Terminal/Wrench fallback), name (mono), status chip (running → animated dots, completed → success, failed → destructive). Click expands a pre block with JSON state.input / state.output.
- Composer.tsx — props: { disabled: boolean; busy: boolean; onSend(text: string): void; onInterrupt(): void }. Internal state: value. Enter = send (Shift+Enter = newline). Shows SlashMenu when value starts with "/". Busy state swaps send → interrupt.
- SlashMenu.tsx — props: { query: string; commands: CommandInfo[]; onPick(name: string, rest: string): void; onClose(): void }. Internal selectedIndex with ArrowUp/Down/Tab/Enter; filters by prefix; shows description.

### Rail

- StatusRail.tsx — props: { session: SessionInfo | null }. Stacks: AiCore, session token block (tokens + cost, mono, live via session.usage.updated), server card (version, URL from /api/info), permission badge placeholder (Phase 3).
- AiCore.tsx — props: { state: "idle" | "thinking" } (thinking = busy[activeSessionId]). Motion: concentric rings breathing at 4 s (idle) → 1.2 s + rotation (thinking), cyan glow via --glow-primary; motion/react variants; honor prefers-reduced-motion with a static ring. Pure SVG + motion — no canvas.

---

## 9. Error & degraded states

| Condition | Detection | UX |
| --- | --- | --- |
| Server offline | proxy 5xx / fetch throws; useHealthPoll polls api.info() every 10 s while not online | DegradedBanner "OpenCode service unreachable — retrying", badge offline, composer disabled, AiCore dims to static |
| Auth failure / password rotated | ApiError 401 with _tag "UnauthorizedError" | toast "Authentication stale — retrying"; auto-resync() after 2 s (proxy re-reads service.json per request, so retry usually heals) |
| SSE drop | EventSource onerror | badge → reconnecting; EventSource auto-retries; on reopen → resync() (§4). No data fabrication during the gap |
| 409 busy prompt | ApiError 409 | toast "Session is busy"; keep composer text |
| Unknown slash command | local match failure | inline hint in SlashMenu; Enter sends nothing |
| Interrupt with nothing running | interrupted: false | silent (button already hidden when not busy) |

Never block the UI thread on errors; all failures land in toast + console.warn with the event/endpoint name.

---

## 10. Ordered task list (file-by-file, sequential — glm-server is single-slot)

Each task compiles (tsc -b green), lints (oxlint), and leaves the app runnable.

- **T1 — Proxy + auth** (vite.config.ts). Accept: with the dev server running, fetch("/api/info") from the browser console returns 200 with no auth headers attached; new EventSource("/api/event") receives server.connected and heartbeats; rotating the password in service.json self-heals within one request.
- **T2 — Types** (src/lib/opencode/types.ts). Accept: exports exactly the names in §3; compiles standalone.
- **T3 — Client** (src/lib/opencode/client.ts). Accept: api.listSessions(), api.listMessages(id), api.listCommands(), api.listProjects() all return correctly unwrapped typed data against the live service (console-verify).
- **T4 — SSE** (src/lib/opencode/sse.ts, src/hooks/useEventStream.ts). Accept: stream opens, NexusEvent objects dispatch with correct type/data; killing the service flips state to error and back on restart.
- **T5 — Store + reducer** (src/store/nexus.ts, events.ts, selectors.ts). Accept: unit-drive applyEvent with the captured samples from /tmp/opencode/all-events.log — text/reasoning deltas accumulate by ordinal, busy flips on execution events, usage patches tokens.
- **T6 — Tokens & shell mount** (src/index.css, src/App.tsx, delete src/App.css, fonts). Accept: dark theme renders, Geist + Geist Mono load, no hero boilerplate remains.
- **T7 — Shell chrome** (components/shell/*). Accept: sidebar lists real sessions filtered by project; new session creates one via the API and activates it; ConnectionBadge reflects live status.
- **T8 — Chat** (components/chat/*). Accept (the Phase 1 money shot): send a real prompt → optimistic user bubble → assistant skeleton appears on session.step.started → text + reasoning stream in by delta → interrupt works mid-stream → a slash command (e.g. /tasks) executes → switching sessions swaps message history cleanly.
- **T9 — Rail + AiCore** (components/rail/*). Accept: token/cost block updates live from session.usage.updated; idle vs thinking states visibly distinct; reduced-motion honored.
- **T10 — Hardening + review handoff.** Offline drill (stop service, observe banner + poll recovery), rapid session-switch drill (no cross-session delta bleed — the reducer ignores chat deltas whose sessionID !== activeSessionId), then hand to reviewer (QA + security: confirm no password materializes in the browser — Network tab and window globals) and ui-designer for the visual pass.

---

## 11. Risks & open questions

- **SSE through the Vite proxy buffering** — heartbeats were verified curl-direct; if the browser sees delayed frames, the proxyRes header scrub (§2) plus no-transform should fix it. Verify in T1, not later.
- **Reconcile races** — a delta landing during a reconcile fetch could be lost; mitigations: syncGeneration counter + the 300 ms post-execution debounce. Watch in T10.
- **Cross-session bleed** — deltas carry sessionID; the reducer must ignore chat events for non-active sessions (sessions/usage bookkeeping still applies).
- **Single-slot llama server** — prompts queue server-side; long thinking gaps are normal, not hangs. AiCore + busy dot communicate this.
- **Open questions for the coordinator:** (a) markdown rendering stays deferred to Phase 2? (b) should the sidebar show child (subagent) sessions inline via parentID now, or Phase 3? Spec assumes Phase 3 (flat list now).
