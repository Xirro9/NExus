# OpenCode Server API — Research Notes (verified against live install)

Verified 2026-11-04 against OpenCode v2.2.0 background service. Full spec saved at
`/tmp/opencode/nexus-openapi.json` (130 paths). All sample payloads in
`/tmp/opencode/nexus-api-samples/`.

## Connection & auth

- Background service URL: `http://127.0.0.1:49374` (dynamic port).
- Registration file: `~/.local/state/opencode/service.json`
  → `{ id, version, url, pid, password }`.
- **Auth = HTTP Basic, username `opencode`, password = the `password` field.**
  (`Bearer`, custom headers all fail; verified `curl -u "opencode:$PW"` works.)
- `@opencode/client/service` `Service.headers(endpoint)` does this for Node apps.
- **Browser strategy (Phase 1): Vite dev-server proxy injects the Basic header
  server-side after reading `service.json`. The password never reaches the
  browser. Tauri later: Rust side reads the same file.**
- Response envelope: most list/config endpoints return `{ location, data }` or
  `{ data }`.

## Endpoint map (what Nexus uses)

| Feature | Endpoint |
| --- | --- |
| Server info / health | `GET /api/info` |
| SSE event stream (live updates) | `GET /api/event` — `data: {id,type,data}` lines + `: heartbeat` |
| Sessions list | `GET /api/session?directory=<dir>` → `data[]` + `cursor` |
| Session detail / CRUD | `GET|PATCH|DELETE /api/session/{id}`, `POST /api/session` |
| Messages (chat history) | `GET /api/session/{id}/message` → list of messages |
| Send prompt / command / shell | `POST /api/session/{id}/prompt` `{text…}`, `/command`, `/shell` |
| Interrupt / compact / fork | `POST …/{id}/interrupt`, `/compact`, `/fork` |
| Session tokens (live totals) | session objects carry `tokens: {input,output,reasoning,cache{read,write}}`, `cost`, `time.created/updated` |
| Usage stats (real telemetry) | `GET /api/experimental/session/stats?directory=` → sessions, subagents, prompts, steps, tokens, tools{totals}, activity[], models[] |
| Agents (primary + subagents) | `GET /api/agent` → `{id,name,mode,hidden,permissions[]}` |
| Session's agents | `GET /api/session/{id}/agent` |
| Commands (slash) | `GET /api/command` |
| Projects | `GET /api/project` → `{id,canonical,time,sandboxes}` |
| Providers / models | `GET /api/provider`, `/api/model`, `/api/model/default` |
| Config (merged) | `GET /api/config` |
| Skills / plugins / MCP | `GET /api/skill`, `/api/plugin`, `/api/mcp` |
| VCS | `GET /api/vcs/status|branch|diff`, `POST /api/vcs/init` |
| File read (memory files) | `GET /api/fs/read/*`, `/api/fs/list`, `/api/fs/find` |
| Permissions inbox | `GET /api/permission/request`, `POST /api/session/{id}/permission/{requestID}/reply` |
| Worktrees | `GET|POST|DELETE /api/worktree` |
| Usage limits | `GET /api/experimental/usage/limits` |

## Message shape (chat rendering)

`GET /api/session/{id}/message` items:
`{ id, time{created,streamed}, type: "user"|"assistant", agent, model{id,providerID,variant},
content: [ {type:"reasoning"|"text", text, time{created,completed}} …] }`
Assistant messages also carry token counts per message (see live spec).

## Event types (SSE) — drive live UI

`server.connected` marker on subscribe + heartbeats. Business events observed in
the spec: `session.updated`, `session.deleted`, `message.updated`,
`message.removed`, `permission.updated`, `config.updated`, `lsp.client.*`,
`file.watcher.updated`, etc. Resync strategy: on reconnect, refetch current
session/messages/stats (no replay).

## Host telemetry (GPU/CPU/RAM) — NOT in OpenCode API

OpenCode exposes no host metrics. Real-data sources, local-first:
- **CPU/RAM**: read `/proc/stat`, `/proc/meminfo` in a small Node telemetry
  provider inside the Vite dev server (Phase 2), later a Tauri command.
- **GPU**: `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` (or
  nvml). Parse util%, mem used/total, temp, power.
- **Inference server**: llama-server at `http://172.18.0.3:8080` exposes
  `/health`, `/props` (model, ctx_size), and possibly `/metrics`. Probe and use
  what responds; degrade gracefully to "offline" state.

## Gotchas

- `GET /api/session` without `directory` returns sessions for server cwd.
- `location.directory` in responses = which project dir answered.
- SSE is live-only: no replay, no auto-reconnect — client must resync on drop.
- Auth failure body is `{"_tag":"UnauthorizedError","message":"Authentication required"}`.
