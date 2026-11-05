# Jerry — Session Management (P0) + Graphify Integration

Implementation notes for the P0 session-control batch and the Graphify code
knowledge-graph integration. Written 2026-11-05 against opencode server
v2.2.5 and graphify CLI 0.9.103. All endpoints below were verified live
against `http://127.0.0.1:49374`.

---

## 1. P0 session management

### 1.1 Priority is organizational only

Session priority (Critical/High/Normal/Low/Paused) is **Jerry-side metadata**:

- Stored in `localStorage` under `nexus.sessionPriorities.v1`
  (`src/lib/sessionPriority.ts`), pruned when sessions are deleted.
- OpenCode v2.2.5 has **no scheduling API** — there is no endpoint a priority
  could be pushed to, and Jerry never pretends otherwise. The UI labels the
  control "Jerry-side organization only — OpenCode has no scheduling API"
  (`AgentDetailPanel`), and the badge renders purely from local state.
- It exists to help the operator triage a crowded Agents tab (sorting,
  filtering, Paused as a visual "don't bother me" marker). It does not and
  cannot affect execution order.

### 1.2 Stop vs Kill vs Delete — honest semantics

Three distinct operations, three distinct guarantees:

| Action | API calls | Conversation history | Queued prompts |
| --- | --- | --- | --- |
| **Stop** (interrupt) | `POST /api/session/{id}/interrupt` | preserved | untouched |
| **End / Kill** (terminate) | `interrupt` → `GET /api/session/{id}/inbox` → `DELETE /api/session/{id}/inbox/{inboxID}` per entry | preserved | **purged** |
| **Delete** | `interrupt` → inbox purge → `DELETE /api/session/{id}` | **gone** (server cascades child sessions) | gone with the session |

- Stop only interrupts the current run; anything already queued in the inbox
  keeps running afterwards. Kill = interrupt + purge, for "I want this agent
  fully done". The UI wording keeps them separate: `Stop` vs `End Session`.
- Never claim success unless the API confirmed: `nexus.stopSession` /
  `deleteSession` act on the responses, and delete is optimistic with
  **restore-on-failure** (the session reappears with its history if the
  server rejects).
- Verified live: `interrupt` → `{interrupted}`; `GET .../inbox` →
  `{"data":[…]}` (Jerry unwraps the envelope; entries only guarantee `id`);
  `DELETE .../inbox/{inboxID}` → emits `session.inbox.cancelled`;
  `DELETE /api/session/{id}` → 204, then 404. Deleting a parent cascades
  children server-side; Jerry mirrors removal locally (subagent DELETEs then
  404 — do not retry them).

### 1.3 Phase-3 decision reversed

PLAN.md Phase 3 said "no session deletion UI". **Reversed** in P0: the
operator needs bulk cleanup of runaway agents. Guards kept: delete requires
an explicit confirm dialog that names the session and warns that history
cannot be recovered; bulk delete lists the count.

### 1.4 UI surface

- Context menus (right-click / kebab) on graph nodes, list rows, and sidebar
  items: Inspect · Open · Stop · Kill · Delete · Copy ID · priority
  (`ui/SessionMenu.tsx`, shared `agents/sessionActions.tsx` hook).
- Agents toolbar: running/total counts, status + priority filters,
  **End All Active** (interrupt + purge, one confirm), Graph/List toggle,
  bulk selection bar (Stop selected / Delete selected / Select idle / Clear).
- Agents list view: checkbox selection, sort by priority/duration/activity.
- Detail panel: priority select, End/Delete/Copy, queued-prompt count from
  workspace `fetchInboxCount` (`null` renders as "—", never as a fact).
- Sidebar "Inspect" jumps to the Agents tab with the node selected.

---

## 2. Graphify integration

### 2.1 Ground rules

- Jerry drives the **official CLI** (`graphify`, PyPI package `graphifyy`,
  installed via `uv tool install graphifyy` → `~/.local/bin/graphify`). Jerry
  never reimplements extraction, clustering, or queries.
- **Deterministic + LLM-free by construction**: initial build is
  `extract . --code-only` → `cluster-only . --no-label --no-viz`; refresh is
  `update .` (hash-based incremental). No API key, no model, community labels
  stay placeholder.
- **Never blocks OpenCode**: every command runs as a separate OS process with
  a 300 s watchdog (5 s for detect), 256 KB output cap.
- **Optional**: if the CLI is missing, the panel shows the install hint and
  everything else in Jerry works unchanged. Graphs are per-project
  (`graphify-out/` inside the project; added to NExus `.gitignore`).

### 2.2 Transport seam (security boundary)

Three new transport methods — `graphifyDetect / graphifyStatus /
graphifyExec` — with two backends behind the existing seam:

- **Tauri (production)**: `src-tauri/src/graphify.rs` — binary resolution
  (PATH + `~/.local/bin`), strict `validate()` whitelist, watchdog exec on
  `tauri::async_runtime::spawn_blocking` (`std::process`; tokio has no
  `process` feature), status parser for `graphify-out/graph.json`.
- **Browser (dev)**: `src/server/graphify.ts` Vite middleware, exact mirror
  of the Rust whitelist, wired in `vite.config.ts` (`apply: "serve"`).

