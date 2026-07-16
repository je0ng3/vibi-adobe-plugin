# Vibi: AI Sound Eraser

A React/UXP panel for Adobe Premiere Pro that splits a clip's audio into per-speaker voice
stems and background music using **Perso AI** — separate, preview, balance, and drop the result
back onto the timeline without leaving Premiere. It's a thin client of the shared
[vibi-bff](https://github.com/perso-devrel/vibi-bff) backend (the same backend and credits the
vibi mobile app uses); this repo holds no server of its own.

## Features

- **Speaker separation** — split a clip into per-speaker voice stems + background music.
- **In-panel preview** — per-stem waveform, playback (play / pause-resume), and a volume fader.
- **Mix & import** — pick stems, mix them locally, then import into the Premiere project or onto
  the timeline.
- **Script & history** — view and edit the diarized script; saved separations restore per project
  across sign-ins and devices.
- **Accounts & credits** — Google sign-in; credits are billed per started minute and topped up in
  the vibi mobile app.

## Quickstart (development)

```bash
npm install
npm run watch      # dev build, rebuilt on change → dist/
npm run typecheck  # tsc --noEmit
```

Load the plugin with the **UXP Developer Tool** (UDT): *Add Plugin* → `manifest.json` → *Load*.
The panel appears under Premiere's **Window** menu. A dev build (no `VIBI_BFF_BASE_URL`) targets
`http://localhost:8787`; point at a real backend with
`VIBI_BFF_BASE_URL=https://api.vibi.fm npm run watch`.

## Build & package (release)

```bash
npm run release:patch     # bump version → prod build + .ccx → commit + tag (also :minor / :major)
npm run package:release    # just the guarded prod build + zip → build/vibi-dub.ccx (no version bump)
```

`release:*` bumps the version in `package.json` **and** `manifest.json` in lockstep (a mismatch is
rejected by Marketplace), runs `package:release`, then commits the two version files and tags
`vX.Y.Z`. It does **not** push — it prints the `git push && git push --tags` to run when ready. The
version bumps at release time (not on every `main` push) so the number stays 1:1 with shipped
builds; add `--no-git` (`node scripts/release.mjs patch --no-git`) to build without committing.

Both default to the `https://api.vibi.fm` backend (override with `VIBI_BFF_BASE_URL=…`). The build
is guarded for Marketplace — https-only manifest, no diagnostics, console stripped — and the
Adobe-assigned id `b3d5d5b5` (`manifest.json` top-level `id`) is required for upload.

## Configuration

The backend (env, deploy, cost) lives in the
[vibi-bff](https://github.com/perso-devrel/vibi-bff) repo. The plugin has only **build-time**
inputs — Vite inlines them; they are not read at runtime:

| Env (build-time)    | Default                 | Effect                                                            |
|---------------------|-------------------------|-------------------------------------------------------------------|
| `VIBI_BFF_BASE_URL` | `http://localhost:8787` | Backend base URL → `src/config.ts`. **Setting it = production build** (manifest localhost/http stripped). |
| `VIBI_DIAG`         | *(unset)*               | `=true` builds the on-panel diagnostics overlay. Dev only.        |

## Architecture

React 18 · TypeScript · Vite · Spectrum Web Components (`@swc-uxp-wrappers`), on the Premiere Pro
UXP runtime.

```
Premiere Pro (UXP)
  └─ Vibi: AI Sound Eraser panel  ← this repo (React + TS → .ccx)
         │  HTTPS  (BFF_BASE_URL, build-time)
         ▼
   vibi-bff  (api.vibi.fm)      ← shared backend (Kotlin/Ktor/Cloud Run)
         ├─ Perso AI  (separation)
         ├─ Postgres  (accounts · credits · history)
         └─ R2        (stems)
```

The vibi mobile app (KMP/CMP) targets the same backend and credits; only the UI differs.

```
src/
├── panels/   # UI: SeparationPanel, FileCard, StemCard, MixOutputView, ScriptEditor, …
├── jobs/     # BFF clients: separationClient, creditClient, peaksClient, segmentClient
├── audio/    # playback, mixer, waveform
├── auth/     # device-code sign-in
├── host/     # Premiere integration: project / timeline import, audio extract
└── config.ts # build-time config
```

Build scripts live in `scripts/` (`build-release.mjs`, `package.mjs`, `release.mjs`). See
[`CLAUDE.md`](./CLAUDE.md) for the build model, UXP constraints, host APIs, and the code map.
