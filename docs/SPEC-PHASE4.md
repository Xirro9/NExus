# OpenCode Nexus — Phase 4 Implementation Spec (Tauri desktop shell + final polish)

**Scope:** real desktop identity, the auth/telemetry seam replacement for the packaged app (Rust commands), desktop conveniences, deferred drills, chat markdown, final quality pass. This is the final phase.
**Pipeline position:** Architect spec → Developer (this doc is the build contract) → Reviewer gate (QA + security) → ui-designer → Playwright visual pass on the built app.
**Repo root:** `/home/mg-12623-8/ai-workbench/projects/NExus` (GitHub origin, branch master). All paths relative to repo root.
**Builds on SPEC-PHASE1/2/3.md** — task numbering continues from T28. Where this doc conflicts with earlier specs, **this doc wins** for Phase 4 scope.

---

## 0. Verified ground truth (2026-11-04, read from the repo)

1. **Tauri scaffold is present but bare.** `src-tauri/Cargo.toml`: `tauri 2.12.5`, `tauri-build 2.7.4`, `tauri-plugin-log`, `serde`/`serde_json`, `log`. **No** reqwest, **no** window-state/single-instance plugins, **no** `tray-icon` feature, **no** custom commands; `lib.rs` is the stock template. `@tauri-apps/api ^2.12.4` + `@tauri-apps/cli ^2.12.4` are in package.json; **no** `@tauri-apps/plugin-*` JS packages (none needed); **no** `"tauri"` npm script (must add).
2. **tauri.conf.json:** `devUrl http://localhost:1420` and `frontendDist ../dist` are **already correct**; `identifier` is the placeholder `com.tauri.dev`; `productName` "Jerry" (operator decision 2026-11-05); window 800×600 (too small for the 6-tab layout); `csp: null`; bundle icons are Tauri defaults (placeholders).
3. **capabilities/default.json** = `["core:default"]` only. In Tauri v2, **app-defined commands registered via `invoke_handler` are not ACL-gated** (capabilities gate plugin commands). All Phase 4 functionality is Rust-side or custom commands → **no capability changes required**.
4. **Client layer (verified by reading the code):** `src/lib/opencode/client.ts` — everything through `request`/`requestRaw`/`readFsFile` → plain `fetch` to origin-relative `/api` paths; `src/lib/opencode/sse.ts` — `new EventSource("/api/event")` (auth via dev proxy); `src/store/telemetry.ts` — `fetch(TELEMETRY_SNAPSHOT_PATH)` 2 s poll (its header comment already says "Phase 4 swaps the transport in this file"); `vite.config.ts` — `/api` proxy with mtime-cached `readService()` injecting Basic auth, `telemetryPlugin()` mounting `/telemetry/*`.
5. **`src/server/telemetry.ts` is the exact porting reference** (§4): /proc math, long-lived `nvidia-smi -l 2` child + 30 s compute-apps one-shot, llama /health 5 s + /props 60 s, ring capacities 300/300/150, full degradation matrix.
6. `markdown-it@15` + `src/lib/markdown.ts` (`html:false`) exist in-repo, System-view-only today.
7. **cargo/rustc availability could NOT be verified** from this session (shell is denied for read-only agents) — §9 defines a two-path acceptance strategy.
8. System deps (libwebkit2gtk-4.1-dev, librsvg2-dev, libayatana-appindicator3-dev, build-essential, libssl-dev, libxdo-dev, pkg-config) are **pending user installation** (PLAN Phase 4 bullet 1) — every Rust task gates accordingly (§9).

---

## 1. The core decision — transport seam (scope B)

**Problem:** the packaged app has no Vite server → no `/api` proxy (Basic auth injection) and no `/telemetry/*` middleware. The webview origin (`tauri://localhost` / `http://tauri.localhost`) cannot fetch `http://127.0.0.1:49374` cross-origin without CORS cooperation we do not control, and `EventSource` cannot set auth headers anywhere.

### Options evaluated

1. **tauri-plugin-http** (JS fetch shim → Rust reqwest): **rejected.** Provides `fetch`, not `EventSource` — SSE stays broken; the auth header would be set from JS, putting the password in the webview (violates the Phase 1 decision "password never reaches the browser"); adds a permission allowlist to maintain.
2. **window.fetch monkey-patch / custom protocol handler:** one global seam, but invisible magic, untyped, still doesn't fix `EventSource`. Rejected.
3. **Localhost sidecar/proxy server inside the Tauri process:** duplicates the Vite proxy code, binds a port (firewall prompt, collision risk). Rejected.
4. **CHOSEN — explicit `Transport` interface, two implementations; OpenCode HTTP + SSE move into Rust commands.** Smallest clean seam: exactly **three** client touch points (`client.ts` request layer, `sse.ts` consumer, `store/telemetry.ts` tick). Password stays in Rust; the SSE problem is solved by a Rust pump task over `tauri::ipc::Channel`; the dev/browser path is untouched.

