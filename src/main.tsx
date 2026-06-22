import "./spectrum-imports";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { diag } from "./diag";
import { BFF_BASE_URL } from "./config";

const diagOn = (globalThis as { __VIBI_DIAG__?: boolean }).__VIBI_DIAG__ === true;

try {
  // Startup marker — if this line doesn't appear on the panel, you're running a STALE cached
  // bundle (UXP caches hard; a UDT reload often isn't enough — fully restart Premiere), not this
  // diag build. It also confirms which backend the build is pointed at.
  diag(`boot ok · BFF=${BFF_BASE_URL}`);
  const container = document.getElementById("root")!;
  createRoot(container).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
} catch (e) {
  // Bootstrap failed before React mounted. Show a plain recoverable message to users; the raw
  // stack is exposed only in diag/UDT builds (__VIBI_DIAG__) — a shipped build must never paint a
  // developer stack trace onto the panel (Adobe Marketplace rejects debug surfaces).
  console.error("[boot] render failed:", e);
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  const el = document.createElement("pre");
  el.textContent = diagOn
    ? "BOOT ERROR: " + msg
    : "Vibi Separate couldn't start. Please close and reopen the panel.";
  el.style.cssText = diagOn
    ? "color:#f88;background:#300;padding:8px;font:11px monospace;white-space:pre-wrap"
    : "color:#ddd;padding:12px;font:13px sans-serif;white-space:pre-wrap";
  document.body.appendChild(el);
}
