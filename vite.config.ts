import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { fileURLToPath, URL } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { telemetryPlugin } from "./src/server/telemetry"

const SERVICE_JSON = homedir() + "/.local/state/opencode/service.json"

interface ServiceCreds {
  url: string
  auth: string
}

// mtime cache: re-parse service.json only when it changed (password rotates on
// service restart — this lets the proxy self-heal without a dev-server restart).
let credsCache: { mtimeMs: number; result: ServiceCreds | null } | null = null
function readService(): ServiceCreds | null {
  try {
    const mtimeMs = statSync(SERVICE_JSON).mtimeMs
    if (credsCache && credsCache.mtimeMs === mtimeMs) return credsCache.result
    const svc = JSON.parse(readFileSync(SERVICE_JSON, "utf8")) as {
      url: string
      password: string
    }
    const result: ServiceCreds = {
      url: svc.url,
      auth:
        "Basic " + Buffer.from("opencode:" + svc.password).toString("base64"),
    }
    credsCache = { mtimeMs, result }
    return result
  } catch {
    return null
  }
}

const boot = readService() // target pinned at boot; password re-read per request below

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), telemetryPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": {
        target: boot?.url ?? "http://127.0.0.1:49374",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            const svc = readService() // re-read (mtime-cached) per request
            if (svc) proxyReq.setHeader("authorization", svc.auth)
          })
          proxy.on("proxyRes", (proxyRes) => {
            if (
              (proxyRes.headers["content-type"] ?? "").includes(
                "text/event-stream",
              )
            ) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform"
              proxyRes.headers["x-accel-buffering"] = "no"
            }
          })
        },
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110",
    sourcemap: false,
  },
})