**Why reqwest is justified (the §C judgment):** the HTTP need is *not* only llama health/props — the packaged app must also reach OpenCode (`api_fetch` + the SSE byte stream). One dependency serves both plus the llama probes. Cost: reqwest(+hyper) adds ~2–4 MB to the binary and real first-compile time (§10). Shipped with `default-features = false` (no TLS stack): both upstreams (127.0.0.1 OpenCode, 172.18.0.3 llama) are plain HTTP; if either ever moves to https, add the rustls feature then (documented limitation).

**Mode detection:** `"__TAURI_INTERNALS__" in window` — **not** `import.meta.env.TAURI_ENV_*` (those are set whenever the tauri CLI spawns vite, i.e. during `tauri dev`; the window check is the only signal that answers "is *this* webview inside the Tauri shell", which is the question that matters). Consequence: in `npm run tauri dev` the webview loads localhost:1420 **with** `__TAURI_INTERNALS__` → uses the invoke transport → **we test what ships**. Plain `npm run dev` in a browser → http transport → dev proxy path byte-identical to today.
---

## 2. Client seam — exact TS interface (scope B, contractual)

### New files

```
src/lib/transport/types.ts    — interface + response types (below)
src/lib/transport/http.ts     — browser impl (fetch + EventSource)
src/lib/transport/tauri.ts    — Tauri impl (invoke + Channel)
src/lib/transport/index.ts    — isTauri() + transport selection
```

```ts
// src/lib/transport/types.ts
import type { NexusEvent, StreamState, EventStreamHandle } from "@/lib/opencode/sse"
import type { TelemetrySnapshot } from "@/lib/telemetry/types"

export interface TransportRequestInit {
  method?: string                       // default "GET"
  body?: string | null                  // pre-serialized JSON (client.ts already serializes)
  headers?: Record<string, string>      // content-type etc. — NEVER "authorization"
}
export interface TransportResponse {
  status: number
  ok: boolean
  bodyText: string                      // "" for 204
}
export interface Transport {
  request(path: string, init?: TransportRequestInit): Promise<TransportResponse>
  telemetrySnapshot(): Promise<TelemetrySnapshot>
  connectEvents(onEvent: (e: NexusEvent) => void, onState: (s: StreamState) => void): EventStreamHandle
}
```

```ts
// src/lib/transport/index.ts
import type { Transport } from "./types"
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}
export const transport: Transport = isTauri()
  ? (await-import-free lazy: see note)  // resolved at module init via static imports in tauri.ts
  : httpTransport
```
(Implementation note: use plain static imports of `httpTransport`/`tauriTransport` and select with the ternary at module scope — `@tauri-apps/api/core` evaluates side-effect-free in a plain browser, and calling `invoke` there is impossible when `!isTauri()`.)

### Surgical edits to existing files

- `src/lib/opencode/client.ts` — `requestRaw`: replace `fetch(path, init)` with `transport.request(path, { method: init?.method, body: init?.body ?? null, headers: init?.headers })`. The ApiError mapping is unchanged (`!res.ok` → parse `{_tag, message}` from `res.bodyText`; 204 → `bodyText: ""` → `undefined as T`). `readFsFile` → `transport.request` + `bodyText`. **No api.* signature changes.**
- `src/store/telemetry.ts` — `tick()`: `const snapshot = await transport.telemetrySnapshot()` instead of `fetch`. Everything else (2 s cadence, inFlight guard, error retention) unchanged.
- `src/lib/opencode/sse.ts` — stays as-is: it remains the browser (EventSource) impl and the shared vocabulary (`NexusEvent`, `StreamState`, `EventStreamHandle`). `src/hooks/useEventStream.ts` imports `connectEvents` from `@/lib/transport` instead of `@/lib/opencode/sse`.

### tauri.ts behavior

