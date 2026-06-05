import { execSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const stage = resolve(root, "build/stage");
const out = resolve(root, "build/vibi-dub.ccx");

if (!existsSync(resolve(root, "dist"))) {
  console.error("dist/ missing — run `npm run build` first");
  process.exit(1);
}

mkdirSync(stage, { recursive: true });
// Built artifacts (dist/index.html + index.js + index.css + assets) go to the stage root,
// so manifest `main: index.html` resolves to the production bundle — not the dev index.html.
cpSync(resolve(root, "dist"), stage, { recursive: true });
cpSync(resolve(root, "manifest.json"), resolve(stage, "manifest.json"));
cpSync(resolve(root, "icons"), resolve(stage, "icons"), { recursive: true });

execSync(`cd "${stage}" && zip -r "${out}" .`, { stdio: "inherit" });
console.log(`packaged: ${out}`);
