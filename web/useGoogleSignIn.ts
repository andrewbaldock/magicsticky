// Renders the Google Identity Services (GIS) sign-in button into a ref and hands the resulting
// ID-token credential to a callback. The GIS script is loaded in index.html.

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void }) => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

export function useGoogleSignIn(onCredential: (credential: string) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onCredential);
  cb.current = onCredential;

  useEffect(() => {
    if (!CLIENT_ID || !ref.current) return;
    let cancelled = false;

    const render = () => {
      if (cancelled || !window.google || !ref.current) return;
      window.google.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: (r) => cb.current(r.credential),
      });
      window.google.accounts.id.renderButton(ref.current, {
        theme: "filled_black",
        size: "large",
        shape: "pill",
        text: "continue_with",
      });
    };

    // The GIS script loads async; poll briefly until window.google is ready. Single cleanup path
    // (always returned) so a late render()/callback can't fire after unmount, regardless of whether
    // google was ready immediately.
    let timer: ReturnType<typeof setInterval> | undefined;
    if (window.google) render();
    else {
      timer = setInterval(() => {
        if (window.google) {
          clearInterval(timer);
          render();
        }
      }, 100);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  return { ref, configured: !!CLIENT_ID };
}
