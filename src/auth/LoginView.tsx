import { useEffect, useRef, useState, type ReactNode } from "react";
import { shell } from "uxp";
import { saveToken, type AuthToken } from "./tokenStore";
import { deviceStart, devicePoll, googleDeviceSignInUrl, type DeviceStartResponse } from "./bffClient";
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
      // Open Google consent straight away — skip the BFF's /device confirmation page.
      openBrowser(googleDeviceSignInUrl(device.userCode));
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const device = phase.device;
    let stopped = false;
    // Bound the wait: the device code expires server-side, so stop polling at that deadline
    // rather than spinning forever if the server never returns a terminal status.
    const deadline = Date.now() + device.expiresIn * 1000;

    const tick = async () => {
      if (stopped) return;
      if (Date.now() >= deadline) {
        setPhase({ kind: "error", message: "This sign-in expired. Please try again." });
        return;
      }
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
        <BrandMark size={64} />
        <h2 className="login-title">vibi</h2>
        <p className="login-tagline">
          Separate any clip into clean vocals, music &amp; background — right inside Premiere.
        </p>
      </div>

      {/* Action + legal live at the bottom of the panel (margin-top:auto on .login-bottom). */}
      <div className="login-bottom">
        {/* A re-auth notice ("session expired") is benign — show it neutral and next to the
            CTA, not as an alarm-red error stranded up by the logo. */}
        {notice && <p className="login-notice">{notice}</p>}

        {phase.kind === "waiting" ? (
          <div className="login-action" role="status" aria-live="polite">
            <sp-help-text size="m">
              Finish signing in in your browser. This panel updates automatically once you're
              done.
            </sp-help-text>
            <sp-progress-bar label="Waiting for sign-in…" indeterminate size="s" />
            <LoginButton
              variant="secondary"
              onClick={() => openBrowser(googleDeviceSignInUrl(phase.device.userCode))}
            >
              Reopen browser
            </LoginButton>
            <LoginButton variant="ghost" onClick={() => setPhase({ kind: "idle" })}>
              Cancel
            </LoginButton>
          </div>
        ) : (
          <div className="login-action">
            <p className="login-perk">New accounts start with free credits — no card needed.</p>
            {phase.kind === "starting" ? (
              <LoginButton variant="primary" disabled busy>
                Signing in…
              </LoginButton>
            ) : (
              <LoginButton variant="primary" onClick={onSignIn}>
                Sign in with Google
              </LoginButton>
            )}
            <sp-help-text size="s">Opens your browser to sign in with Google.</sp-help-text>
            {phase.kind === "error" && (
              <p className="login-error" role="alert">
                {phase.message}
              </p>
            )}
          </div>
        )}

        <p className="login-legal">
          By continuing you agree to our{" "}
          <LegalLink url={PRIVACY_URL}>Privacy Policy</LegalLink> and{" "}
          <LegalLink url={TERMS_URL}>Terms of Service</LegalLink>.
        </p>
      </div>
    </div>
  );
}

function openBrowser(url: string) {
  try {
    // openExternal returns a Promise; an async rejection (no default browser, sandbox denied)
    // would otherwise escape this try/catch and go unhandled.
    const opening = shell.openExternal(url) as Promise<unknown> | undefined;
    if (opening && typeof opening.catch === "function") {
      opening.catch((e: unknown) => console.warn("[auth] openExternal failed:", e));
    }
  } catch (e) {
    console.warn("[auth] openExternal failed:", e);
  }
}

// Legal links are real, keyboard-operable controls: a bare <a onClick> with no href isn't
// tabbable or announced as a link in UXP/Chromium, so add role/tabIndex/onKeyDown (and keep
// openExternal, since UXP won't navigate an href anyway).
function LegalLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <a
      role="link"
      tabIndex={0}
      onClick={() => openBrowser(url)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openBrowser(url);
        }
      }}
    >
      {children}
    </a>
  );
}

// Login buttons are <div role="button">, not <sp-button>: UXP renders sp-button as an
// unlabeled grey pill. role/tabIndex/onKeyDown keep it keyboard-operable like a real button.
function LoginButton({
  variant,
  onClick,
  disabled,
  busy,
  children,
}: {
  variant: "primary" | "secondary" | "ghost";
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  const className = `login-btn login-btn--${variant}${disabled ? " login-btn--disabled" : ""}`;
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
      className={className}
      onClick={disabled ? undefined : onClick}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      {children}
    </div>
  );
}