- `request`: `invoke<ApiFetchResponse>("api_fetch", { args })` → `{ status, ok: status >= 200 && status < 300, bodyText: body }`. HTTP error statuses are **returned, never rejected** (client.ts maps them); IPC/transport failures reject with `Error` (client.ts lets them propagate, same as `fetch` network errors today).
- `telemetrySnapshot`: `invoke<TelemetrySnapshot>("telemetry_snapshot", { tail: null })`.
- `connectEvents`: `new Channel<StreamFrame>()` → `onmessage`: `kind === "event"` → map `event` to `NexusEvent` (same defaults as sse.ts: `id ?? null`, `created ?? Date.now()`, `data ?? {}`) → `onEvent`; `kind === "state"` → `onState(state)`. `invoke("event_stream_start", { channel })` resolves with `streamId`; `close()` → `invoke("event_stream_stop", { streamId })`.

---

## 3. Rust layout, commands, config diffs (scopes A + B)

### Rust file layout (all new files)

```
src-tauri/src/
  main.rs            (unchanged)
  lib.rs             builder: plugins (single-instance FIRST), managed state, invoke_handler, tray, close-to-tray
  service.rs         ServiceTarget + mtime-cached service.json reader (port of vite readService())
  api.rs             api_fetch command (async reqwest pass-through with auth injection)
  sse_pump.rs        event_stream_start / event_stream_stop commands (SSE → Channel)
  telemetry/
    mod.rs           TelemetryState, loop spawner, snapshot assembly, telemetry_snapshot command
    system.rs        /proc/stat + /proc/meminfo + /proc/loadavg
    gpu.rs           nvidia-smi -l 2 long-lived child + 30 s compute-apps one-shot
    llm.rs           /health (timed) + /props probes
    ring.rs          RingBuffer<T> (VecDeque port of src/server/ring-buffer.ts)
```

### service.rs

```rust
pub struct ServiceTarget { pub base_url: String, pub auth_header: String } // auth_header = "Basic …"
/// mtime-cached (stat → re-parse only on change); None when unreadable.
pub fn resolve() -> Option<ServiceTarget>
```
Path: `(std::env::var("HOME")?)+"/.local/state/opencode/service.json"` — fields `url`, `password`; auth = `"Basic " + base64("opencode:" + password)` (add `base64 = "0.22"` to Cargo deps — tiny). Password rotation self-heals per request, same as vite.

### api.rs

```rust
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ApiFetchArgs { pub method: String, pub path: String,
  #[serde(default)] pub headers: HashMap<String, String>, pub body: Option<String> }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct ApiFetchResponse { pub status: u16, pub body: String }

#[tauri::command]
pub async fn api_fetch(client: tauri::State<'_, reqwest::Client>, args: ApiFetchArgs)
  -> Result<ApiFetchResponse, String>
```
- Behavior: `resolve()` → `reqwest::Client` request `method(base_url + path)` with `.header("authorization", auth_header)` + extra headers + body; read the full body as text; return `{status, body}`. **Never** rejects on HTTP error statuses; rejects `Err(String)` only on transport failure (service.json unreadable → `Err("opencode service.json unreadable")`, connect/timeout errors → message).
- Guard: `path` MUST start with `/api` — reject anything else (defense in depth; the client only ever sends `/api`).
- Timeouts: connect 5 s, total 30 s (message-list bodies can be MBs — generous but bounded).

### sse_pump.rs

```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct StreamFrame { pub kind: String,        // "state" | "event"
  pub state: Option<String>,                      // "open" | "error"
  pub event: Option<serde_json::Value> }          // parsed SSE envelope
#[derive(Default)]
pub struct StreamRegistry(Mutex<HashMap<u32, Arc<AtomicBool>>>); // id → stop flag

#[tauri::command]
pub async fn event_stream_start(app: tauri::AppHandle, registry: tauri::State<'_, StreamRegistry>,
  channel: tauri::ipc::Channel<StreamFrame>) -> Result<u32, String>
#[tauri::command]
pub fn event_stream_stop(registry: tauri::State<'_, StreamRegistry>, stream_id: u32) -> Result<(), String>
```
- Pump = `tokio::spawn` loop: `resolve()` → GET `base_url + "/api/event"` with auth header, no overall timeout; on 200 → send `{kind:"state", state:"open"}`; stream `bytes_stream()`, parse SSE frames (`data: ` lines, blank-line delimited; `: heartbeat` comment lines ignored); each frame → `serde_json::from_str` → send `{kind:"event", event}`; on stream end/error → send `{kind:"state", state:"error"}`; check stop flag → sleep 2 s → reconnect.
- **The reconnect loop lives in Rust**, mirroring `EventSource` auto-reconnect so `useEventStream`'s resync semantics work verbatim. Exit conditions: stop flag set, `channel.send` returns Err (webview gone), or app exit.
- Registry: `start` allocates id + `Arc<AtomicBool>`, `stop` flips the flag and removes the entry.

### telemetry/mod.rs

