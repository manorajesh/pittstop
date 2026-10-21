import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// Served from mano.raje.sh/pittstop/ (scripts/publish.sh copies dist/ there).
export default defineConfig({
  base: "/pittstop/",
  plugins: [preact()],
  build: { target: "es2022", assetsInlineLimit: 0 },
  worker: { format: "es" },
});
