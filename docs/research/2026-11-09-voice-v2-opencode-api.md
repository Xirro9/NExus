# SPEC-VOICE V2 — Installed OpenCode API Surface (EXPLORE deliverable)

**Date:** 2026-11-09 · **Target:** OpenCode v2.2.5 (`~/.opencode/bin/opencode`, 252 MB Bun ELF, JS bundle + OpenAPI spec embedded — source mined from binary via mmap string extraction; no source checkout exists on disk, no SDK package in NExus node_modules).
**Labels:** VERIFIED = read from installed dist · MEASURED = live GET probe against `http://127.0.0.1:49374` (service.json) · DOCUMENTED = Jerry code / docs · UNVERIFIED = inference, flag for P1 probe.
No POSTs, no config changes, no writes outside /tmp/opencode.

---

## A. JERRY'S EXISTING WRAPPER (client.ts + types.ts)

**Covered today** (all DOCUMENTED in `src/lib/opencode/client.ts`):
`info` · `listSessions` (+ cursor-aware `listSessionsQuery`) · `createSession` (body `{location:{directory}}` ONLY) · `listMessages` (cap 200) · `prompt` (PromptBody verbatim) · `runCommand` · `interrupt` · `deleteSession` · `listInbox` · `deleteInboxEntry` · `listAgents` · `listCommands` · `listProjects` · `listModels` · `getDefaultModel` · `setSessionModel` · `getSessionContext` · `getSessionStats` · `listPermissionRequests` · `listSessionPermissions` · `replyPermission` · `listWorktrees` · `refreshWorktrees` · `listSkills` · `listPlugins` · `listMcpServers` · `listActiveSessions` · `readFsFile` · `createDir` (transport seam).
SSE: `src/lib/opencode/sse.ts` — bare `new EventSource("/api/event")`, **no types filter, no replay, live-only**. Reducer: `src/store/events.ts` (two paths: guarded message path + global activity path), handles permission.asked/replied/session.permissions, all step/text/reasoning/tool deltas, execution.*, inbox.*.

