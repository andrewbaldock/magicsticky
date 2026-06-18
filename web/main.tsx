import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsProvider } from "./useSettings.tsx";
import { App } from "./App.tsx";
import "./styles.css";

// Server reads (the sticky list + the active sticky) go through TanStack Query so they poll for
// changes other clients make. Writes stay on the bespoke save/offline-retry path (see Workspace).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true, // catch "edited on my phone, back to laptop"
      staleTime: 5_000,
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// Register the service worker (the PWA's offline shell). Skip in dev — a SW fights Vite HMR; only
// the built app served by Hono should cache. import.meta.env.PROD is true only in `vite build`.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* SW registration is best-effort; the app works online without it */
    });
  });
}
