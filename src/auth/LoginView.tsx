import { useEffect, useRef, useState } from "react";
import { shell } from "uxp";
import { saveToken, type AuthToken } from "./tokenStore";
import { deviceStart, devicePoll, type DeviceStartResponse } from "./bffClient";
import { BrandMark } from "../brand/Logo";
import { PRIVACY_URL, TERMS_URL } from "../config";

interface Props {
  onSignedIn: (token: AuthToken) => void;
  notice?: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; device: DeviceStartResponse }
  | { kind: "error"; message: string };

export function LoginView({ onSignedIn, notice }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function onSignIn() {
    setPhase({ kind: "starting" });
    try {
      const device = await deviceStart();
      setPhase({ kind: "waiting", device });
      openBrowser(device.verificationUriComplete);
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const device = phase.device;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      let result;
      try {
        result = await devicePoll(device.deviceCode);
      } catch {
        result = { status: "pending" as const };
      }
      if (stopped) return;
      console.log("[auth] poll status:", result.status);
      if (result.status === "authorized") {
        const token: AuthToken = { accessToken: result.accessToken, expiresAt: result.expiresAt };
        // Persisting must never block sign-in: if secure storage is unavailable the user is
        // still signed in for this session (they'd just have to sign in again next launch).
        try {
          await saveToken(token);
        } catch (e) {
          console.warn("[auth] saveToken failed (continuing in-memory):", e);
        }
        console.log("[auth] authorized → onSignedIn");
        onSignedIn(token);
        return;
      }
      if (result.status === "expired") {
        setPhase({ kind: "error", message: "Code expired. Please sign in again." });
        return;
      }
      if (result.status === "error") {
        setPhase({ kind: "error", message: "Sign-in failed. Please try again." });
        return;
      }
      timerRef.current = setTimeout(tick, device.interval * 1000);
    };

    timerRef.current = setTimeout(tick, device.interval * 1000);
    return () => {
      stopped = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, onSignedIn]);

  return (
    <div className="panel login-panel">
      <div className="login-brand">
        <BrandMark size={56} />
        <h2 className="login-title">vibi</h2>
        <p className="login-tagline">AI audio stem separation</p>
      </div>
      {notice && <p className="panel-error">{notice}</p>}
      <div className="login-spacer" />
      <sp-help-text size="s">
        Sign in to continue. New accounts get free credits to try the plugin.
      </sp-help-text>

      {phase.kind === "waiting" && (
        <div className="field">
          <sp-help-text size="m">
            We opened your browser to finish signing in. This panel updates automatically once
            you're done.
          </sp-help-text>
          <sp-help-text size="s">
            Didn't open, or the code wasn't filled in? Use code{" "}
            <span className="user-code-inline">{phase.device.userCode}</span> on the sign-in page.
          </sp-help-text>
        </div>
      )}

      {(phase.kind === "idle" || phase.kind === "error") && (
        <sp-button variant="accent" onClick={onSignIn}>
          Sign in
        </sp-button>
      )}

      {phase.kind === "starting" && (
        <sp-button variant="accent" disabled pending>
          Sign in
        </sp-button>
      )}

      {phase.kind === "waiting" && (
        <>
          <sp-button
            variant="secondary"
            onClick={() => openBrowser(phase.device.verificationUriComplete)}
          >
            Reopen browser
          </sp-button>
          <sp-progress-bar label="Waiting for authorization…" indeterminate size="s" />
          <sp-button
            variant="secondary"
            treatment="outline"
            size="s"
            onClick={() => setPhase({ kind: "idle" })}
          >
            Cancel
          </sp-button>
        </>
      )}

      {phase.kind === "error" && <sp-help-text variant="negative">{phase.message}</sp-help-text>}

      <div className="login-legal">
        <a onClick={() => openBrowser(PRIVACY_URL)}>Privacy Policy</a>
        <span aria-hidden="true">·</span>
        <a onClick={() => openBrowser(TERMS_URL)}>Terms of Service</a>
      </div>
    </div>
  );
}

function openBrowser(url: string) {
  try {
    void shell.openExternal(url);
  } catch (e) {
    console.warn("[auth] openExternal failed:", e);
  }
}