```rust
pub struct TelemetryState { /* Mutex-protected rings + flags; spawned once */ }
impl TelemetryState { pub fn spawn() -> Self }   // called from lib.rs .manage(...)

#[derive(Deserialize, Default)] #[serde(rename_all = "camelCase")]
pub struct TailSpec { pub system: Option<usize>, pub gpu: Option<usize>, pub llm: Option<usize> }

#[tauri::command]
pub fn telemetry_snapshot(state: tauri::State<'_, TelemetryState>, tail: Option<TailSpec>)
  -> serde_json::Value   // never fails — returns the current (possibly warming) snapshot
```
- Threads: **system + gpu loops on one dedicated `std::thread`** (blocking /proc reads + child stdout — natural fit; 2 s tick, compute-apps every 15th tick = 30 s). **llm probes on `tokio::spawn` + `tokio::time::interval`** (5 s health, 60 s props, props-on-recovery) using the shared async reqwest client, health total-timeout 2 s.
- `LLM_URL = env::var("NEXUS_LLM_URL") ?? "http://172.18.0.3:8080"` — read once at spawn.
- **Snapshot JSON must serialize to EXACTLY the `TelemetrySnapshot` shape** (SPEC-PHASE2 §2.6, field-for-field: `now`, `system.{ok,error,samples[]}`, `gpu.{ok,error,source,computeApps[],samples[]}`, `llm.{ok,error,url,status,latencyMs,model,propsStaleMs,samples[]}` — serde structs with `#[serde(rename_all = "camelCase")]`; f64 for cpu/powerDraw/latencyMs, u64 for mem bytes, `memUsedMiB` f64). T32 verifies by deep shape-compare against the dev middleware's output.
- `tail` arg truncates via `ring.tail(n)` — the pre-built throttle lever (§10.3); the store passes `null` (full parity today).

### ring.rs

```rust
pub struct RingBuffer<T> { cap: usize, buf: VecDeque<T> }
impl<T: Clone> RingBuffer<T> {
  pub fn new(cap: usize); pub fn push(&mut self, item: T);
  pub fn tail(&self, n: Option<usize>) -> Vec<T>; pub fn len(&self) -> usize;
}
```

### lib.rs (target shape)

```rust
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| { /* show + focus main window */ }))
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .setup(|app| { /* log plugin (debug only, unchanged); build tray (§5) */ Ok(()) })
    .manage(reqwest::Client::new())
    .manage(StreamRegistry::default())
    .manage(TelemetryState::spawn())
    .invoke_handler(tauri::generate_handler![api_fetch, event_stream_start, event_stream_stop, telemetry_snapshot])
    .on_window_event(|window, event| { /* CloseRequested → prevent_close + hide (§5) */ })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
```
No `unwrap()`/`expect()` on external data anywhere (reviewer rule); all command fns return `Result`.
---

## 4. tauri.conf.json diff (scope A, exact)

```json
{
  "$schema": "../node_modules/@tauri-apps/cli/config.schema.json",
  "productName": "Jerry",
  "version": "0.1.0",
  "identifier": "com.xirro9.jerry",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [{
      "title": "OpenCode Nexus",
      "width": 1440, "height": 900,
      "minWidth": 820, "minHeight": 600,
      "resizable": true, "center": true, "fullscreen": false
    }],
    "security": {
      "csp": "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["deb", "appimage"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]
  }
}
```

- `identifier` `com.tauri.dev` → `com.xirro9.jerry`. **Flag for the operator:** the package identity is effectively permanent (upgrade path) — confirm before the first packaged build (T36); trivially changeable until then.
- Window 1440×900 fits the 6-tab + rail layout; min 820×600 = the responsive floor verified in Phase 1 (1680/1100/820).
- CSP: fonts are bundled (`@fontsource`) so `font-src 'self'` suffices; `'unsafe-inline'` style is required by runtime-injected styles; `ipc:` + `http://ipc.localhost` are Tauri v2's IPC transports (Linux); Tauri auto-nonces its own injected scripts. Reviewer item: boot with this CSP and confirm zero console violations; if a violation is unfixable this phase, fall back to `csp: null` **with a reviewer-noted exception** — never silently.
- `targets`: deb + appimage (Ubuntu). Drop the `android` block (mobile out of scope).
- `capabilities/default.json`: **NO CHANGES** — app commands are not ACL-gated; window-state/single-instance/tray are Rust-side. Keep `["core:default"]`.

### Cargo.toml additions (exact)

