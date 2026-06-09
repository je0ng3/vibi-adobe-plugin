// Guarded production build for Adobe Marketplace.
//
// A plain `vite build` is unsafe to ship: `isProd` (and therefore manifest localhost/http
// stripping + console/debugger drop + backend URL injection) hinges entirely on
// VIBI_BFF_BASE_URL being set, and VIBI_DIAG re-enables the on-panel overlay + console. Forgetting
// either ships a rejectable .ccx. This script refuses to build unless the release invariants hold,
// then re-checks the actual dist/ output before declaring success.
//
// Usage:  npm run build:release            (defaults to the production backend)
//         VIBI_BFF_BASE_URL=https://… npm run build:release   (override)

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// The one production backend. Used when VIBI_BFF_BASE_URL is unset so a bare `npm run
// package:release` always produces a shippable build; override the env var to target another.
const DEFAULT_BASE = "https://plugin-api.vibi.fm";

const root = resolve(import.meta.dirname, "..");
const fail = (msg) => {
  console.error(`\n✗ release build refused: ${msg}\n`);
  process.exit(1);
};

// --- pre-flight: environment invariants -------------------------------------------------------
const provided = (process.env.VIBI_BFF_BASE_URL ?? "").trim();
const base = provided || DEFAULT_BASE;
if (!/^https:\/\//.test(base)) fail(`VIBI_BFF_BASE_URL must be https:// for a shipped build (got "${base}").`);
if (base.includes("localhost")) fail(`VIBI_BFF_BASE_URL must not be localhost (got "${base}").`);
if (process.env.VIBI_DIAG) fail("VIBI_DIAG is set — that keeps console logging and turns on the on-panel debug overlay, which Adobe rejects. Unset it for a release build.");

console.log(`▸ release build against ${base}${provided ? "" : " (default)"}`);
execSync("vite build", { cwd: root, stdio: "inherit", env: { ...process.env, VIBI_BFF_BASE_URL: base } });

// --- post-flight: verify the actual output ----------------------------------------------------
const manifestPath = resolve(root, "dist/manifest.json");
if (!existsSync(manifestPath)) fail("dist/manifest.json missing after build.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const domains = manifest.requiredPermissions?.network?.domains ?? [];
const badDomains = domains.filter((d) => /^http:\/\//.test(d) || d.includes("localhost"));
if (badDomains.length) fail(`dist manifest still allows dev domains: ${badDomains.join(", ")}`);

const schemes = manifest.requiredPermissions?.launchProcess?.schemes ?? [];
if (schemes.includes("http")) fail("dist manifest still allows the http launchProcess scheme.");

const html = readFileSync(resolve(root, "dist/index.html"), "utf8");
if (html.includes("__VIBI_DIAG__")) fail("dist/index.html still injects the diagnostics flag.");

const js = readFileSync(resolve(root, "dist/index.js"), "utf8");
// A clean prod bundle has console.* dropped; a stray one means the drop didn't run (diag/env slip).
if (/\bconsole\.(log|warn|error|debug|info)\(/.test(js)) {
  fail("dist/index.js still contains console.* calls — console drop did not run.");
}

console.log(`\n✓ release build verified: https-only manifest, no http/localhost, no diag, console stripped.`);
console.log(`  Next: npm run package  (zips dist/ → build/vibi-dub.ccx)`);
