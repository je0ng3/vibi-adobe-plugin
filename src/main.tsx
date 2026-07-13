import "./spectrum-imports";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { diag } from "./diag";
import { BFF_BASE_URL } from "./config";

// UXP exposes built-in Node-ish modules ("os", "uxp", …) via a runtime require(); it's not a
// resolvable ESM specifier, so declare it for the type checker (mirrors uxp-shim/uxp.ts).
declare const require: (id: string) => unknown;

const diagOn = (globalThis as { __VIBI_DIAG__?: boolean }).__VIBI_DIAG__ === true;

// Tag the root with the host OS so CSS can compensate per-platform. Windows UXP renders the
// same px font noticeably smaller than macOS (different text metrics / no SF Pro fallback), so
// the dense script editor needs a size bump there — see `.plat-win` rules in styles.css.
// Guarded: the `os` module only exists in the UXP runtime; in the browser dev stub require may
// be absent, in which case we just skip the class.
try {
  const platform = (require("os") as { platform(): string }).platform();
  if (platform === "win32") document.documentElement.classList.add("plat-win");
} catch {
  /* not in the UXP runtime (dev/serve) — no platform class, defaults apply */
}

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
    : "Vibi: AI Sound Eraser couldn't start. Please close and reopen the panel.";
  el.style.cssText = diagOn
    ? "color:#f88;background:#300;padding:8px;font:11px monospace;white-space:pre-wrap"
    : "color:#ddd;padding:12px;font:13px sans-serif;white-space:pre-wrap";
  document.body.appendChild(el);
}
