import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
    "storage/sqlite": "src/storage/sqlite.ts",
  },
  format: "esm",
  platform: "node",
  target: "es2022",
  fixedExtension: false,
  clean: true,
  sourcemap: true,
  dts: { sourcemap: true },
});
