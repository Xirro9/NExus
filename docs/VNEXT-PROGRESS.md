# Jerry VNEXT — Progress Tracker

Primary agent: OpenCode session (GLM-5.3-Flash local). Team-driven per TEAM.md.

## Mission
Transform Jerry into a polished observability + session-management companion for OpenCode.
Phases: A (audit/architecture) → B (session/agent backend) → C (interface overhaul) → D (command center integration) → E (polish/companion foundation).

## Current Phase
**COMPLETE** — all phases (A–E) done, reviewer gates passed. Remaining: operator rebuild ritual (`npm run tauri build`, same 0.1.0 bundle paths) + restart running instance; push to origin.

## Current Task
Coordinator: tauri build + restart + final report.

## Status Log

| When | Specialist | Task | Outcome |
| --- | --- | --- | --- |
| 2026-11-06 | primary | Read TEAM.md, reviewed roster + repo structure, wrote this tracker | done |
| 2026-11-06 | primary | Live probes on opencode v2.2.5 server (Q5): delegation tool = `subagent` {agent,description,prompt}, metadata.sessionID links child; tool parts key on `name`; edit metadata {files:[{file,patch}]} | done |
| 2026-11-06 | architect | Phase A audit — gap analysis + 9-task spec (B1,B2,C1,C2,C3,D1,D2,D3,D4,E1,E2,E3) | done — keystone: `events.ts` sameSession() guard drops all tool/msg data for non-active sessions → subagent invisibility; fix = field-scoped activity summary path (D1) |
| 2026-11-06 | primary | Resolved Q1–Q5 (see DECISIONS.md); vitest approved for tests | done |

## Prior context (pre-VNEXT, from project memory)
- P0 session management shipped 2026-11-05 (commit 1ff6680): priority/stop/kill/delete/bulk + Graphify integration
- Dark native select fix 782a2c0 (color-scheme)
- Key API facts recorded in project memory + docs/API-NOTES.md (v2.2.0 SSE granular session.* events, DELETE session cascades children, no /abort endpoint — interruption via inbox delete or prompt steer, cursor pagination via requestRaw, etc.)
- Jerry = Tauri 2 shell (com.xirro9.jerry), Vite 8 + React 19 + TS 7 + Tailwind 4
- OPERATOR RULE: after every Jerry improvement — `npm run tauri build` (same 0.1.0 bundle paths) and restart running instance

## Decisions
(recorded via /decide as made)

## Outstanding Issues
(none yet)
