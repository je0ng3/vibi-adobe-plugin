import { execSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const stage = resolve(root, "build/stage");
const out = resolve(root, "build/vibi-dub.ccx");

if (!existsSync(resolve(root, "dist"))) {
  console.error("dist/ missing — run `npm run build` first");
  process.exit(1);
}

// Start from a clean slate every time: `zip -r` APPENDS into an existing archive and cpSync
// overlays without pruning, so a previously-packaged file that was later removed/renamed in dist/
// would otherwise ghost into the shipped .ccx. Remove the prior stage + .ccx first.
rmSync(stage, { recursive: true, force: true });
rmSync(out, { force: true });
mkdirSync(stage, { recursive: true });
// dist/ is already a self-contained UXP plugin folder: the build (vite copyPluginFiles) writes
// dist/manifest.json AND dist/icons alongside index.html + index.js + index.css. So copy dist/
// verbatim — do NOT overlay the root manifest.json on top, or a prod build's manifest (localhost
// + http stripped for Marketplace) gets clobbered by the dev variant and the .ccx ships dev-only
// network/scheme allowances. Build with VIBI_BFF_BASE_URL set for a release .ccx.
cpSync(resolve(root, "dist"), stage, { recursive: true });

execSync(`cd "${stage}" && zip -r "${out}" .`, { stdio: "inherit" });
console.log(`packaged: ${out}`);
