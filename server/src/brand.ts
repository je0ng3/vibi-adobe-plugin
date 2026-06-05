// Shared vibi brand mark for the browser-facing pages (device sign-in, checkout return,
// auth result). Mirrors the in-app SVG (src/brand/Logo.tsx) so the web flow feels like
// part of the same product.

export function brandMarkSvg(size = 44): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs><linearGradient id="vibiGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
    <stop stop-color="#2680eb"/><stop offset="1" stop-color="#7b5bff"/></linearGradient></defs>
  <rect width="48" height="48" rx="11" fill="url(#vibiGrad)"/>
  <g fill="#ffffff">
    <rect x="9.9" y="17" width="3.4" height="14" rx="1.7" opacity="0.92"/>
    <rect x="16.1" y="11" width="3.4" height="26" rx="1.7"/>
    <rect x="22.3" y="20" width="3.4" height="8" rx="1.7" opacity="0.88"/>
    <rect x="28.5" y="14" width="3.4" height="20" rx="1.7" opacity="0.96"/>
    <rect x="34.7" y="19" width="3.4" height="10" rx="1.7" opacity="0.84"/>
  </g></svg>`;
}

// Shared dark styles + a centered card, so every page matches.
export function brandPageStyles(): string {
  return `:root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#1f1f1f;color:#f4f4f4;font-family:-apple-system,"Segoe UI",Roboto,sans-serif}
  .card{width:320px;background:#2c2c2c;border:1px solid #3a3a3a;border-radius:12px;padding:28px;text-align:center}
  .brand{display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:18px}
  .brand h1{font-size:20px;font-weight:700;letter-spacing:-0.01em;margin:0}
  .brand .tag{font-size:12px;color:#a0a0a0;margin:0}`;
}

export function brandHeader(tagline = "AI audio stem separation"): string {
  return `<div class="brand">${brandMarkSvg(48)}<h1>vibi</h1><p class="tag">${tagline}</p></div>`;
}