**Whitelist mirror warning**: the arg whitelist exists in three places —
`src/lib/graphify/index.ts` (builders, source of truth), `graphify.rs`
`validate()`, and `src/server/graphify.ts` `validate()`. Any change to the
builders MUST be mirrored in both validators or the command fails closed.

**Gotcha fixed during verification**: value-taking flags (`--budget 800`,
`--top 2`) must have their value token excluded from positional counting — a
plain dash-filter counts `800` as a positional and wrongly rejects every
`query … --budget` call. The Rust side already used a token walk; the TS
middleware now matches it.

### 2.3 Staleness signal (honest by design)

OpenCode v2.2.5 emits **no `filesystem.changed` events** (verified live:
touching a project file produced nothing on `/api/event`). So:

1. **Dirty flag**: the SSE `session.tool.called` events with file-edit tool
   names (`edit`, `write`, `patch`, `multiedit`, `apply_patch`,
   `applypatch` — `FILE_EDIT_TOOLS`) mark `graphDirty[projectID]` via the
   `nexus.applyEvent` → `useWorkspace.markGraphDirty` bridge (bridge lives in
   nexus because workspace cannot import nexus).
2. **Informational hint**: session `time.updated` newer than graph.json
   mtime → "Source activity since the build — the graph may be stale."
   Phrased as a possibility, never as a fact about specific files.
3. **Exact check**: `graphify update .` itself (hash-based). Verified: a
   no-change update scans 137 files and finishes in ~0.2 s; a one-file change
   re-extracts exactly that file (~1 s).

### 2.4 Skip rule

`refreshGraph(projectID, cwd, skipIfClean)` returns `"skipped"` — without
spawning a process — when the entry is `ready`, no dirty flag is set, and the
caller passes `skipIfClean`. The panel's Refresh button uses this: clicking
Refresh on a provably-fresh graph says "Already up to date — no source
changes observed since the last build, nothing ran." `skipIfClean=false`
(forces the hash check) is used by Build and any explicit rebuild path.

A successful update clears the dirty flag **only if no new file-edit event
arrived during the update** (timestamp compare against the flag captured at
start) — an edit landing mid-update keeps the flag so the next refresh runs.

### 2.5 Status + hubs

- Counts/mtime/version come from a stat + JSON header read of
  `graphify-out/graph.json` (keys `nodes`, `links`,
  `graph.graphify_version`) — no process spawn.
- Hubs ("Top connections") come from the official CLI:
  `god-nodes --json --top 5`. The CLI may print progress lines around the
  JSON array; `parseHubs` extracts the first `[…]` defensively. Hubs load
  best-effort after a successful refresh — never fail the refresh.
- Verified live (NExus): 884 nodes · 2012 links · graphify 0.9.103; hubs
  `useNexus (54)`, `react (35)`.

### 2.6 Queries

Panel input with three modes, all through the whitelist:

- **Ask** → `graphify query "<question>" --budget 800` (BFS subgraph; the
  CLI's own truncation notice is shown verbatim — honest about cut nodes).
- **Path** → `graphify path A B --undirected` (exactly two whitespace-split
  symbols; anything else is rejected client-side).
- **Explain** → `graphify explain <symbol>`.

Exit contract mapped by `describeExecFailure`: 0 = answer; 3 = ambiguous
(candidates stay visible in the output); 4 = no node match. Anything else
surfaces the last stderr line.

### 2.7 Official OpenCode integration (agents)

`graphify install --platform opencode` writes **global** config only —
`~/.config/opencode/skills/graphify/` (SKILL.md + references) and
`~/.config/opencode/plugins/graphify.js` (a `tool.execute.before` hook that
prepends a one-time-per-session `echo` reminder about graphify-out to the
first shell command when a graph exists). It does **not** touch project
`AGENTS.md` files (verified in a scratch dir). After install:

- `GET /api/skill` lists `graphify` (verified).
- Sessions in a project with `graphify-out/` get the reminder once; agents
  can then use `graphify query/path/explain` themselves.
- The plugin reminder is the official one — Jerry's UI does not duplicate it.

### 2.8 UI

`src/components/projects/GraphifyPanel.tsx`, rendered in the expanded
project card under the worktree list. Shows: status line (counts · version ·
built-at · last-update duration), staleness hint, Refresh graph / Build
graph, hubs line, and the query row. States: checking → ready / missing /
updating / error / unavailable. All copy avoids fabricating certainty
(see §2.3).

---

## 3. Verification log (2026-11-05)

- `tsc -b` clean; `oxlint` clean for new files (pre-existing warnings
  elsewhere unchanged).
- Rust: `cargo test --lib graphify` (whitelist) passes.
- CLI: no-change update 0.2 s / 0 re-extractions; +1 file → 1 re-extracted,
  884→886 nodes; −1 file → back to 884; `query/path/explain` exit 0 with
  correct output.
- Dev middleware smoke: `/graphify/detect` (available + version + path),
  `/graphify/status?cwd=…` (found with counts; `found:false` for empty dir),
  `/graphify/exec` god-nodes + query pass, `extract /etc` → 403.
- Browser (Playwright, dev server): panel renders live counts; Refresh →
  skip message with no process; Ask + Path queries return correct graph
  output.
- API: scratch session create → empty inbox → delete 204 → 404.
- Interrupt / inbox-cancel / cascade paths were live-verified earlier the
  same day (see MEMORY.md API facts).
