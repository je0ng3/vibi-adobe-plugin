import "./spectrum-imports";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";

try {
  const container = document.getElementById("root")!;
  createRoot(container).render(<App />);
} catch (e) {
  // Surface the real bootstrap error onto the panel (the polyfill banner otherwise only
  // sees a generic "error" with no message).
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  console.error("[boot] render failed:", e);
  const el = document.createElement("pre");
  el.textContent = "BOOT ERROR: " + msg;
  el.style.cssText = "color:#f88;background:#300;padding:8px;font:11px monospace;white-space:pre-wrap";
  document.body.appendChild(el);
}
