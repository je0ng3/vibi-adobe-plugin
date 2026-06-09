// On-panel step tracer. In UXP the devtools console isn't always reachable, and try/catch'd
// errors never reach the uxp-polyfills error overlay — so a silent failure (e.g. separation
// "completes" but nothing renders) leaves no trace at all. diag() both console.logs AND paints
// an accumulating line into a fixed overlay box on the panel, so the flow is visible without any
// devtools. Gated on __VIBI_DIAG__ (set only in dev/UDT/diag builds — see vite.config.ts); in a
// normal prod build the painting is inert. Build with:
//   VIBI_DIAG=true VIBI_BFF_BASE_URL=https://plugin-api.vibi.fm npm run build
declare const __VIBI_DIAG__: boolean | undefined;

function diagOn(): boolean {
  return (globalThis as { __VIBI_DIAG__?: boolean }).__VIBI_DIAG__ === true;
}

let box: HTMLElement | null = null;
function ensureBox(): HTMLElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  if (box && box.isConnected) return box;
  box = document.createElement("pre");
  box.id = "__vibi_diag__";
  box.style.cssText =
    "position:fixed;top:0;left:0;right:0;max-height:45%;overflow:auto;z-index:99998;" +
    "margin:0;background:rgba(0,20,40,0.92);color:#9ef;padding:4px 8px;" +
    "font:10px/1.35 monospace;white-space:pre-wrap;border-bottom:1px solid #08f";
  document.body.appendChild(box);
  return box;
}

export function diag(msg: string): void {
  try {
    console.log("[diag]", msg);
  } catch {
    /* console dropped */
  }
  if (!diagOn()) return;
  const el = ensureBox();
  if (!el) {
    // body not ready yet — retry shortly so early markers aren't lost
    setTimeout(() => diag(msg), 20);
    return;
  }
  const line = document.createElement("div");
  line.textContent = "▸ " + msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
