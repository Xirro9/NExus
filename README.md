# OpenCode Nexus

Premium AI desktop dashboard. Scaffolded and tooling-ready — app build not started.

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
