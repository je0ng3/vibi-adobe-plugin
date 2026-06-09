import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { cpSync, readFileSync, writeFileSync } from "fs";

// Copy manifest.json + icons into dist after each build so dist/ is itself a loadable UXP
// plugin folder. Without this, dist/ has no manifest and UDT must load build/stage (only
// refreshed by `npm run package`) — a stale stage there silently runs an old bundle.
// With this, point UDT at dist/ and `npm run watch` keeps the loaded plugin current.
//
// The source manifest.json is the **dev** variant: it whitelists the local BFF
// (`http://localhost:8787`) and the `http` launchProcess scheme so device-code sign-in can
// open the local verification URL. A **production** build (`VIBI_BFF_BASE_URL` set) strips
// both — the shipped .ccx then only reaches the production backend over https, which is what
// Adobe Marketplace expects. Edit the dev allowances in manifest.json; prod stays clean
// automatically.
function copyPluginFiles(isProd: boolean) {
  return {
    name: "copy-plugin-files",
    closeBundle() {
      const root = __dirname;
      const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
      if (isProd) {
        const perms = manifest.requiredPermissions ?? {};
        const net = perms.network;
        if (net && Array.isArray(net.domains)) {
          // Keep only https, non-localhost domains.
          net.domains = net.domains.filter(
            (d: string) => /^https:\/\//.test(d) && !d.includes("localhost"),
          );
        }
        const lp = perms.launchProcess;
        if (lp && Array.isArray(lp.schemes)) {
          lp.schemes = lp.schemes.filter((s: string) => s !== "http");
        }
      }
      writeFileSync(resolve(root, "dist/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      cpSync(resolve(root, "icons"), resolve(root, "dist/icons"), { recursive: true });
    },
  };
}

// Rewrites the built index.html for the UXP runtime:
//  - strips the `crossorigin` attribute (UXP's loader silently fails on it → blank panel),
//  - drops `type="module"` (UXP does not execute ES module scripts; the bundle is a classic IIFE),
//  - injects public/uxp-polyfills.js BEFORE the bundle (classic scripts run in document order),
//    which shims the browser DOM APIs UXP lacks (CSS, CSSStyleSheet, createTreeWalker) and
//    paints uncaught errors onto the panel. See public/uxp-polyfills.js.
function uxpHtml({ diag }: { diag: boolean }) {
  return {
    name: "uxp-html",
    // Build-only: these rewrites target the UXP runtime. In `vite` dev (browser preview) they
    // would strip type="module" and break ESM loading, so they must not run during serve.
    apply: "build" as const,
    transformIndexHtml(html: string) {
      html = html.replace(/\s+crossorigin(="[^"]*")?/g, "");
      html = html.replace(/<script\s+type="module"\s+/g, "<script ");
      // Enable the on-panel error overlay (uxp-polyfills.js) for dev/UDT builds only. The prod
      // build (VIBI_BFF_BASE_URL set) omits this flag so the diagnostics block stays inert —
      // Adobe Marketplace rejects production builds shipping debug overlays.
      const diagFlag = diag ? '<script>globalThis.__VIBI_DIAG__=true;</script>\n' : "";
      return html.replace(
        /<script\s+src="\.\/index\.js">/,
        diagFlag + '<script src="./uxp-polyfills.js"></script>\n$&',
      );
    },
  };
}

export default defineConfig(({ command }) => {
  const isServe = command === "serve";
  // Production = backend URL injected. Used to gate the dev-only on-panel error overlay.
  const isProd = (process.env.VIBI_BFF_BASE_URL ?? "").length > 0;
  // On-panel diagnostics (debug log box + error overlay) are opt-in: only built when VIBI_DIAG=true.
  // Plain dev/UDT builds no longer show the log box. Turn it on to chase a runtime error:
  //   VIBI_DIAG=true npm run build  (add VIBI_BFF_BASE_URL=… to debug against the real server)
  // Never ship a VIBI_DIAG build to Marketplace (overlay + console are present).
  const diag = process.env.VIBI_DIAG === "true";
  return {
    // UXP loads assets relative to the plugin root, not from a web server root.
    base: "./",
    // Inject the backend URL at build time: VIBI_BFF_BASE_URL=https://api.example.com npm run build
    // Falls back to localhost (see src/config.ts) when unset, so dev is unchanged.
    define: {
      __VIBI_BFF_BASE_URL__: JSON.stringify(process.env.VIBI_BFF_BASE_URL ?? ""),
      // Payment/top-up UI is gated off for the credits-only launch. Re-enable by building with
      // VIBI_BILLING_ENABLED=true once Paddle is live. Defaults to off (unset) so the credit
      // badge is display-only and the Buy-credits CTAs are hidden.
      __VIBI_BILLING_ENABLED__: JSON.stringify(process.env.VIBI_BILLING_ENABLED === "true"),
    },
    // Strip console.*/debugger from the production bundle. Adobe Marketplace review rejects
    // production builds that ship developer consoles; dev/UDT builds keep logging for debugging.
    esbuild: isProd && !diag ? { drop: ["console", "debugger"] } : {},
    plugins: [react(), uxpHtml({ diag }), copyPluginFiles(isProd)],
    resolve: {
      alias: isServe
        ? {
            // Browser preview: simulate the UXP APIs.
            uxp: resolve(__dirname, "src/uxp-stubs/uxp.ts"),
            premierepro: resolve(__dirname, "src/uxp-stubs/premierepro.ts"),
          }
        : {
            // UXP build: reach the built-ins via require() (see src/uxp-shim/*) instead of
            // leaving an unresolvable bare ESM import in the bundle.
            uxp: resolve(__dirname, "src/uxp-shim/uxp.ts"),
            premierepro: resolve(__dirname, "src/uxp-shim/premierepro.ts"),
          },
    },
    server: {
      port: 5173,
      open: false,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
        output: {
          entryFileNames: "index.js",
          assetFileNames: "[name][extname]",
          // UXP does not execute ES module scripts (<script type="module">). Emit a classic
          // IIFE bundle loaded as a plain <script>. Rollup auto-polyfills the Spectrum
          // `import.meta.url` references for non-ESM formats.
          format: "iife",
          // IIFE requires a single chunk — inline all dynamic imports into index.js.
          inlineDynamicImports: true,
        },
      },
      target: "es2020",
    },
  };
});
