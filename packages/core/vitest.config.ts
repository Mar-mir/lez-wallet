// Dual-licensed: MIT OR Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});