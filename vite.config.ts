import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web app lives in web/; in dev, Vite proxies /api and /auth to the Bun server (port 3001) so
// the browser hits one origin. In prod, Hono serves the built files from web/dist.
// Ports: Vite UI on 5180, Bun API on 3001 — both avoid the existing map (5173 website, 5174 aether,
// 5176 Orion web, 3000 Orion API, 8000 aether backend).
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/api": "http://localhost:3001",
      "/auth": "http://localhost:3001",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
