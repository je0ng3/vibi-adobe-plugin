import { useEffect, useState } from "react";
import { SeparationPanel } from "./panels/SeparationPanel";
import { LoginView } from "./auth/LoginView";
import { clearToken, isExpired, loadToken, type AuthToken } from "./auth/tokenStore";
import { setUnauthorizedHandler } from "./auth/session";

type AppState =
  | { kind: "loading" }
  | { kind: "signed-out"; notice?: string }
  | { kind: "signed-in"; token: AuthToken };

const EXPIRED_NOTICE = "Your session expired. Please sign in again.";

export function App() {
  const [state, setState] = useState<AppState>({ kind: "loading" });

  useEffect(() => {
    loadToken()
      .then((token) => {
        if (token && !isExpired(token)) {
          setState({ kind: "signed-in", token });
        } else {
          setState({ kind: "signed-out" });
        }
      })
      .catch((e) => {
        // Never strand the panel on "Loading…": if secure storage is unavailable, treat the
        // user as signed-out so the login screen still renders.
        console.error("[auth] loadToken failed:", e);
        setState({ kind: "signed-out" });
      });
  }, []);

  // Any authed API call that gets a 401 routes back to login with a notice, instead of surfacing
  // a cryptic "failed: 401" error deep in a feature. (Token refresh would need BFF support.)
  useEffect(() => {
    setUnauthorizedHandler(() => {
      void clearToken();
      setState((prev) => (prev.kind === "signed-in" ? { kind: "signed-out", notice: EXPIRED_NOTICE } : prev));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  return (
    <sp-theme color="darkest" scale="medium">
      {state.kind === "loading" && (
        <div className="panel"><sp-help-text>Loading…</sp-help-text></div>
      )}
      {state.kind === "signed-out" && (
        <LoginView notice={state.notice} onSignedIn={(token) => setState({ kind: "signed-in", token })} />
      )}
      {state.kind === "signed-in" && (
        <SeparationPanel
          onSignOut={async () => {
            await clearToken();
            setState({ kind: "signed-out" });
          }}
        />
      )}
    </sp-theme>
  );
}
