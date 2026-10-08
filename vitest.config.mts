import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // Bounded workers avoid Windows fork-startup timeouts on this workspace.
    pool: "threads",
    maxWorkers: 1,
    environment: "jsdom",
    include: ["tests/frontend/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/frontend/setup.ts"],
  },
});
