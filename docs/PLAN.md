# OpenCode Nexus — Development Plan & Progress Tracker

Premium, futuristic Ubuntu desktop command center for the local OpenCode v2.2.0
installation. Local-first, open-source, real telemetry only.

**Status legend:** ☐ todo · ◐ in progress · ☑ done · ⊘ blocked/deferred
**Pipeline per phase:** Architect spec → UI Designer → Developer → Reviewer gate → Playwright visual pass

---

## Phase 0 — Research & Planning ☑

- [x] Probe live OpenCode service, map 130-endpoint OpenAPI surface
- [x] Solve auth (Basic `opencode:<password>` from `~/.local/state/opencode/service.json`)
- [x] Verify SSE `/api/event`, sessions, messages, stats, agents, skills, projects
- [x] Identify host-telemetry gap → local providers (/proc, nvidia-smi, llama-server /health)
- [x] Write `docs/API-NOTES.md`

## Phase 1 — Foundation: connection, shell, live chat ☑

Goal: a working, beautiful chat client talking to the real OpenCode server.

- [x] Vite dev proxy: `/api/*` + `/llm/*` → local service, Basic header injected server-side (mtime cache → password rotation self-heals) — commit `1a180fc`
- [x] Typed API client (`src/lib/opencode/*`) — sessions, messages, prompt, interrupt, agents, commands, config, event SSE w/ resync + race guards
- [x] Design system: dark futuristic tokens, Geist Variable typography, readability-first contrast (spec §6 verbatim)
- [x] App shell: sidebar (sessions/projects) + main area + status rail; responsive
- [x] Live chat: session list, new session, prompt send, streaming via SSE (`session.text.delta` etc.), interrupt, slash commands — verified live end-to-end
- [x] Connection status + graceful degraded states (health poll, offline dimming, 401/409 toasts)
- [x] Animated AI core (idle/thinking states, motion, reduced-motion fallback)

**Spec:** `docs/SPEC-PHASE1.md` (architect; corrected v2.2.0 SSE event types — granular `session.*`, not `message.updated`).
**Pipeline executed:** architect spec → developer T1–T9 (`1a180fc`, `62b530a`) → ui-designer polish (`a0d7e81`) → reviewer gate **APPROVE** (security clean: password only in proxy process) → review fixes (`b30186f`) → Playwright visual inspection.
**Verified live:** streamed reply, slash command w/ tool part, interrupt mid-stream, session switching, real token/cost telemetry, reducer 11/11 vs captured event log, responsive @1680/1100/820px, reduced-motion.
**Queued polish (non-blocking, for T10/Phase 2):** style synthetic messages (`[idle]`, `[/command]`, `[system]`) as subtle labeled dividers instead of raw bracket text; strict FIFO tmp-id→delivered matching; T10 offline + rapid-switch drills.

## Phase 2 — Telemetry: system + inference + tokens ☑

- [x] Node telemetry provider: CPU/RAM from `/proc`, GPU via nvidia-smi (poll ~2s) — Vite plugin middleware `/telemetry/*` (T11–T12)
- [x] Inference server monitor: llama-server `/health`, `/props` (model, ctx_size), latency (T12)
- [x] Dashboard: live charts (recharts) — GPU/CPU/RAM sparklines, server state (T15–T16)
- [x] Context window visualization: session tokens vs model ctx size, cache read/write, per-message breakdown (T17)
- [x] Usage stats view from `/api/experimental/session/stats` (sessions, steps, tools, activity, models) (T18)
- [x] Live updates via 2 s poll of `/telemetry/snapshot` (our middleware — NOT OpenCode SSE; zero OpenCode API load) (T14)

**Spec:** `docs/SPEC-PHASE2.md` (tasks T11–T19).
**Resolved:** stats query param — `project=` (OpenAPI) takes a Project.ID; `directory=` also works live; `project=<path>` matches nothing (docs/API-NOTES.md).
**Verified live:** snapshot numbers vs top/free/nvidia-smi/curl; nCtx 1048576 from /props; degrade drills (llama unreachable → retained model + propsStaleMs → one-probe recovery); view switching preserves chat; mainView persisted; reduced-motion; zero console errors/warnings.

## Phase 3 — Agents, sessions, projects, memory ☐

- [ ] Agent/subagent activity visualization (xyflow live graph: primary → subagent spawn/activity, from SSE message events)
- [ ] Session history browser (search, filter by project, stats per session)
- [ ] Project management: project list, per-project session scoping, worktrees
- [ ] Memory visibility: read MEMORY.md / USER.md / DECISIONS.md via `/api/fs/read`, read-only viewer
- [ ] Permission inbox: approve/deny pending permission requests
- [ ] Skills / plugins / MCP status panels

**Acceptance:** run a task that spawns a subagent; watch the graph update live.

## Phase 4 — Tauri desktop shell + polish ☐

- [ ] Resolve system deps (`libwebkit2gtk-4.1-dev` etc.), wire real `tauri.conf.json` identity
- [ ] Move telemetry + auth into Tauri commands (drop dev-proxy dependency)
- [ ] Window chrome, tray, autostart of service if healthy
- [ ] Motion polish pass, a11y audit, web-design-guidelines review
- [ ] Full review + Playwright final visual pass

---

## Decisions log

- 2026-11-04: Auth = Basic via dev-server proxy (browser never sees the password).
- 2026-11-04: Host telemetry via Node `/proc` + `nvidia-smi` poller in Vite middleware; Tauri-native later.
- 2026-11-04: SSE live-only → refetch-on-reconnect resync, no fabricated backfill.