**Gaps for voice use** (server supports it; Jerry doesn't wrap):
1. `POST /api/session` accepts `{id?, parentID?, title?, agent?, model?, location?, metadata?, permissions?}` — Jerry sends only `location`. **Agent+model pinning at creation is available and unused.**
2. `POST /api/session/{id}/agent` (switchAgent) — unwrapped.
3. `PATCH /api/session/{id}` (session.update: title/metadata/**permissions ruleset**/archived) — unwrapped.
4. Inbox **update** (change delivery steer↔queue on a pending item) — Jerry only DELETEs.
5. `interrupt` `?resume=` query param — unwrapped.
6. `POST /api/experimental/session/{id}/wait` (block until idle) — unwrapped; ideal "task finished" barrier.
7. `POST /api/session/{id}/generate` (transient text from context, no history mutation) — unwrapped.
8. `GET /api/experimental/session/{id}/log?after=&follow=` (per-session durable event stream w/ replay) — unwrapped.
9. Session forms (`question` tool): `POST /api/session/{id}/form`, `GET …/form/:formID`, `POST …/form/:formID/reply`, `DELETE …/form/:formID?message=` — unwrapped; the agent CAN block on a user question via forms.
10. `fork` / `move` / `compact` / `synthetic` / revert endpoints — unwrapped (low voice relevance).
11. PromptBody.id (client-supplied message ID) exists in types but is not exercised by callers — see B (idempotency).

---

## B. PROMPT DELIVERY SEMANTICS — `delivery: "steer" | "queue"`

- **Enum:** `Session.Inbox.Delivery = J(["steer","queue"])` — exactly two values (VERIFIED, dist). Default everywhere server-side is **`?? "steer"`** (prompt, compact, synthetic, move, command) (VERIFIED).
- **Admission:** `Session.prompt` = reconcile-by-id → create user message → `SessionInbox.admit` → durable inbox row `{id, session_id, delivery, enqueued_seq, payload, time_created}` → publish `session.inbox.enqueued`. **Idempotent: a repeat prompt with the same client-supplied `id` returns the existing input (SessionInbox.LifecycleConflict → reconciled) instead of duplicating** (VERIFIED). OpenAPI: "Durably admit one session input and schedule agent-loop execution unless resume is false."
- **Wake rule:** after admit, `if (resume !== false) wake(sessionID)` (VERIFIED). So on an **idle** session, both steer AND queue prompts **start a run immediately** — delivery only changes behavior when a run is **already active**.
- **Steer (active run):** steer items are promoted **into the CURRENT run at the next step boundary** — after the in-flight model step ends, the steered user message is injected and the run continues with it in context. Authoritative: session-diff doc — "A turn runs from the first prompt after the session was last idle until its next idle marker, **so prompts steered in while it was busy belong to the same turn**" (VERIFIED). It does NOT abort the current model stream.
- **Queue (active run):** parked; consumed **next-in-line (oldest `enqueued_seq` first), one per boundary after current work**, at the next promotion point; a runner woken with the "steer" gate skips queue items (`if (Te==="steer" && item.delivery==="queue" && !control) → Complete`) (VERIFIED, `SessionInbox.promote` + runner gate).
- **Idle:** nothing is "injected" — a fresh run consumes steer items first, then queue items in order (VERIFIED via promote ordering).
- **Events:** `session.inbox.enqueued` `{inboxID, item{type:user|synthetic|compaction|move, delivery, payload}}` → `session.inbox.delivered` `{inboxID}` (when actually consumed) → `session.inbox.cancelled` → **`session.inbox.delivery.changed`** (4th event Jerry does not handle) (VERIFIED; enqueued/delivered/cancelled MEASURED live in v2-probes.md).
- **Management:** `GET /api/session/{id}/inbox` ("List durable enqueued session work not yet delivered, ordered by enqueue sequence. Includes user, synthetic, compaction, and move items") · `DELETE …/inbox/{inboxID}` ("Cancel an inbox item that has not yet been delivered. Unavailable items are a no-op") · **inbox update** (steerInbox/queueInbox — change delivery of a pending item; server: `Pending input cannot change to <delivery>` on conflict) (VERIFIED; list+delete MEASURED live 2026-11-05, list re-measured today: `{"data":[]}`).
- **Official UI behavior:** default submit = `delivery ?? "steer"`; TUI shows pending prompts footer "steering"/"queued" with "Move to queue"/"Delete" actions (VERIFIED).
- **Voice implication:** steer = mid-task correction channel WITHOUT killing the llama slot; queue = park-behind; `resume:false` = admit-and-park explicitly. Both survive process restarts (durable rows).

---

## C. PERMISSION EVENT FLOW

- **Wire events:** `permission.asked` (payload = Permission.Request) and `permission.replied` `{sessionID, requestID, reply}` (VERIFIED, dist). `Permission.Request = {id: per_…, sessionID, action, resources[], save?[], metadata?, source?: {type:"tool", messageID, id}, message?}`; `Permission.Reply = once|always|reject`; `Permission.Effect = allow|deny|ask`, `Permission.Rule = {action, resource, effect}` (VERIFIED). A **rejection surfaces to the model as a tool error of type `permission.rejected`** (error taxonomy VERIFIED).
- **Session-level ruleset event:** `session.permissions` `{permissions: Rule[]}` — also settable via session create/update `permissions` field (VERIFIED).
- **Endpoints (all MEASURED live today unless noted):**
  - `GET /api/permission/request[?location[directory]=…]` → `{"location":…,"data":[]}` (pending, per location)
  - `GET /api/session/{id}/permission` → `{"data":[]}` (per session)
  - `POST /api/session/{id}/permission/{requestID}/reply` `{decision: "once"|"always"|"reject", message?}` — "Respond to a pending permission request owned by a session" (VERIFIED; `once`/`always` EXECUTE the action, `always` persists an allow rule — DOCUMENTED Jerry client.ts comment)
  - Saved-permission admin: `permission.saved.list / update / remove` (`/api/permission/saved/:id`) (VERIFIED, dist).
- **Jerry already wires all of it** (DOCUMENTED): `nexus.replyPermission` is the single call site (reviewer-gated), optimistic-remove + authoritative refetch on `permission.replied`/`session.permissions`, `agentState` derives `awaiting-permission` which beats "busy", StatusRail badge + permission drawer + PermissionCard. events.ts even handles the race "permission.asked arrives before the refetch heals".
- **Second blocking surface — forms (`question` tool):** events `form.created/form.replied/form.cancelled`; endpoints session.form.create/get/reply/cancel. If the client never answers, OpenCode injects: "The question couldn't be shown to the user in this client. Continue without an answer…" (VERIFIED). **Voice must handle forms or the agent silently self-answers.**
- **Voice mapping (architect input):** spoken grant can map 1:1 onto `replyPermission` (Jerry's existing UI path — no bypass); spoken reject with feedback → `message` field; or voice task simply pauses (agentState already yields `awaiting-permission`) and the announcer speaks it. No new OpenCode mechanism needed.

---

## D. ABORT / INTERRUPT

- **Endpoint:** `POST /api/session/{id}/interrupt[?resume=true|false]` (query param VERIFIED in OpenAPI schema; Jerry sends no body today → default resume=false).
- **Server semantics (VERIFIED, dist):** "Interrupt **active execution owned by this OpenCode process**. Returns `interrupted=true` when an active execution was interrupted and **false for the idle no-op**. When `resume=true`, execution resumes **pending steering input and next-in-line control items (manual compaction, moves) while queued prompts remain parked**." Response: `SessionInterruptResponse {interrupted}`.
- **Mechanism (VERIFIED):** interrupt sets `stopping=true`, records `interruptionReason`, and calls `Fiber.interrupt(runOwner)` — the run fiber is interrupted, which tears down the in-flight provider HTTP stream with it (Effect fiber abort; AI SDK request abort). On settle (reason ≠ "shutdown") it also cancels session resources and publishes `session.execution.interrupted`.
- **Does it free the llama.cpp slot?** The abort chain terminates OpenCode's HTTP request to llama-server; llama-server aborts generation on client disconnect with slot free at t+120–363 ms (MEASURED, v2-probes.md disconnect-abort test). The full OpenCode-side chain is VERIFIED; end-to-end "interrupt → `/slots.is_processing=false`" timing is UNVERIFIED — one cheap P1 probe recommended.
- **Interrupt reasons:** `session.execution.interrupted {reason: "user" | "shutdown" | "superseded" | "inactivity"}` (VERIFIED).
- **Subagents: NO cascade.** Parent interrupt kills the parent run fiber only; child (subagent) sessions are independent executions. Evidence: the TUI ships a dedicated "Interrupt subagent" command that calls `session.interrupt({sessionID: <child>})` on the child's own session ID (VERIFIED). Voice that must stop a task tree must interrupt each running child (discoverable via `/api/session?parentID=` + `/api/session/active`). UNVERIFIED edge: whether an in-flight `task` tool call in the parent is aborted cleanly while the child continues — P1 probe.
- **Interaction with inbox:** steer items stay parked after plain interrupt; `?resume=true` restarts the runner consuming steer + control items only, queue stays parked (VERIFIED). Idle interrupt = no-op false.
- **DELETE cascade re-confirmed:** OpenAPI "Delete a session **and its child sessions**" (VERIFIED; also MEASURED live 2026-11-05 per Jerry client comment).
- Related: `session.background` — "Move active foreground backgroundable tools for this session into background observation" (`POST …/background`), and `session.compact` "steers by default: runs at the next step boundary instead of waiting behind queued prompts" (VERIFIED).

---

## E. SESSION / AGENT / MODEL CONFIG

- **Create-time pinning (VERIFIED + MEASURED-adjacent):** `POST /api/session` body `{id?, parentID?, title?, agent?, model?, location?, metadata?, permissions?}`. Jerry uses only `location` today.
- **Switching (VERIFIED):** `POST /api/session/{id}/agent {agent}` ("Switch the agent used by subsequent provider turns") · `POST /api/session/{id}/model {model}` (already wrapped by Jerry; server validates NOTHING — bogus refs stored verbatim, DOCUMENTED in client.ts). Events: `session.agent.selected` / `session.model.selected {model, previous}` (VERIFIED).
- **PromptBody.agents ≠ pinning:** it is a list of **agent attachments** `{name, mention?}` (like @-mentions routing subagents) plus skill attachments `{id, name?, text?, mention?}` (VERIFIED, `Prompt.AgentAttachment`/`Prompt.SkillAttachment`).
- **Lightweight model concept:** config key **`small_model`** exists (parsed as a model ref; unparseable → "omitted unsupported legacy model reference") (VERIFIED, dist). **`default_agent`** config key also exists (VERIFIED). Neither is set on this machine (MEASURED): `~/.config/opencode/opencode.json` has `model: llamacpp/ggml-org/GLM-5.3-Flash-GGUF:Q4_K`, `enabled_providers:["llamacpp"]`, `disabled_providers:["opencode"]`, no `small_model`, no `default_agent`. `GET /api/model/default` → the single GLM (MEASURED). So today there is **no fast model to leverage**; adding one (e.g. a small local model via a second llama.cpp instance) is an operator config change, not an API limitation.
- **Agents present (MEASURED, GET /api/agent):** `build`, `plan` (primary, visible), `general`, `explore` (subagent), hidden: `compaction`, `title`, `summary`. NExus repo agents load from `.opencode/agents/` (researcher.md present) (DOCUMENTED). Note `/api/agent` ignores directory (DOCUMENTED memory).
- **SessionInfo.agent** = last turn's runner agent (MEASURED: this session shows `agent:"explore"`; parent shows null + outcome succeeded).
- **Resolved config via API:** `GET /api/config` returns per-location config documents incl. derived **policies** (`provider.use` allow/deny from enabled/disabled providers) (MEASURED). Voice-relevant: the llamacpp-only policy is enforced at config level.
- **Voice implication:** Option B/A-delegation can create a dedicated "Voice tasks" session pinned to a chosen agent (e.g. `build` or a dedicated voice-tasks agent) and model at creation — no new server support needed.

---

## F. EVENT STREAM PLUMBING

- **`GET /api/event` is GLOBAL** — "Subscribe to native events and plugin RPC events **across all server locations**" (VERIFIED). Optional **`?types=` filter** (VERIFIED): "Only send events of these types, **plus the initial `server.connected` event**. When omitted, all events are sent." Filter values are server-VALIDATED (MEASURED: invalid type → 400 `InvalidRequestError` listing the enum).
- **Volatile by contract (VERIFIED):** "a slow consumer overflows and fails the stream, and events during disconnection are missed" — subscriber capacity 4096 events, then the stream FAILS (VERIFIED string "Event subscriber exceeded its 4096-event capacity"). Heartbeat comments observed live (MEASURED). ⇒ Jerry needs reconnect + heal (it already refetch-heals; keep it).
- **Subscribable vocabulary** — 42 captured verbatim from the server's enum error (MEASURED) + tail probed individually (MEASURED ACCEPTED): location.shutdown, models-dev.refreshed, credential.updated/.switched, integration.updated, provider.updated, model.updated, agent.updated, session.created/.agent.selected/.model.selected/.moved/.renamed/.metadata.updated/.permissions/.viewed/.archived/.unarchived/.usage.updated/.deleted/.forked/.inbox.delivered/.inbox.enqueued/.inbox.cancelled/.inbox.delivery.changed/.execution.started/.succeeded/.failed/.interrupted/.instructions.updated/.synthetic/.skill.activated/.shell.started/.shell.ended/.step.started/.streamed/.ended/.failed/.text.started/.delta/.ended/.reasoning.started/.delta/.ended/.tool.input.started/.delta/.ended/.called/.success/.failed/.tool.progress/.retry.scheduled/.compaction.started/.delta/.ended/.failed/.revert.staged/.cleared/.committed, permission.asked/.replied, form.created/.replied/.cancelled, session.idle, session.status, worktree.updated/.resolved, plugin.updated, mcp.status.changed, vcs.branch.updated, project.updated, config.updated, shell.exited, skill.updated, installation.updated, and any `rpc.*`.
- **MEASURED REJECTED as filter values** (but real durable types): `session.message.content.updated`, `session.usage.recorded`, `file.edited` — replay those via the log endpoint instead.
- **Streaming payload:** each `data:` line = `{id:"evt_…", created, type, data:{…}}` (MEASURED, v2-probes.md). Deltas (text/reasoning/tool.input) are **volatile-only** events (io() vs durable oa() in dist — VERIFIED); started/ended are durable.
- **Per-session alternative (big for voice):** `GET /api/experimental/session/{id}/log?after=<seq>&follow=true` — "Experimental **durable session event log**. Reads events after an exclusive aggregate sequence and continues with live events when follow=true" (VERIFIED; MEASURED live: opens with `data: {"type":"log.synced","aggregateID":"ses_…","seq":672}` then streams). Durable events only (no deltas), but **guaranteed attribution + replay from any seq** — ideal for the voice announcer on the Voice-tasks session (no cross-session substring matching).
- **Attribution today:** every session event carries `data.sessionID`; Jerry matches on it (MEASURED in probes; DOCUMENTED events.ts `sameSession()`). With `?types=` narrowing + sessionID matching this is reliable; the log endpoint removes even that doubt for the task session.
- **Jerry gap:** sse.ts uses an unfiltered EventSource (no `types`), no log-endpoint use, no `session.inbox.delivery.changed` / `form.created` handling.

---

## G. OWNERSHIP BOUNDARIES

**OpenCode owns (do not duplicate):**
1. **Conversation history & context assembly** — messages, instructions (MEMORY/USER.md), skills, compaction, revert boundaries; DB is the truth (`opencode.db`). Read via `GET …/message`, `GET …/context`, replay via `…/log`.
2. **Session lifecycle** — create/archive/fork/move/delete(cascade)/wait; the inbox queue and its durable delivery semantics (steer/queue/cancel/update).
3. **Permission engine** — ask/reply, saved rules, per-session rulesets; rejection feedback to the model.
4. **Tool execution** — including subagent spawning (child sessions), shells/PTY, forms (question tool).
5. **Provider calls** — model routing, retries (`session.retry.scheduled`), usage/cost accounting.

**Jerry can own without conflict:**
- Voice conversation transcript (direct-GLM path) — legitimately Jerry-only; OpenCode never sees those turns (V1 §3.5 trade-off stands; no second source of truth because there is no first one on OpenCode's side).
- Voice session lifecycle: create/pin (agent+model)/delete its dedicated Voice-tasks session; steer/queue prompts into it; interrupt it (and its children) when the user says stop.
- Presentation state: announcer, agent-state chips (already derived from events), permission UI (calls OpenCode's reply endpoint — never a bypass).
- Slot visibility via llama.cpp `/slots` (outside OpenCode entirely).

**"Second source of truth" traps (architect flags):**
- Mirroring OpenCode messages into Jerry's own store → drift on revert/fork/compact/move; keep derived views rebuildable from `GET …/message` + `…/log` replay (Jerry's current design already refetch-heals — keep that invariant).
- Caching inbox state → use `GET …/inbox` + `session.inbox.*` events; DELETE-on-cancel is a no-op if already delivered.
- Duplicating permission state → poll/list + event heal, exactly as today.
- Announcing from stale event snapshots → prefer the per-session log with `after=` cursor (resumable, ordered) for the voice-tasks session.

**Bonus capability worth architect attention:** `POST /api/session/{id}/generate` — "Generate **transient** text from the current session context **without mutating session history**" (VERIFIED). A spoken summary/announcement could ride the session's own context without polluting it — but it spends the same single GLM slot.

---

## TOP FINDINGS (one-glance)

1. **`delivery` has exactly two values, default `steer`; steer = injected into the CURRENT run at the next step boundary (same turn), queue = parked next-in-line; on an idle session both start immediately.** Prompt is idempotent by client-supplied `id`; `resume:false` = admit-without-wake.
2. **Interrupt aborts the run fiber → tears down the in-flight provider HTTP request → frees the single llama slot (server disconnect-abort MEASURED at 120–363 ms).** `?resume=true` resumes steer/control but keeps queue parked. **No subagent cascade** — interrupt children by their own session IDs. DELETE cascades children (re-confirmed).
3. **Permissions are fully wire-accessible:** `permission.asked`/`permission.replied` events + `GET /api/permission/request` + `POST …/permission/{req}/reply {once|always|reject, message?}` — and Jerry already implements the whole loop. Spoken grant ⇒ existing `replyPermission` path; voice tasks can also simply pause (`awaiting-permission`). Watch the separate **forms/`question` tool** surface (form.created/replied/cancelled) — unanswered forms self-answer with an assumption.
4. **Sessions can be pinned to agent AND model at creation** (`POST /api/session {agent, model, permissions, title, parentID…}`) plus `POST …/agent` switch — the "Voice tasks" session needs no new server support. `small_model`/`default_agent` config keys exist but are UNSET here (no fast model today).
5. **`/api/event` is global but filterable (`?types=`, server-validated, always prefixes `server.connected`) and VOLATILE (4096-event overflow kills the stream; gaps on disconnect).** Better for voice: `GET /api/experimental/session/{id}/log?after=&follow=true` — durable, per-session, replayable (MEASURED live). Jerry currently uses an unfiltered EventSource.
6. **New endpoints Jerry should wrap for voice:** inbox update (steer↔queue), `interrupt?resume=`, `experimental/…/wait` (block-until-idle barrier), `session/{id}/generate` (transient, no history mutation), per-session `log`, `session.update` (incl. per-session permission ruleset).
