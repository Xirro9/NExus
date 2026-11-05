# Jerry (repo: OpenCode Nexus)

Premium AI desktop dashboard for the local OpenCode install. Product name is
**Jerry** (2026-11-05 operator decision); the repo/GitHub stay "NExus". Tauri
identifier: `com.xirro9.jerry`. Phases 1–4 implemented — see `docs/PLAN.md`
and `docs/SPEC-PHASE{1..4}.md`.

### Dev proxy & auth (Phase 1)

`npm run dev` proxies `/api/*` to the local OpenCode service, injecting HTTP
Basic auth read server-side from `~/.local/state/opencode/service.json`. The
password never reaches the browser. The **target URL is pinned at dev-server
boot** — if the service restarts on a *different port*, restart the dev server;
a password rotation self-heals on the next request (mtime-cached re-read).
Never bypass the proxy: `EventSource` cannot set auth headers itself.

### Tauri shell & the transport seam (Phase 4)

Inside the desktop shell (`npm run tauri dev` / the packaged app), the same
client code talks through a `Transport` seam (`src/lib/transport/`) instead of
the dev proxy: detection is `"__TAURI_INTERNALS__" in window`. The Tauri
implementation invokes four Rust commands (`api_fetch`, `event_stream_start`,
`event_stream_stop`, `telemetry_snapshot`) — the password stays in Rust, the
SSE stream is pumped by a Rust task over a tauri IPC `Channel`, and host
telemetry loops run in Rust (`src-tauri/src/telemetry/`, 1:1 port of the dev
middleware's cadences and degradation semantics). A plain `npm run dev` in a
browser keeps the byte-identical Phase 1 proxy path. Both upstreams are plain
HTTP; reqwest ships without a TLS stack (add `rustls` if that ever changes).

The llama-server target is resolved once at app boot from `NEXUS_LLM_URL`
(default `http://172.18.0.3:8080`, the pinned container IP) — set the env var
before launching the app if the container IP changes.

Desktop conveniences: window state restore, single-instance focus, tray
(Show/Hide/Quit), and close-to-tray (the window hides; Quit lives in the
tray — telemetry + SSE keep running while hidden).

### Telemetry middleware (Phase 2)

A Vite plugin (`src/server/telemetry.ts`) serves origin-relative
`/telemetry/snapshot` + `/telemetry/llm` JSON: CPU/RAM/load from `/proc`, GPU
via a long-lived `nvidia-smi -l 2` child, llama-server `/health` (timed) +
`/props`. It makes **zero OpenCode API calls**. The llama-server target is
resolved once at boot from `NEXUS_LLM_URL` (default `http://172.18.0.3:8080`,
the pinned container IP) — if the container IP ever changes, set the env var
and restart the dev server. Recovery after a llama container restart is
automatic (5 s health probe). Dev-server restarts wipe the ~10 min sample
rings; panels show an honest "warming up" state until they refill.

## Stack (installed & verified)

| Layer | Package | Version |
| --- | --- | --- |
| Desktop shell | Tauri 2 (`@tauri-apps/cli`, `@tauri-apps/api`) | 2.12.x |
| UI runtime | React + TypeScript (Vite 8, oxc) | React 19.3 / TS 7 |
| Styling | Tailwind CSS (v4, `@tailwindcss/vite`) | 4.3.x |
| Components | shadcn/ui (radix base, Nova preset — Lucide/Geist) | initialized |
| Animation | Motion (`motion/react`) | 14.9.x |
| Flow diagrams | React Flow (`@xyflow/react`) | 12.12.x |
| Charts | Recharts | 3.10.x |
| Icons | Lucide (`lucide-react`) | 1.68.x |

## Commands

```bash
npm run dev          # Vite dev server (port 1420, fixed — Tauri dev URL)
npm run build        # tsc -b && vite build
npm run tauri dev    # desktop dev (exercises the Rust command path)
npm run tauri build  # deb + AppImage under src-tauri/target/release/bundle/
node scripts/gen-icons.mjs   # regenerate src-tauri/icons/*.png (dependency-free)
```

## Adding shadcn components

```bash
npx shadcn@latest add <component>
```

## Adding React Bits components

React Bits ships as a shadcn-compatible registry (no npm package). With the
style you want, e.g. `default`:

```bash
npx shadcn@latest add "https://reactbits.dev/r/default/<ComponentName>-TS-CSS"
```

Browse components at https://reactbits.dev.

## Tauri system deps (installed 2026-11-05)

The Linux webview dev packages are installed; `npm run tauri dev` works.
Rust toolchain: `~/.cargo` (rustup, stable).

## Agent tooling (scoped to this project)

- `opencode.json` — project MCPs: `shadcn`, `chrome-devtools`, `context7`
  (Playwright and Motion are global; Motion MCP is hosted at mcp.motion.dev).
- Global skills apply here: `impeccable`, `motion`, `vercel-react-best-practices`,
  `web-design-guidelines` (see `~/.config/opencode/skills/.usage.json`).
