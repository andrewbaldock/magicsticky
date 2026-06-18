# Multi-stage: build the React app, then a lean runtime that serves it + the API/MCP from one Bun
# process. SQLite lives on a mounted Fly volume (see fly.toml [mounts]).
FROM oven/bun:1 AS base
WORKDIR /app

# --- deps (all, incl. dev — Vite/React needed to build the web app) ---
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# --- build the frontend → web/dist ---
FROM deps AS webbuild
COPY vite.config.ts ./
COPY web ./web
# VITE_GOOGLE_CLIENT_ID is public (ships in the browser); pass it at build time so the GIS button
# is wired in the bundle. Provided via --build-arg at deploy.
ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
RUN bun run build:web

# --- runtime: prod deps only + server source + built web ---
FROM base AS runtime
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY --from=webbuild /app/web/dist ./web/dist

ENV PORT=8080
# Serve the built UI from this origin (Hono static + SPA fallback).
ENV MAGICSTICKY_WEB_DIST=/app/web/dist
# SQLite path on the mounted volume.
ENV MAGICSTICKY_DB=/data/magicsticky.db
ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "src/server-http.ts"]
