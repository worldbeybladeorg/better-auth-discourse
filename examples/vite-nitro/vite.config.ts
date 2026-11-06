import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [nitro()],
  server: {
    host: "localhost",
    port: 3000,
    strictPort: true,
  },
});
