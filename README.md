# OpenCode Nexus

Premium AI desktop dashboard. Phase 1 (connection, shell, live chat) and
Phase 2 (telemetry: system/GPU/llama-server, context window, usage stats)
implemented — see `docs/SPEC-PHASE1.md`, `docs/SPEC-PHASE2.md`, `docs/PLAN.md`.

### Dev proxy & auth (Phase 1)

`npm run dev` proxies `/api/*` to the local OpenCode service, injecting HTTP
Basic auth read server-side from `~/.local/state/opencode/service.json`. The
password never reaches the browser. The **target URL is pinned at dev-server
boot** — if the service restarts on a *different port*, restart the dev server;
a password rotation self-heals on the next request (mtime-cached re-read).
Never bypass the proxy: `EventSource` cannot set auth headers itself.

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
npm run tauri dev    # desktop dev (requires Tauri system deps, see below)
npm run tauri build  # desktop bundle
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

## Pending: Tauri system deps (one-time, needs sudo)

Rust toolchain is installed (`~/.cargo`). The Linux webview dev packages are
missing — run once, then `npm run tauri dev` works:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## Agent tooling (scoped to this project)

- `opencode.json` — project MCPs: `shadcn`, `chrome-devtools`, `context7`
  (Playwright and Motion are global; Motion MCP is hosted at mcp.motion.dev).
- Global skills apply here: `impeccable`, `motion`, `vercel-react-best-practices`,
  `web-design-guidelines` (see `~/.config/opencode/skills/.usage.json`).
