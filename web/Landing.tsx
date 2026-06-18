import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { useGoogleSignIn } from "./useGoogleSignIn.ts";

const DRAFT_KEY = "magicsticky.draft";

// Signed-out landing: a live sticky you can type into (no auth). The text is a CLIENT-SIDE draft in
// localStorage — nothing hits the server until you sign in, at which point it's POSTed as sticky 1.
export function Landing({ onSignedIn }: { onSignedIn: () => void }) {
  const [draft, setDraft] = useState(() => localStorage.getItem(DRAFT_KEY) ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, draft);
  }, [draft]);

  const { ref, configured } = useGoogleSignIn(async (credential) => {
    setError(null);
    try {
      await api.signIn(credential, draft || undefined);
      localStorage.removeItem(DRAFT_KEY); // carried over to the server now
      onSignedIn();
    } catch {
      setError("Sign-in failed. This account may not be on the allowlist yet.");
    }
  });

  return (
    <div className="landing">
      <h1>Magic Sticky 🌼</h1>
      <p>Jot something down. Sign in to save it — and then it's in any browser.</p>
      <p>Can be used as a shared prompt for AI agent collaboration</p>
      {/* No autoFocus: on iOS it would slam the keyboard up over the sign-in CTA below. */}
      <textarea
        className="editor"
        placeholder="Type anything…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="cta">
        {configured ? (
          <div ref={ref} />
        ) : (
          <p className="muted">Sign-in isn’t configured (set VITE_GOOGLE_CLIENT_ID).</p>
        )}
        {error && <p className="muted" style={{ color: "var(--danger)" }}>{error}</p>}
        <p className="muted">Your note saves to your account; one becomes the shared Claude prompt.</p>
      </div>
    </div>
  );
}
