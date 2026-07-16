// One-shot release: bump version → prod build → package .ccx → commit + tag.
//
// The version lives in TWO files (package.json + manifest.json) and Marketplace rejects a
// mismatch, so `npm version` alone is unsafe — this keeps them in lockstep. Marketplace release
// is manual (upload build/vibi-dub.ccx), so the version bumps HERE, at release time, not on every
// main push: the number stays 1:1 with shipped builds instead of counting commits.
//
// Usage:  npm run release:patch            (1.0.5 → 1.0.6, commit + tag v1.0.6)
//         npm run release:minor|major
//         node scripts/release.mjs patch --no-git    (bump + build only, no commit/tag)
//
// Order is bump → build → commit: if the build fails the files are left bumped-but-uncommitted so
// you just re-run once fixed. The commit stages ONLY the two version files, never a stray edit.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const level = process.argv[2];
const noGit = process.argv.includes("--no-git");

if (!["patch", "minor", "major"].includes(level)) {
  console.error(`usage: node scripts/release.mjs <patch|minor|major> [--no-git]`);
  process.exit(1);
}

const bump = (v) => {
  const [maj, min, pat] = v.split(".").map(Number);
  if ([maj, min, pat].some((n) => !Number.isInteger(n))) throw new Error(`bad version "${v}"`);
  if (level === "major") return `${maj + 1}.0.0`;
  if (level === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
};

// --- read current version from package.json, keep manifest.json in lockstep -------------------
const pkgPath = resolve(root, "package.json");
const manPath = resolve(root, "manifest.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const man = JSON.parse(readFileSync(manPath, "utf8"));

const from = pkg.version;
const to = bump(from);
if (man.version !== from) {
  console.warn(`⚠ manifest.json (${man.version}) was out of sync with package.json (${from}) — resyncing to ${to}.`);
}

// Preserve formatting: replace just the version value so diffs stay to one line each.
const rewrite = (path, cur) => {
  const src = readFileSync(path, "utf8");
  const next = src.replace(
    new RegExp(`("version"\\s*:\\s*)"${cur.replace(/\./g, "\\.")}"`),
    `$1"${to}"`,
  );
  if (next === src) throw new Error(`could not rewrite "version" in ${path}`);
  writeFileSync(path, next);
};
rewrite(pkgPath, pkg.version);
rewrite(manPath, man.version);
console.log(`▸ version ${from} → ${to}`);

// --- prod build + package (build-release verifies the release invariants) ---------------------
execSync("npm run package:release", { cwd: root, stdio: "inherit" });

// --- commit + tag (version files only) --------------------------------------------------------
if (noGit) {
  console.log(`\n✓ built ${to} (--no-git: skipped commit/tag). build/vibi-dub.ccx ready.`);
  process.exit(0);
}
execSync(`git add package.json manifest.json`, { cwd: root, stdio: "inherit" });
execSync(
  `git commit -m "chore(release): v${to}" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`,
  { cwd: root, stdio: "inherit" },
);
execSync(`git tag v${to}`, { cwd: root, stdio: "inherit" });
console.log(`\n✓ released v${to}: committed + tagged. build/vibi-dub.ccx ready to upload.`);
console.log(`  Push when ready:  git push && git push --tags`);
