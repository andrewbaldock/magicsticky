import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.ts";
import { Landing } from "./Landing.tsx";
import { Workspace } from "./Workspace.tsx";

type Auth = { state: "loading" } | { state: "out" } | { state: "in" } | { state: "error" };

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: "loading" });

  const probe = useCallback(() => {
    setAuth({ state: "loading" });
    api
      .listStickies()
      .then(() => setAuth({ state: "in" }))
      .catch((e) => {
        // 401 = signed out (expected); anything else = a real error we should surface, not silently
        // present the landing as if logged out.
        setAuth({ state: e instanceof ApiError && e.status === 401 ? "out" : "error" });
      });
  }, []);

  useEffect(probe, [probe]);

  // Lifted so the Workspace can drop us back to signed-out when a request 401s mid-session.
  const onSignedOut = useCallback(() => setAuth({ state: "out" }), []);

  if (auth.state === "loading") return null; // brief; avoids a flash of the landing
  if (auth.state === "error")
    return (
      <div className="landing">
        <h1>Magic Sticky 🌼</h1>
        <p>Couldn’t reach the server. Check your connection and retry.</p>
        <div className="cta">
          <button className="btn" onClick={probe}>
            Retry
          </button>
        </div>
      </div>
    );
  if (auth.state === "out") return <Landing onSignedIn={() => setAuth({ state: "in" })} />;
  return <Workspace onSignedOut={onSignedOut} />;
}
