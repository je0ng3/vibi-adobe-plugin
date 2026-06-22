import { Hono } from "hono";
import { brandHeader, brandPageStyles } from "../brand.js";

export const devicePageRoute = new Hono();

devicePageRoute.get("/device", (c) => {
  const code = c.req.query("code") ?? "";
  return c.html(renderPage(code));
});

function renderPage(code: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in to vibi</title>
<style>
  ${brandPageStyles()}
  p.sub { margin: 0 0 18px; font-size: 13px; color: #a0a0a0; }
  .codebox { margin: 0 0 16px; padding: 12px; border: 1px solid #3a3a3a; border-radius: 8px;
    text-align: center; background: #1b1b1b; }
  .codebox .label { display: block; font-size: 11px; color: #909090; margin-bottom: 6px; }
  .codebox .val { font-size: 22px; font-weight: 700; color: #e8e8e8; font-family: ui-monospace, monospace;
    letter-spacing: 0.22em; }
  .warn { margin: 0 0 18px; padding: 10px 12px; border-radius: 8px; background: rgba(255,112,102,0.10);
    border: 1px solid rgba(255,112,102,0.35); font-size: 12px; line-height: 1.5; color: #ffb3ad; }
  .gbtn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;
    box-sizing: border-box; background: #fff; color: #1f1f1f; text-decoration: none;
    border: 0; cursor: pointer; border-radius: 6px; padding: 11px; font-size: 14px; font-weight: 600; }
  .gbtn.dim { opacity: 0.45; }
  .gbtn svg { width: 18px; height: 18px; }
  .confirm { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 14px; font-size: 12px;
    color: #b8b8b8; line-height: 1.45; }
  .confirm input { margin-top: 2px; }
  .err { margin-top: 16px; font-size: 13px; color: #ff7066; text-align: center; }
</style>
</head>
<body>
  <div class="card">
    ${brandHeader()}
    <p class="sub">Sign in to continue in the plugin. New accounts get free credits.</p>
    ${code
      ? `<form method="get" action="/api/v2/auth/google/start">
           <input type="hidden" name="code" value="${escapeHtml(code)}" />
           <div class="codebox"><span class="label">Device code</span><span class="val">${escapeHtml(code)}</span></div>
           <p class="warn">⚠️ Only continue if you <b>just started sign-in from the Vibi Separate panel</b> in
             Premiere Pro and this code matches the one shown there. If you didn't start this, close this page —
             someone may be trying to get you to sign in to their session.</p>
           <label class="confirm">
             <input type="checkbox" id="ack" name="ack" required />
             <span>I started this sign-in from the Vibi Separate panel and the code above matches.</span>
           </label>
           <button type="submit" class="gbtn dim" id="go">
             <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.6 2.4 30.1 0 24 0 14.6 0 6.4 5.4 2.6 13.2l7.9 6.1C12.3 13.2 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.1-3.8 6.5-9.4 6.5-16z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.1 0 11.3-2 15-5.5l-7.1-5.5c-2 1.3-4.5 2.1-7.9 2.1-6.3 0-11.7-3.7-13.5-9.1l-7.9 6.1C6.4 42.6 14.6 48 24 48z"/></svg>
             Continue with Google
           </button>
         </form>
         <script>
           // The 'required' checkbox is the real gate — the browser blocks form submission until
           // it's checked even with JS off, and the server re-checks ack=on (auth.ts), so a
           // pre-filled verificationUriComplete link can't one-click through without the user
           // consciously confirming they initiated this sign-in (RFC 8628 phishing mitigation).
           // This only adds the dimmed affordance while it's unchecked.
           (function () {
             var go = document.getElementById("go"), ack = document.getElementById("ack");
             function sync() { go.classList.toggle("dim", !ack.checked); }
             ack.addEventListener("change", sync); sync();
           })();
         </script>`
      : `<p class="err">No device code provided. Start sign-in from the plugin.</p>`}
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
