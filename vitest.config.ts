// Vitest config — deliberately separate from vite.config.ts so the dev-proxy
// plugins (telemetry/graphify, service.json auth) never load in tests.
// Unit tests are pure Node: no DOM, no Tauri, no network.

import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
