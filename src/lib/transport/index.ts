// Transport selection (SPEC-PHASE4 §1). "__TAURI_INTERNALS__" in window is the
// only signal that answers "is THIS webview inside the Tauri shell" — the
// TAURI_ENV_* vars are set whenever the tauri CLI spawns vite, which would
// put the browser dev path on the wrong transport. Static imports at module
// scope are safe: @tauri-apps/api/core evaluates side-effect-free in a plain
// browser and invoke() is never called when !isTauri().

import { httpTransport } from "./http"
import { tauriTransport } from "./tauri"
import type { Transport, TransportRequestInit, TransportResponse } from "./types"

export type { Transport, TransportRequestInit, TransportResponse }

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export const transport: Transport = isTauri() ? tauriTransport : httpTransport
