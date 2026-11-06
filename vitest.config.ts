import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*-types.test.ts"],
    testTimeout: 15_000,
  },
});
