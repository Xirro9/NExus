# Making Jerry a Full Agent Harness — Research Report

**Date:** 2026-11-05 · **Author:** Jerry (GLM-5.3 via OpenCode) at Mahin's request
**Question:** (1) How do other people show visuals for their agents? (2) How hard is it to give Jerry full agent-harness capabilities, using Hermes as the scaffold?

---

## 0. TL;DR

1. **The industry converged on one framing:** `Agent = Model + Harness` (Databricks, Rubric Labs, Snowflake, Cloudflare, LangChain all publish this). The harness owns the loop, tools, context/memory, planning, delegation, permissions, and traces. Harness engineering is now a named discipline.
2. **The harness's UI job is legibility.** Every serious agent product converges on the same ~8 visuals: live plan/todo, collapsible tool-call cards, permission checkpoints, subagent tree, diff stats, reasoning disclosure, a dedicated activity panel (separate from chat), and a context/token meter. Observability is table stakes — 89% of orgs have some, 62% have detailed tracing (LangChain survey, n=1300).
3. **Key strategic insight for Jerry:** the OpenCode server **already is the harness**. It has the loop, tools, permission system, primary/subagent architecture, plan mode, todos, diffs. Jerry's gap is not "build a harness" — it is **surface + steer** what the server already streams. Porting a from-scratch loop into Jerry would be redundant work with a worse sandbox.
4. **Verified on our local v2.2.0 server (curl, 2026-11-05):** `/api/agent`, `/api/command`, `/api/session/:id/diff` exist; `GET /api/session` records carry `parentID` (27 of 50 live sessions are subagent children → tree derivable client-side). Missing vs current docs: `/todo`, `/children`, `/status`, `/abort` (404, matches known v2.2.0 gap), `/doc` OpenAPI. Todo/subagent activity still arrives via SSE event shapes.
5. **Hermes' port value** = the pieces OpenCode does *not* do: persistent memory (MEMORY/USER + recall), memory distillation, curator/skill library, scheduled jobs, specialist squad layer. Those port to TS at *moderate* difficulty. A Jerry-native tool-executing loop (sandboxing in Rust) is the only *hard* part of a from-scratch harness — and it's mostly unnecessary if Jerry drives the opencode server.
6. **Recommendation:** 4 phases — **P1 Visuals** (tool cards, todo, subagent tree, diffs; days), **P2 Control** (permission/question prompts, steer/abort, plan mode; ~a week), **P3 Hermes port** (memory + curator + distill as Jerry panels/plugins; 1–2 weeks), **P4 optional native loop** (only if Jerry must run headless without the opencode server; weeks, sandbox work in Rust).

---

## 1. What "agent harness" means (the 2026 consensus)

| Source | Definition |
| --- | --- |
| Databricks | "Software infrastructure that wraps an LLM and enables it to *act* on tasks, not just respond" — reason→act→observe loop, context compaction, self-verification |
| Rubric Labs | "The software that makes an LLM agentic… translates a model into a system that can affect its environment." Areas: looping, context, orchestration, tools, verification, permissions |
| Snowflake | "The operating layer: runs the loop, routes tool calls, injects context, maintains state, applies permissions, records traces." Two teams, same model, different harness ⇒ different task-completion rates |
| Google Cloud | "Execution environment: manages the loop, state persistence, tool invocation, memory, guardrails, HITL approvals, observability" |
| Cloudflare | "The loop that controls planning, tool use, response flow. Owns prompt construction, model execution, tool orchestration, stream handling, memory strategy, lifecycle hooks" |
| LangChain (deepagents) | Harness capabilities checklist: execution env/sandbox, tools, virtual FS, permissions, code exec, context mgmt (skills, memory, summarization/offloading), delegation (subagents), task planning, steering, human-in-the-loop |

Consensus subsystem list (this is our build checklist):

