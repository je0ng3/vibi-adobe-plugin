import { Hono } from "hono";
import { brandHeader, brandPageStyles } from "../brand.js";

export const devicePageRoute = new Hono();

devicePageRoute.get("/device", (c) => {
  const code = c.req.query("code") ?? "";
  return c.html(renderPage(code));
});

function renderPage(code: string): string {
  const startUrl = `/api/v2/auth/google/start?code=${encodeURIComponent(code)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in to vibi</title>
<style>
  ${brandPageStyles()}
  p.sub { margin: 0 0 20px; font-size: 13px; color: #a0a0a0; }
  .gbtn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;
    box-sizing: border-box; background: #fff; color: #1f1f1f; text-decoration: none;
    border-radius: 6px; padding: 11px; font-size: 14px; font-weight: 600; }
  .gbtn svg { width: 18px; height: 18px; }
  .code { margin-top: 18px; font-size: 12px; color: #808080; text-align: center; }
  .code b { color: #b0b0b0; font-family: ui-monospace, monospace; letter-spacing: 0.12em; }
  .err { margin-top: 16px; font-size: 13px; color: #ff7066; text-align: center; }
</style>
</head>
<body>
  <div class="card">
    ${brandHeader()}
    <p class="sub">Sign in to continue in the plugin. New accounts get free credits.</p>
    ${code
      ? `<a class="gbtn" href="${startUrl}">
           <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.6 2.4 30.1 0 24 0 14.6 0 6.4 5.4 2.6 13.2l7.9 6.1C12.3 13.2 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.1-3.8 6.5-9.4 6.5-16z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.1 0 11.3-2 15-5.5l-7.1-5.5c-2 1.3-4.5 2.1-7.9 2.1-6.3 0-11.7-3.7-13.5-9.1l-7.9 6.1C6.4 42.6 14.6 48 24 48z"/></svg>
           Continue with Google
         </a>
         <p class="code">Verifying device code <b>${escapeHtml(code)}</b></p>`
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