```toml
[dependencies]
tauri = { version = "2.12.5", features = ["tray-icon"] }   # was feature-less — add tray-icon
tauri-plugin-window-state = "2"
tauri-plugin-single-instance = "2"
reqwest = { version = "0.12", default-features = false, features = ["json", "stream"] }
tokio = { version = "1", features = ["time", "macros"] }    # tauri pulls tokio; explicit for intervals/spawn
base64 = "0.22"
```
(`serde`, `serde_json`, `log`, `tauri-plugin-log`, `tauri-build` stay.) **No `@tauri-apps/plugin-*` JS packages** — none needed.

### package.json

Add one script: `"tauri": "tauri"`. Nothing else changes.

### Icons (scope A)

- **`scripts/gen-icons.mjs`** — dependency-free PNG generator: draws the AiCore mark (concentric rings + center dot, primary cyan ≈ `#67e8f9` on background deep-navy ≈ `#14141f`, alpha falloff on outer rings) into an RGBA buffer at each size, encodes PNG via `node:zlib` deflate + hand-rolled IHDR/IDAT/IEND chunks + CRC32 (~80 lines, no native deps). Outputs: `src-tauri/icons/32x32.png`, `128x128.png`, `128x128@2x.png` (256), `icon.png` (512).
- `.icns`/`.ico` remain shipped placeholders (unused on Linux; flagged in §10 so nobody mistakes them for final). `bundle.icon` list unchanged.

---

## 5. What stays / what changes in dev mode (scope B)

- `vite.config.ts`: **UNCHANGED.** The `/api` proxy + `telemetryPlugin()` stay exactly as-is for `npm run dev` in a browser. The Tauri path is **additive, not a replacement**.
- `src/server/telemetry.ts` + `ring-buffer.ts`: **KEPT** (dev middleware; `apply: "serve"` means builds never start the loops). It becomes the reference implementation — T32 diffs the Rust snapshot against it.
- `src/lib/opencode/sse.ts`: kept (browser impl + shared types). **No files are deleted this phase.**

---

## 6. Telemetry in Rust (scope C) — parity contract

Port table (Node → Rust); identical cadences, ring capacities, and degradation semantics. `src/server/telemetry.ts` line refs are the spec.

| Loop | Node reference | Rust | Cadence / semantics (identical) |
| --- | --- | --- | --- |
| system | `sampleSystem` (telemetry.ts:101–129) | `telemetry/system.rs` | 2 s. CPU% = Δ between consecutive `/proc/stat` aggregate lines: `totalΔ = ΣfieldsΔ`, `idleΔ = (idle+iowait)Δ`, `cpu = totalΔ>0 ? (1−idleΔ/totalΔ)×100 : 0` (first sample warming = 0, clamped 0..100); `memUsed = (MemTotal−MemAvailable)×1024`; `load1` = field 1 of `/proc/loadavg`. Read failure → `system.ok=false` + error string. |
| gpu | `startGpuLoop` (§:131–280) | `telemetry/gpu.rs` | Long-lived `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits -l 2` child; stream stdout lines; block flush on index reset + 1.5 s tail-flush timer equivalent; CSV split on `'", "'` when present else `", "`; NaN → 0 + parseWarned flag; ENOENT → `source:"unavailable"`, **stop retrying**; child exit → backoff respawn 30 s doubling to 300 s, reset after 5 min stable. |
| compute apps | `sampleComputeApps` (§:282–314) | same thread, every 15th tick | 30 s one-shot `--query-compute-apps=pid,process_name,used_memory`; `used_memory` carries `" MiB"` suffix → parse leading float; non-zero exit keeps last good data. |
| llm health | `probeHealth` (§:319–358) | `telemetry/llm.rs` | 5 s, tokio interval. Timed GET `/health` (2 s timeout): ok + `status=="ok"` → `"ok"` (recovery triggers immediate props fetch); other HTTP → `"starting"`; error/timeout → `"unreachable"`, latency null. Push `{t, status, latencyMs}` to the 150-ring. |
| props | `fetchProps` (§:360–385) | same file | Boot + 60 s + on recovery. GET `/props` → `model {path, alias, nCtx, slots, build, isSleeping}` (`build_info`: string, else JSON-stringified); on failure **keep last good model** (`propsStaleMs` climbs). |

Rings: 300 / 300 / 150 (identical). Snapshot assembly identical to `buildSnapshot` (telemetry.ts:390–416). **Zero OpenCode API calls from Rust telemetry** — same single-slot rule as Phase 2.

---

## 7. Desktop conveniences (scope D)

