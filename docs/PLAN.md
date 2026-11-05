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

## Phase 1 — Foundation: connection, shell, live chat ◐

Goal: a working, beautiful chat client talking to the real OpenCode server.

- [x] Vite dev proxy: `/api/*` + `/llm/*` → local service, Basic header injected server-side (mtime cache → password rotation self-heals) — commit `1a180fc`
- [x] Typed API client (`src/lib/opencode/*`) — sessions, messages, prompt, interrupt, agents, commands, config, event SSE w/ resync + race guards
- [x] Design system: dark futuristic tokens, Geist Variable typography, readability-first contrast (spec §6 verbatim)
- [x] App shell: sidebar (sessions/projects) + main area + status rail; responsive
- [x] Live chat: session list, new session, prompt send, streaming via SSE (`session.text.delta` etc.), interrupt, slash commands — verified live end-to-end
- [x] Connection status + graceful degraded states (health poll, offline drill pending in T10)
- [x] Animated AI core (idle/thinking states, motion, reduced-motion fallback)

**Spec:** `docs/SPEC-PHASE1.md` (architect). Commits: `1a180fc`, `62b530a`.
**Remaining for Phase 1:** UI-designer visual pass → reviewer gate (incl. no-password-in-browser check) → Playwright visual inspection → T10 hardening drills.
**API correction:** v2.2.0 SSE events are granular `session.*` types — see spec §4.

## Phase 2 — Telemetry: system + inference + tokens ☐

- [ ] Node telemetry provider: CPU/RAM from `/proc`, GPU via nvidia-smi (poll ~2s)
- [ ] Inference server monitor: llama-server `/health`, `/props` (model, ctx_size), latency
- [ ] Dashboard: live charts (recharts) — GPU/CPU/RAM sparklines, server state
- [ ] Context window visualization: session tokens vs model ctx size, cache read/write, per-message breakdown
- [ ] Usage stats view from `/api/experimental/session/stats` (sessions, steps, tools, activity, models)
- [ ] SSE-driven live updates for all dashboards

**Acceptance:** every number on screen traces to a real measurement; charts update live.

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
