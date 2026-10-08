import base from "./vitest.server.config.mts";
import { defineConfig, mergeConfig } from "vitest/config";
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["tests/integration/**/*.test.ts"],
      pool: "threads",
      maxWorkers: 1,
    },
  }),
);
