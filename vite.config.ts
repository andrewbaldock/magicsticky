import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web app lives in web/; in dev, Vite proxies /api and /auth to the Bun server (port 3000) so
// the browser hits one origin. In prod, Hono serves the built files from web/dist (step 8).
// Port 5180 — avoids the existing dev-port map (5173 website, 5174 aether, 5176 Orion, 8000 aether
// backend, 3000 this server).
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
