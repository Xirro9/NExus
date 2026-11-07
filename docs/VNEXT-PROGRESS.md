# Jerry VNEXT — Progress Tracker

Primary agent: OpenCode session (GLM-5.3-Flash local). Team-driven per TEAM.md.

## Mission
Transform Jerry into a polished observability + session-management companion for OpenCode.
Phases: A (audit/architecture) → B (session/agent backend) → C (interface overhaul) → D (command center integration) → E (polish/companion foundation).

## Current Phase
**COMPLETE + FOLLOW-UPS COMPLETE** — all phases (A–E) done and reviewer-gated (6c259b0); the three recorded follow-ups shipped 2026-11-06 evening (203a5cb + 5667dee), each reviewer-gated, built, restarted, and smoke-passed against the live server.

## Current Task
None — mission complete. See Status Log F1–F4.

## Status Log

| When | Specialist | Task | Outcome |
| --- | --- | --- | --- |
| 2026-11-06 | primary | Read TEAM.md, reviewed roster + repo structure, wrote this tracker | done |
| 2026-11-06 | primary | Live probes on opencode v2.2.5 server (Q5): delegation tool = `subagent` {agent,description,prompt}, metadata.sessionID links child; tool parts key on `name`; edit metadata {files:[{file,patch}]} | done |
| 2026-11-06 | architect | Phase A audit — gap analysis + 9-task spec (B1,B2,C1,C2,C3,D1,D2,D3,D4,E1,E2,E3) | done — keystone: `events.ts` sameSession() guard drops all tool/msg data for non-active sessions → subagent invisibility; fix = field-scoped activity summary path (D1) |
| 2026-11-06 | primary | Resolved Q1–Q5 (see DECISIONS.md); vitest approved for tests | done |
| 2026-11-06 | developer | F1 per-session tool history: `SessionActivity.recentTools` (refs only, cap 25) + `useSessionRecentTools` hook | done — 117 tests |
| 2026-11-06 | developer | F2 sugar-high lazy-load: dynamic import, `renderMarkdown` stays sync, separate ~11.6 kB gz chunk, entry clean | done |
| 2026-11-06 | reviewer | Gate on F1+F2 | APPROVE (3 non-blocking nits; 2 fixed by coordinator: strip keys + ActiveRow doc) |
| 2026-11-06 | designer | F1 UI wiring: ActivePanel expandable recency strip (last 5, ARIA, reduced-motion-safe) | done |
| 2026-11-06 | reviewer | Gate on UI wiring | APPROVE ("ship it"; 3 non-blocking nits) |
| 2026-11-06 | primary | Build ritual + restart (0.1.0 paths preserved; lock PID 425417→436544) + operator smoke pass via Vite dev + Playwright against LIVE opencode v2.2.5 | done — **found real defect** |
| 2026-11-06 | primary | Smoke finding: live `session.tool.called` carries NO `name` (SSE capture) → summary path silently dead (Tools panel, currentTool, recentTools never populated live); name rides only `session.tool.input.started`, keyed by stable tool-call id | verified via curl SSE capture |
| 2026-11-06 | developer | F3 fix: bounded `pendingToolNames` correlation slice (cap 256, evict-oldest, released on success/failed, pruned on delete); unresolved calls bump toolsRun/kind without fabricating; graphify staleness bridge had same dead read — fixed too | done — 126 tests, wire-format fixtures |
| 2026-11-06 | reviewer | Gate on F3 | APPROVE (3 non-blocking nits, 2 pre-existing) |
| 2026-11-06 | primary | Rebuild + restart (lock PID 436544) + live re-verification: Tools panel populates from real SSE with resolved names (`execute`, run counter incrementing 1→11); Active-panel strip shares the same resolved branch (unit-covered; live catch of an active row missed only due to run/timing race — runs completed between polls) | done |

## Prior context (pre-VNEXT, from project memory)
- P0 session management shipped 2026-11-05 (commit 1ff6680): priority/stop/kill/delete/bulk + Graphify integration
- Dark native select fix 782a2c0 (color-scheme)
- Key API facts recorded in project memory + docs/API-NOTES.md (v2.2.0 SSE granular session.* events, DELETE session cascades children, no /abort endpoint — interruption via inbox delete or prompt steer, cursor pagination via requestRaw, etc.)
- Jerry = Tauri 2 shell (com.xirro9.jerry), Vite 8 + React 19 + TS 7 + Tailwind 4
- OPERATOR RULE: after every Jerry improvement — `npm run tauri build` (same 0.1.0 bundle paths) and restart running instance

## Decisions
(recorded via /decide as made)

## Outstanding Issues
- Cosmetic: Tools-panel "N tool calls this run" counter doesn't reset when Jerry connects mid-run (honest count of observed calls, but "this run" over-claims run-scoping) — pre-existing label, now visible since the panel actually populates.
- Reviewer nits (all non-blocking, accepted): `upsertToolPart` falls back to placeholder name "tool" when the active session's input.started is missed (pre-existing); `deleteSession` cascades only direct children (grandchildren healed by session.deleted SSE); `PENDING_TOOL_NAMES_CAP` lives in events.ts rather than beside sibling caps in agentState.ts; strip `aria-controls` id unmounted while collapsed (matches Radix disclosure behavior).
- Smoke-pass timing note: catching an active session's strip live requires the snapshot to land inside a ~10s run window; the data path is proven (same resolved branch as the live-verified Tools panel) and the strip rendering is unit-covered.