- **Window state:** `tauri-plugin-window-state` (Rust-side auto save/restore of size/position/maximized). No JS API, no capability entry.
- **Single instance:** `tauri-plugin-single-instance`, registered **first**; callback shows + focuses the existing main window.
- **Tray:** `tray-icon` feature; menu: **Show Nexus / Hide Nexus / ─ / Quit** (`app.exit(0)`). Icon: the generated 32x32.png. Tooltip "OpenCode Nexus". Left-click → show + focus.
- **Close-to-tray — DECIDED: YES.** `on_window_event` → `WindowEvent::CloseRequested { api, .. }` → `api.prevent_close()` + `window.hide()`. Rationale: Nexus is an always-on monitor (2 s telemetry, SSE, permission inbox) — closing the window should not silently kill monitoring; Quit lives in the tray. Risk accepted with mitigation (§10.6).
- **Boot health:** `bootstrap()` already pings `api.info()` through the transport → degraded banner when the service is down. **Nexus never starts/stops the OpenCode service or glm-server** (PLAN's "autostart of service if healthy" is interpreted as check-at-launch only — see exclusions).
---

## 8. Chat markdown rendering (scope F) — DECIDED: FOLD IN

**Yes, fold into Phase 4.** Justification: the renderer and its sanitization already exist in-repo (`src/lib/markdown.ts`: `html:false, linkify:true`, markdown-it default `validateLink` blocks `javascript:`/`data:`) — the Phase 1/3 deferral existed only because the renderer didn't exist yet; the diff is one component plus a scoped CSS block. Cost is ~30 lines; a whole phase of "deferred" debt retires.

Spec:
- `MessageBubble.tsx` — **assistant text parts** render through `renderMarkdown()` into a `.md-body.md-chat` container (same escaping rules as System views; chat-scoped overrides: tighter paragraph margins, headings capped at 16 px, code blocks use the existing mono/`--card` styling). While `message.streaming`, render markdown **live** with a fence-fixup: count ``` occurrences in the partial text; if odd, append `"\n\n\u0060\u0060\u0060"` to the *render source only* (never to the store) so half-fenced code doesn't jump layouts. Streaming cursor stays appended after the rendered block.
- **Reasoning blocks: UNCHANGED** (plain dim italic text — reasoning is stream-of-consciousness; markdown there is noise).
- **User messages: UNCHANGED** (`whitespace-pre-wrap` — user input is literal). **Tool parts: UNCHANGED.**
- Links: add a 3-line markdown-it renderer rule → `target="_blank" rel="noopener noreferrer"` (the webview has no tab UI). Record actual click behavior in the T34 acceptance.
- Reviewer XSS audit additions to the T20 test battery: `<img src=x onerror=alert(1)>` and `[x](javascript:alert(1))` inside an assistant message must render inert (escaped text / stripped link).

---

## 9. Deferred drills → acceptance criteria (scope E)

Both drills run in **T35** against the operator's live install, under DECISIONS 2026-11-04 (**dedicated sessions only — never the operator's active session**).

**Safety rails (both drills):** create the drill session via the API (`POST /api/session {"location":{"directory":"/home/mg-12623-8/Documents"}}`); before any prompt, `GET /api/session/active` + the session list and record the operator's active sessionID; every prompt targets **only** the drill sessionID; if a prompt ever lands in a wrong inbox, `DELETE /api/session/{id}/inbox/{inboxID}` immediately (verified removal path).

### Offline-recovery drill (deferred since Phase 1 T10 / Phase 3 T28)

Quiet window agreed with the operator. Read `pid` from `service.json` → `kill <pid>` (**exact pid only — never a name pattern**). Observe: SSE state → error within ~5 s → badge reconnecting → offline + DegradedBanner, composer disabled, AiCore dims; telemetry llm panel degrades independently (`unreachable` only if glm-server shares the outage — it doesn't; verify independence). Restart the service with the operator's documented start command. Observe: pump/EventSource reconnect → `server.connected` → `resync()` refetches sessions/messages/permissions/extensions; **password rotation self-heals** (new service.json mtime → re-read). Accept: zero stale UI, zero console errors, no fabricated data during the gap.

### Permission fire-drill (deferred since Phase 3 T21)

In the drill session, prompt the agent to run a harmless command that requires approval (e.g. "create the file `/tmp/opencode/drill-marker-<ts>` using the shell tool"). Observe: `permission.asked` → badge increments → drawer lists the request (action, resources, source); **Approve once** executes and removes; second run → **Reject** denies cleanly; "Always allow" shows the double-confirm but is **not clicked** (no rule persisted). Verify the single-reply-call-site invariant holds under the drill (reviewer grep). Cleanup: `DELETE` the drill session via the API afterwards (our own drill artifact — the no-session-deletion-UI exclusion covers UI, not API cleanup).

---

## 10. Ordered task list (T29–T36; sequential — glm-server is single-slot)

Each TS task gates on `tsc -b` green + `oxlint` clean + app runnable; each Rust task gates per §11 (toolchain path). Acceptance = demonstrable, not asserted.

- **T29 — Shell identity + icons + scripts.** tauri.conf.json diff (§4), `scripts/gen-icons.mjs` + regenerate the four PNGs, `"tauri"` npm script, confirm capabilities unchanged. *Accept:* `npm run tauri dev` (if webkit deps are in; else `cargo check`-ready + conf verified by schema) opens "OpenCode Nexus" at 1440×900 with min 820×600 and the generated icon in titlebar/taskbar; plain `npm run dev` in a browser is regression-free.
- **T30 — Rust auth + api_fetch + TS transport seam** (dev path untouched). `service.rs`, `api.rs`, lib.rs manage/invoke wiring, `src/lib/transport/{types,http,tauri,index}.ts`, `client.ts` requestRaw/readFsFile swap. *Accept:* in tauri dev, full chat flow works via invoke (dedicated session: list, prompt, stream, interrupt, slash command, history search); in a plain dev browser nothing changed (Network tab still shows `/api` via the proxy); **password absent from the webview** (grep built JS, window globals, Network headers — reviewer item); `api_fetch` rejects non-`/api` paths (Rust unit test or manual invoke).
- **T31 — Rust SSE pump.** `sse_pump.rs` + `tauri.ts` connectEvents + useEventStream import swap. *Accept:* live streaming in tauri dev (deltas by ordinal, busy flips, usage ticks, tool cards); kill the service → state error → banner; restart → auto-reconnect → resync; `event_stream_stop` ends the Rust task (verified via logs/process); heartbeats produce no phantom events.
- **T32 — Rust telemetry.** `telemetry/{mod,system,gpu,llm,ring}.rs` + `telemetry_snapshot` + store swap. *Accept:* snapshot JSON **deep shape-identical** to the dev middleware's (programmatic key-structure diff); numbers within tolerance of `top`/`free -b`/`nvidia-smi`/`curl /health`; degrade matrix verified: rename nvidia-smi on PATH → `source:"unavailable"` no-retry; `NEXUS_LLM_URL=http://127.0.0.1:9` → `unreachable` with retained props + climbing `propsStaleMs`, one-probe recovery on restore; invoke round-trip time recorded (§10.3); zero OpenCode requests from Rust telemetry.
- **T33 — Desktop conveniences.** window-state, single-instance, tray, close-to-tray (§7). *Accept:* resize/quit → relaunch restores geometry; launching a second instance focuses the first; tray Show/Hide/Quit work; window X hides to tray while telemetry + SSE continue; Quit exits for real (process gone).
- **T34 — Chat markdown.** §8. *Accept:* assistant text renders headings/lists/code/links; XSS test strings render inert; live-streaming with an unclosed fence renders sanely; reasoning/user/tool unchanged; no console errors.
- **T35 — Drills (§9).** Offline recovery + permission fire-drill + cleanup, exactly per the checklists. *Accept:* both fully green; any behavior deviation recorded in `docs/API-NOTES.md`.
- **T36 — Final quality pass + gates.** (a) motion polish (150/300 ms discipline, reduced-motion everywhere); (b) a11y + web-design-guidelines audit (focus order, drawer/tabs aria, contrast); (c) ui-designer visual pass; (d) **reviewer gate** — security focus: password confinement in the packaged build, CSP violations, permission single-call-site, fs whitelist intact, minimal IPC surface (4 commands, no fs/network primitives exposed), no unwrap on external data in Rust; (e) Playwright visual pass on the **built** output (`npm run build && npx vite preview`: full 6-tab tour, 0 console errors) + the manual packaged-app checklist (§11); (f) update PLAN.md Phase 4 checkboxes + README (identity, NEXUS_LLM_URL, build/run instructions).
---

## 11. Build / verify strategy (scope H groundwork)

1. **Toolchain check (T29 step 0):** run `cargo --version` / `rustc --version`. This spec could not verify it (read-only session). If present → every Rust task gates on `cargo check` (fast, no link) and `npm run tauri dev` once the webkit libs land. If absent → Rust tasks gate on "compile-pending" review (rust-analyzer-clean, explicit types, no `unwrap()` on external data, all commands return `Result`) and the deferred `cargo check`s run in order T29→T33 the moment the system deps land.
2. **System deps (user is installing):** `libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev build-essential libssl-dev libxdo-dev pkg-config libgtk-3-dev` (standard Tauri Ubuntu list; appindicator is needed for tray).
3. **Final build:** `npm run tauri build` → deb + AppImage under `src-tauri/target/release/bundle/`. Accept: `dpkg -i` installs and the app launches; AppImage runs. Install the deb **once before T36 sign-off** to confirm the identifier `com.xirro9.jerry` is final (§10.9).
4. **Visual-pass honesty:** Playwright drives Chromium against the built web assets (`vite preview`), **not** the webkit webview. Desktop-only behaviors (tray, window state, single instance, IPC under CSP) are verified by a manual packaged-app checklist in T36 (geometry restore, second-instance focus, tray menu, close-to-tray, CSP console clean, icon). Checklist results recorded in PLAN.md — no pretending the Playwright run covered the shell.

---

## 12. Risks

1. **Rust compile times in the single-slot workflow** — first `cargo check` of tauri+reqwest ≈ 2–5 min, full build longer. Sequential tasks amortize (shared target dir; `check`, not `build`, per iteration). Never interleave a long cargo build with subagent streaming on the same attention slot.
2. **webkit2gtk-4.1 quirks** — distro webkit varies in CSP enforcement and localStorage persistence (`nexus.mainView`, rail collapse). If CSP breaks something unfixable this phase: fall back to `csp: null` with a reviewer-noted exception, never silently.
3. **IPC snapshot size** — full snapshot ≈ 100–150 KB JSON every 2 s (300 × 3-GPU samples dominate). The dev proxy moved the same bytes over HTTP, so loopback IPC is fine; the `TailSpec` arg (§3) is the pre-built throttle lever (e.g. rail-only `{system:30, gpu:30, llm:30}`) if T32's round-trip measurement says otherwise. Measure first, optimize never-by-default.
4. **SSE pump parity** — the Rust reconnect loop must preserve EventSource semantics (auto-retry, open/error transitions, no manual close/retry in JS) or the resync/syncGeneration logic breaks. T31's offline drill is the gate.
5. **reqwest without TLS** — both upstreams are plain HTTP today; if either moves to https, add the rustls feature (+ size/compile cost). Documented limitation, not a blocker.
6. **Close-to-tray surprise** — first-time users may think the app exited. Mitigation: tray icon + tooltip + Quit item; revisit if it annoys the operator.
7. **Streaming markdown edge cases** — the fence-fixup covers the common case; pathological nesting (fences inside lists) may still reflow once on close. Accepted; not worth a streaming parser.
8. **Icon placeholders** — `.icns`/`.ico` remain Tauri defaults (unused on Linux); flagged so nobody mistakes them for final art.
9. **Identifier irreversibility** — deb/AppImage identity is permanent for the upgrade path; confirm `com.xirro9.jerry` with the operator before the first packaged build, or pick another reverse-DNS now.
10. **npm run tauri dev ≠ npm run dev** — after T30, `tauri dev` exercises the invoke path while the browser dev exercises the proxy path. Both must stay green; T30/T32 acceptance covers both explicitly to prevent silent divergence.

---

## 13. Exclusions (restated)

- **Worktree mutations stay EXCLUDED** (coordinator decision, SPEC-PHASE3 §7): no create/delete UI or commands — read-only list + refresh only. Not revisited this phase.
- **No autostart/spawn/stop of the OpenCode service or glm-server from Nexus** — check-at-launch + degraded banner only.
- No permission rule management, no session deletion/archive UI, no MCP/plugin mutations (Phase 3 exclusions carry forward).
- No auto-updater (`tauri-plugin-updater` out of scope), no deep links, no global shortcuts, no multi-window, no mobile targets.
- No telemetry persistence to disk — ring buffers stay in-memory (Phase 2 §9.1 stance unchanged).

---

## Appendix — provenance

- Written 2026-11-04 by the architect subagent (read-only session; file delivered via the Code Mode → Playwright Blob-download path — shell/write denied for specialist agents).
- Ground truth sources: repo code read directly (vite.config.ts, src/server/telemetry.ts, src/lib/opencode/{client,sse}.ts, src/store/telemetry.ts, src/lib/markdown.ts, src-tauri/**, package.json) + SPEC-PHASE1/2/3.md + PLAN.md. Installed Tauri versions from Cargo.toml/package.json (tauri 2.12.5, @tauri-apps/{api,cli} ^2.12.4). cargo availability unverified (§11.1).
- Open items for the operator: (a) confirm `com.xirro9.jerry` identifier; (b) confirm close-to-tray behavior is wanted; (c) quiet window for the T35 offline drill.
