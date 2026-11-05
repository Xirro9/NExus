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
**Pipeline executed:** architect spec → developer T11–T19 (`05c9038..d38c8e8`) → ui-designer polish (`423b079`) → reviewer gate **APPROVE** → review fixes (`f0e150f`: EMPTY_TOKENS guards, UTC activity keys, spec §1 llama-URL correction) → Playwright inspection (all panels real-data verified, 0 console errors/warnings).
**Resolved:** stats query param — `project=` (OpenAPI) takes a Project.ID; `directory=` also works live; `project=<path>` matches nothing (docs/API-NOTES.md).
**Verified live:** snapshot numbers vs top/free/nvidia-smi/curl; nCtx 1048576 from /props; degrade drills (llama unreachable → retained model + propsStaleMs → one-probe recovery); view switching preserves chat; mainView persisted; reduced-motion; zero console errors/warnings.
**Optional follow-up:** restart glm-server container with `--metrics` for real KV-cache/prompt metrics.

## Phase 3 — Agents, sessions, projects, memory ☑

- [x] Agent/subagent activity visualization (xyflow live graph: pure projection of sessions+busy+active-map, 5 s reconcile poll while Agents visible) (T25)
- [x] Session history browser (server-side search/project/archived filters, cursor pagination) (T23)
- [x] Project management: project list, per-project session scoping, worktrees (read-only + refresh; mutations deliberately excluded) (T26)
- [x] Memory visibility: 5-file whitelist via `/api/fs/read`, read-only markdown viewer (T27)
- [x] Permission inbox: slide-over drawer, approve-once/reject/always (double-confirm), single reply call site (T21)
- [x] Skills / plugins / MCP status panels + markdown-it renderer (html:false, System-view-only) (T27)
- [x] Phase 1 leftover basket: sidebar child sessions, synthetic message dividers (T24)

**Spec:** `docs/SPEC-PHASE3.md` (tasks T20–T28).
**Pipeline executed:** architect spec → developer T20–T28 (`660a36f..2faa342`) → reviewer gate **APPROVE** (0 blockers; permission hard rules + fs whitelist + XSS audits pass) → review fixes (`d9339f5`: drawer focus, history double-fetch, generation guard, layering) → ui-designer polish (`d7d8978`: themed xyflow, busy-edge styling, prose cap, drawer blur) → Playwright inspection (agents graph real-time, System panels, 0 console errors) → coordinator-caught data-honesty fix (`af8392b`: rail ctx bar now reads CURRENT context via latest assistant per-message tokens, cumulative fallback labeled "est.") → targeted re-review **APPROVE**.
**Verified live:** graph renders 41 nodes/18 edges with real subagent spawns + live "running" state; history search/filter/pagination vs curl; drawer opens from rail + shield, Esc closes, empty state; all 5 memory files render; skills 7 / plugins 92 / MCP 2 match live GETs; worktree empty state honest; xyflow isolated in a 169 KB (53 KB gzip) lazy chunk; 0 console errors on a full tab tour; build+lint green at close.
**Resolved:** `unwrap()` strips `{location,data,cursor}` envelopes — cursor-aware queries need a raw-request path (docs/API-NOTES.md).
**Deferred:** live permission-request fire drill + offline-recovery drill (single-slot server busy with operator session — drill design in SPEC-PHASE3 §T21/T28); worktree mutations (Phase 4 at earliest); chat markdown rendering.

## Phase 4 — Tauri desktop shell + polish ◐ (code complete; gates pending)

- [x] Resolve system deps (`libwebkit2gtk-4.1-dev` etc. — installed by operator 2026-11-05), wire real `tauri.conf.json` identity — productName/title/brand **"Jerry"**, id `com.xirro9.jerry`, 1440×900 min 820×600, strict CSP, generated icon set (T29, `ae332ba`)
- [x] Move telemetry + auth into Tauri commands — `Transport` seam (`src/lib/transport/`, detect via `"__TAURI_INTERNALS__"`), Rust `api_fetch` (auth injected, non-`/api` rejected), SSE pump over IPC `Channel` with Rust-side reconnect, telemetry loops ported 1:1 (T30–T32, `87c4898`..`3e19336`)
- [x] Window chrome, tray, single-instance, window-state, close-to-tray (T33, `cb74cca`); "autostart of service" interpreted per spec §7 as check-at-launch only
- [x] Chat markdown: assistant text via `renderMarkdown` (`.md-body.md-chat`), streaming fence-fixup, `target=_blank rel=noopener` links (T34, `f5c784e`)
- [x] Live command verification: mock-runtime tests vs the real service — `api_fetch` roundtrip + path guard, SSE pump open→event→stop→no-reconnect (`35402fb`); telemetry shape-diff **42 leaf shapes identical** vs dev middleware; degrade matrices (llm retained-props/unreachable/recovery, gpu unavailable-no-retry) as `cargo test` harnesses
- [x] Playwright visual pass on the **built** output (`vite preview`): full 6-tab tour, 0 console errors/warnings, degraded panels honest (preview has no telemetry middleware)
- [x] `tauri dev` smoke: window boots under webkit, invoke path live (bootstrap + sessions via `api_fetch`), smoke caught missing `StreamRegistry` manage → fixed (`e0…` below)
- [ ] Motion polish pass, a11y audit, web-design-guidelines review — **ui-designer pending**
- [ ] Reviewer gate (security: password confinement, CSP, single-reply call-site, IPC surface) — **reviewer pending**
- [ ] Packaged build (`npm run tauri build` → deb/AppImage) + manual desktop checklist (tray, geometry restore, second-instance, CSP console) — pending; identifier `com.xirro9.jerry` is final before first deb
- [ ] T35 drills — **deferred with recorded cause** (docs/API-NOTES.md "Phase 4 drill results"): permission ask never fires under the operator's default config (no `permission` block → bash auto-allows); offline kill unsafe from inside the service (this session ran on it; two operator sessions live). Partial Rust coverage shipped instead.

---

## Decisions log

- 2026-11-04: Auth = Basic via dev-server proxy (browser never sees the password).
- 2026-11-04: Host telemetry via Node `/proc` + `nvidia-smi` poller in Vite middleware; Tauri-native later.
- 2026-11-04: SSE live-only → refetch-on-reconnect resync, no fabricated backfill.