1. **Loop** — reason → act → observe → repeat; termination, retries, stuck-detection (opencode even has a `doom_loop` permission key)
2. **Tools** — registry, schemas, MCP, approval gating
3. **Context** — system prompt, history, injection, compaction/summarization, cache-stability (OpenAI's Codex loop write-up stresses stable prompt prefixes for cache hits)
4. **Memory** — persistent across sessions, recall, distillation
5. **Planning** — explicit plan/todo the model *recites* (Manus: `todo.md` recitation = working memory; the plan is visible live in the UI)
6. **Delegation** — subagents, teams, handoffs; context isolation (subagent quarantines heavy work, returns a report)
7. **Permissions / HITL** — allow/ask/deny, scoped approvals, "don't ask again", batch approval
8. **Sandbox** — where actions run (terminal, VM, browser)
9. **Traces** — every step recorded and inspectable

**Precedent for Jerry's ambition:** Anthropic's **Claude Agent SDK** = "Claude Code as a library": capabilities = built-in tools, hooks, subagents, MCP, permissions, sessions, skills, plugins, checkpointing, OTel observability, todo tracking. That list is the industry's definition of "full harness." The "harness as a library you embed behind a UI" pattern is exactly Jerry's opportunity — except our harness already exists (opencode server) and speaks an event API.

---

## 2. How everyone else shows agent visuals

### 2.1 The pattern library (agentic UX)

Three 2026 pattern catalogs agree on the anatomy. Setproduct's "16 AI agent UI design patterns" organizes by the **six phases of a delegated task**: intent → plan → execution → checkpoint → result → audit. The AI Design Guide counts 39 patterns / 7 families / 74 screenshots. A DEV.to practitioner list distills 8. Merged, the recurring set:

| # | Pattern | What it looks like | Seen in |
| --- | --- | --- | --- |
| 1 | **Live plan / todo checklist** | Steps written up-front, ticked off ("2 of 6 completed"), struck-through when done | Manus, Claude Code (task list, Ctrl+T), Relevance AI, Replit |
| 2 | **Collapsible tool-call cards / action log** | One row per action ("Read 3 files", "Edited .env"), expandable to args + result; grouped visually when parallel | Claude Code, Cursor, Appian (parallel calls share a step ID), assistant-ui ToolTimeline |
| 3 | **Permission checkpoint** | Pre-flight prompt showing *exact arguments*, two clear outcomes, "Yes, and don't ask again" | Cursor (best-in-class), Claude Code, Cline |
| 4 | **Editable plan before execution** | Markdown plan the user edits/approves; agent refuses to start until confirmed | Devin, Manus Plan Mode, Claude Code plan mode, Replit Agent |
| 5 | **Subagent panel / tree** | Named agents with status, elapsed time, token burn; tree connectors for nesting | Claude Code agent panel + subagentStatusLine, Vibe Island (3rd-party wrapper that *out-shown* the native UI → GitHub issue #48246), LangSmith trajectories |
| 6 | **Diff / file-change stats** | "3 files changed, +120 −40" chips; inline diffs per tool call | Cursor, Claude Code, Jerry-adjacent: every coding agent |
| 7 | **Reasoning disclosure** | Collapsible thinking; "if it changed the world it's a tool card, if it changed the agent's mind it's reasoning" | Claude Code, ChatGPT, Manus |
| 8 | **Activity panel ≠ chat thread** | Conversation handles clarification; a separate panel tracks autonomous work | Devin, Manus, ChatGPT Agent, deep-research feeds ("Research completed in 5m") |
| 9 | **Context/token meter** | % context used, burn rate, cost | YAS statusline ("htop for your context window"), Claude Code statusline |
| 10 | **Autonomy modes** | plan / accept-edits / auto toggle | Claude Code, Cursor, Cline |
| 11 | **Take-control / step-in** | User grabs the agent's browser or environment mid-run | ChatGPT Agent, Devin |
| 12 | **Undo / action trail** | Every world-changing step reversible, with an audit trail | Setproduct pattern 16, checkpointing in Claude SDK |

AYDesign's scoring rule is worth stealing for prioritization: **Score = (Visibility + Trust) / Effort** — which ranks collapsible panels (7.0) and named tool cards (4.5) above fancy timelines (1.5-ish); i.e. **cheap collapsible rows beat expensive visualizations**.

Design cautions that repeated across sources: a thinking state that isn't a bare spinner (short changing labels: "Reading 3 files…"); streaming without layout shift; progressive disclosure (summary → step → tool → raw payload on demand); don't merge the event stream into one markdown blob — keep parts typed; running tool calls expand by default, completed ones collapse; color never the sole status signal; respect `prefers-reduced-motion`.

### 2.2 Terminal camp (Claude Code, Codex)

- **Claude Code** — the reference terminal harness UX: `ctrl+o` transcript mode (detailed tool usage, timestamps, expands collapsed MCP calls and other-session messages), task list (`Ctrl+T`, up to 5 visible), `/focus` quiet mode (one-line tool summary + diffstats + final answer), fullscreen rendering research preview, click-to-expand tool results, **subagent panel below the prompt with a customizable `subagentStatusLine`**, agent teams with named teammates, and `f` to fork a subagent that inherits the conversation.
- **Mods (notable):** Claude Code now ships a plugin surface where hooks can *render UI*: `ui.render` fires at named render sites (`ToolUse`, `ToolResult`, `ToolGroup`, `AskUserQuestion`, `ToolProgress`…) across surfaces (`terminal`, `desktop`, `vscode`), and `$.ui` exposes toast/notify/ask/pane primitives. First-party validation that **agent UIs want a component/event contract**, not hardcoded rendering.
- **Demand signal:** GitHub issue #48246 — users complain the first-party desktop UI shows *less* about subagent activity than third-party wrappers (Vibe Island shows named tasks with status, subagent lists with elapsed time, current tool). The ecosystem (YAS, ProcessPal statuslines) exists because people want a one-box glance: context fill, burn rate, tasks, running subagents.
- **Codex (OpenAI)** published "Unrolling the Codex agent loop": model inference, tool dispatch, **context-window management as a harness responsibility**, compaction history. Useful mental model, spartan visuals.

### 2.3 Web/desktop camp (Devin, Manus, ChatGPT Agent, IDE agents)

- **Devin** — clarifying questions before committing to a plan; editable plan before execution; user can step into the VM and continue manually. Case-study architecture is *isomorphic* to Manus: sandboxed VM + browser + shell + file read/write.
- **Manus** — the deepest public write-ups:
  - **Plan Mode** (Jul 2026): manual `/plan` → clarifying questions → full Markdown plan (goals, steps, constraints) → user edits it → nothing executes until confirmed; can re-invoke mid-task to plan the *next phase*.
  - **`todo.md` recitation**: the plan file is the agent's working memory *and* the live UI element — recited each loop, so the user always sees current state. Zero-sync-between-model-and-UI by construction.
  - **Wide Research**: for wide tasks it instantly spins up ~100 concurrent **full Manus instances** (subagents are not specialized roles), each with its own context, rolling results into a sortable table/webpage. Contrast: Cognition/Claude-style *specialist* subagents.
  - **Deep-research activity feed**: streams searches/readings with a source count, ends "Research completed in 5m" + report.
- **ChatGPT Agent / Operator** — browser takeover; user can grab control at any point.
- **Cursor / Cline / Replit Agent** — strongest permission gates + inline diffs per AYDesign; Cursor keeps a "history" panel of every tool call in the current task; Cline shows a chronological timeline of the whole run.
- **Appian Agent Studio** (enterprise example) — run stream groups **parallel tool calls under one shared step ID**, each card independently updatable; a Monitor tab with a timeline replacing card-based display; test console with streamed steps.

### 2.4 React libraries & protocols (what we could build on)

**AG-UI (Agent–User Interaction Protocol)** — the open, event-based (SSE) standard from the CopilotKit team, now supported across LangGraph, CrewAI, MS Agent Framework, Google ADK, AWS Strands, Pydantic AI. Its event taxonomy is a good mirror for Jerry's SSE shapes:

- `RUN_*` lifecycle (started/finished/error), `TEXT_MESSAGE_START/CONTENT/END` (+chunk convenience)
- `TOOL_CALL_START/ARGS/END/RESULT`
- `STATE_SNAPSHOT` / `STATE_DELTA` (shared agent↔UI state)
- `REASONING_START/...` (thinking as first-class messages)
- **Subagent events** ("agent delegated work to a child agent, so a frontend can attribute output to the subagent that produced it")
- Token usage accounting events (provider/model labels + counts only)

OpenCode's granular `session.*` SSE stream covers the same ground (message parts with tool state, permission events, step events, status). **Jerry's Transport seam is philosophically an AG-UI-style layer already** — the work is rendering the parts, not inventing a protocol. (Companion spec: **A2UI** = generative UI — agents *declare* UI widgets. Not needed for Jerry v1.)

Library landscape (they sit at different layers — stack, don't swap):

| Layer | Library | What it gives | Fit for Jerry |
| --- | --- | --- | --- |
| Streaming/tool-call primitives | **Vercel AI SDK UI** (+ AI Elements) | `useChat`, typed message *parts* (tool parts with state), streaming-first | Conceptual fit only; Jerry's transport is opencode SSE, not AI SDK |
| Headless chat primitives | **assistant-ui** (11.5k★) | Thread/Message/Composer primitives, streaming markdown, auto-scroll, attachments, **ToolTimeline** ("a whole session summarized as verbs, targets, file stats"), generative UI mapping | Strong *pattern* donor; adoptable only via its ExternalStoreRuntime (custom adapter = real work) |
| Full agent framework | **CopilotKit** (36.6k★) | AG-UI runtime, generative UI, shared state, human-in-the-loop, frontend actions | Overkill + wrong backend assumptions (expects AG-UI agent backends) |

**Verdict:** Jerry already has the hard part (42-shape SSE parity + React 19 + shadcn + motion). Borrow *patterns* (ToolTimeline, progressive disclosure) rather than runtimes. Adopting assistant-ui wholesale would mean writing a custom ExternalStore adapter for opencode shapes — feasible but not blocking anything Jerry can't build directly with its existing stack.

### 2.5 Observability camp (the power-user view)

- **LangSmith Trajectories** (Sep 2026): chronological *conversational* view aggregating human/AI/tool messages across main agent + subagents in first-appearance order — "the full trace is too much detail when you're trying to understand the path the agent took." Scorable, routable to eval datasets.
- **Langfuse Agent Graphs** (Jul 2026): DAG inferred from observation timings/nesting; **Aggregated** mode (repeated steps collapse: `llm.chat (3/3)`) vs **Expanded** mode (as-it-ran). Two toggle-able views of the same trace answer different questions.
- **AgentOps**: trace list → detail → timeline view → tree view → analytics; OTel semantic conventions (`gen_ai.*`).
- **Anthropic** shipped OTel traces from Claude Managed Agents/Messages API (Oct 2026) — traces flow to Arize/Braintrust/Datadog/Langfuse/LangSmith/New Relic/PostHog. Standardization = traces are a commodity; **the differentiator is the readable trajectory view**, which is exactly what a client like Jerry can own.
- **LangChain State of Agent Engineering (n=1300, Jun 2026): 89% have observability; 62% detailed tracing; 94% among production-agent teams.**

For Jerry: opencode emits everything needed to render a local trajectory/graph view (steps, parts, subagent sessions, timings). A "session graph" tab (aggregated/expanded à la Langfuse) is a differentiating P3+ feature, not table stakes.

### 2.6 Synthesis — the convergence set

If Jerry ships these eight, it matches or beats every first-party agent UI in the market today (and per issue #48246, beats Claude Code's own desktop app on subagent visibility):

1. Live todo/plan with progress counts
2. Collapsible tool-call rows → cards with args/result/status (grouped when parallel)
3. Permission checkpoints (exact args, allow-once/always/deny)
4. Subagent tree/panel (status, elapsed, tokens, per-agent color — opencode agents already define `color`!)
5. File-change diff chips + session diff view (server: `GET /api/session/:id/diff` ✅)
6. Reasoning disclosure
7. Activity timeline separate from the chat thread
8. Context/token meter (Jerry already has per-message token telemetry — extend to a meter)

---

## 3. Gap analysis — Jerry today vs the harness checklist

**Jerry's current state (verified, bf59c6d + 09e243f):** Transport seam complete (Rust `api_fetch` + Channel SSE pump, 42-shape parity, browser path byte-identical), streaming chat markdown, per-message token telemetry, per-session model×variant switch, Tauri shell (tray/single-instance/window-state). Jerry already receives *every event it needs* — the gap is rendering, not transport.

| # | Harness subsystem | opencode server (v2.2.0) | Jerry renders today | Gap → fix |
| --- | --- | --- | --- | --- |
| 1 | Loop | ✅ owns it | N/A — Jerry drives the server | None (by design) |
| 2 | Tools | ✅ registry, MCP, gating | Tool calls surface as plain markdown | **Tool-call cards** (args/result/status, grouped when parallel) — P1 |
| 3 | Context | ✅ compaction server-side | Ctx footprint per message (af8392b) | Extend to **context meter** with burn rate — P1 |
| 4 | Memory | ❌ not a server concern | Nothing | **Hermes port** (MEMORY/USER + distill) — P3 |
| 5 | Planning | ✅ todo via SSE events (`/todo` endpoint 404 in v2.2.0) | Nothing | **Todo panel** from event shapes — P1 |
| 6 | Delegation | ✅ subagents; `parentID` on session records | Nothing | **Subagent tree** derived client-side; agents already carry `color` — P1 |
| 7 | Permissions / HITL | ✅ allow/ask/deny system | Nothing — and default config auto-allows bash | **Permission checkpoint UI** + explicit `permission` config so `permission.asked` actually fires — P2 |
| 8 | Sandbox | ✅ local process exec | N/A | None |
| 9 | Traces | ✅ full SSE stream | Chat thread only | **Activity timeline** separate from chat — P1/P2 |
| 10 | Steering | ⚠️ steer = queued prompts; **no `/abort` (404)** | Nothing | Steer UI + queued-prompt management; abort blocked on server gap — P2 |

**v2.2.0 server caveats that shape the roadmap:** no `/abort`, no `/todo`, no `/children`, no `/session/:id/status` — trust live probes over docs; steer prompts queued after a dead run are never consumed (stuck-"running" bug); permission config must be explicit or checkpoints never fire.

## 4. Hermes port — what to take, what to leave

Hermes (~/.hermes/hermes-agent, 1.03M LOC Python + 340k TS, Nous) surveyed in full. **Verdict: do not port wholesale** — its turn-loop, compression (5.7k LOC), delegation lifecycle, and SQLite state layer duplicate what the opencode server already owns.

**Port (moderate difficulty, high value):**
- Memory tool + distillation — frozen-prompt MEMORY.md/USER.md + `<memory-context>` recall blocks (already prototyped in OpenCode config: /remember /forget /nap + memory-distill plugin)
- Skills + curator library (already prototyped: ~/.config/opencode/skills, /learn /curate)
- Incremental streaming-markdown scanner — `ui-tui/src/components/streamingMarkdown.tsx` (fixes Jerry's deferred reasoning-markdown gap too)
- Subagent-tree / tool-card render patterns — `thinking.tsx`
- llama.cpp `/props` n_ctx probe — `agent/model_metadata_llamacpp.py` (fixes the stale 200k catalog limit)
- Pydantic→TS contract codegen pattern — `tui_gateway/contracts/`

**Skip (server owns it):** `agent/conversation_loop.py` + `turn_*.py`, `agent/context_compressor.py`, `tools/delegate_tool*.py`, `hermes_state_*.py`.

**Rust-side needs (Tauri, the genuinely new work):** PTY/process registry for long-running child processes, cron tick that survives app-close (background task via tauri plugin or systemd user timer).

## 5. Roadmap

| Phase | Scope | Effort | Outcome |
| --- | --- | --- | --- |
| **P1 Visuals** | Tool-call cards, todo panel, subagent tree, diff chips (`GET /api/session/:id/diff` ✅), context meter, reasoning disclosure | ~days | Matches/beats every first-party agent UI (incl. Claude Code desktop, per GH issue #48246) |
| **P2 Control** | Permission checkpoints (+ explicit `permission` config), steer UI, queued-prompt management, plan mode, activity timeline | ~1 week | Jerry can *steer* the harness, not just watch it |
| **P3 Hermes port** | Memory + distill, skills + curator, streaming-markdown scanner, n_ctx probe; PTY registry + cron in Rust | 1–2 weeks | The Hermes capabilities opencode lacks, as Jerry panels/plugins |
| **P4 native loop** | From-scratch tool-executing loop, Rust sandbox | weeks | **Skip** unless Jerry must run headless without the opencode server |

**Trim-down is a menu, not a constraint:** each P1–P3 item is an independent panel/plugin — pick exactly the subset wanted; nothing forces the rest. The architecture (opencode server = harness, Jerry = surface + steer) means every trim is a UI omission, not a subsystem amputation.
