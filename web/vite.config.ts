import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// The frontend lives in /web and builds to /web/dist, which the Express
// backend serves as static files. Everything is bundled locally - there are
// no external CDN references, so the built app runs with networking disabled.
export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
  },
  server: {
    // Used only for `npm run web:dev`; proxies API calls to the backend.
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});
