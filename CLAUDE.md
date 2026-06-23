# CLAUDE.md

Working notes for editing **vibi-adobe-plugin** (Claude Code / developers). Product overview,
install, build, and config are in [`README.md`](./README.md); this file is the build model,
UXP gotchas, host APIs, code map, and conventions.

## What this is

A Premiere Pro **UXP panel** for Perso AI audio separation. React + TypeScript + Vite → `.ccx`.
**No server of its own** — every API call goes to the shared **vibi-bff**
(`https://api.vibi.fm`; local checkout at `/Users/jepark/Desktop/EST/DubCast/vibi-bff`,
Kotlin/Ktor/Cloud Run), the same backend and credit ledger the vibi mobile app uses.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `npm run watch` | Dev build (`watch` rebuilds to `dist/` for UDT). |
| `npm run typecheck` | `tsc --noEmit` — **run before every PR.** |
| `npm run build:release` | Guarded prod build (https-only manifest, console/diag stripped). |
| `npm run package:release` | `build:release` + zip → `build/vibi-dub.ccx`. |

No test runner — `typecheck` plus the `build:release` guard are the safety net. Target a
specific backend with `VIBI_BFF_BASE_URL=https://… npm run …` (default `api.vibi.fm`).

## Build model (important)

- **The backend URL is injected at build time, not runtime**: `VIBI_BFF_BASE_URL` → Vite
  `define` `__VIBI_BFF_BASE_URL__` → `BFF_BASE_URL` in `src/config.ts`. Unset = dev
  (`localhost:8787`); set = prod.
- `isProd = (VIBI_BFF_BASE_URL is set)`. A prod build strips `localhost`/`http` domains + the
  `http` launch scheme from the manifest, drops `console.*`, and disables diag
  (`vite.config.ts` + `scripts/build-release.mjs`).
- `VIBI_DIAG=true` builds the on-panel debug overlay + console — **never ship it**
  (`build:release` rejects it).

## UXP gotchas (recurring footguns)

- **No audio output API** — AudioContext is absent and `<audio>.play()` is inert. Playback
  runs through a hidden `<video>` + `file://` temp (`src/audio/videoPlayer.ts`), with Source
  Monitor as fallback (`sourceMonitorPlayer.ts`). `<video>.volume` is clamped to 0–1, so boost
  (>100%) doesn't apply on preview — only in the exported mix.
- **Rendering** — no CSS Grid, `sp-icon` / SVG paths don't render, and **one unsupported CSS
  value drops the whole rule** (falls back to a rounded default button). Use
  `<div role="button">`; `sp-button` renders as a grey pill.
- **Manifest network domains** gate requests and are **cached** — adding/changing a domain
  needs a **Premiere restart** to take effect (a panel reload won't clear it).
- **Mixing is WAV-PCM only** — the pure-JS mixer (`src/audio/mixer.ts`) can't decode FLAC, so
  the BFF transcodes the plugin's stems to WAV.
- **Adobe Plugin ID = `b3d5d5b5`** — `manifest.json` top-level `id` (separate from the
  entrypoint id); required for Marketplace upload.

## Premiere host APIs (`src/host/`)

- **Video → audio** — `EncoderManager` extracts a local MP3 (bundled `.epr`, needs AME)
  before separation.
- **Timeline insert** — `SequenceEditor.createOverwriteItemAction` inside a transaction
  (`appendClipToAudioTrack` does not work); insert position via `getPlayerPosition` /
  `trackItem.getStartTime`.

## Code map

- **Separation** — `src/jobs/separationClient.ts`: submit is `file` + `spec`
  (projectId/fileName/byteLength) multipart; status lower-cased; `voice_all` filtered out
  (live **and** history restore).
- **State machine** — `src/panels/FileCard.tsx`: `prepping / restoring / generating / done /
  error`. On failure shows a Retry button (only when the card still has its source bytes).
- **Playback** — `src/audio/player.ts` (facade) → videoPlayer / sourceMonitorPlayer backends;
  pause/resume preserve position.
- **Credits** — `src/jobs/creditClient.ts`: 1 credit / started minute; top-ups are mobile IAP
  (no checkout in the panel).
- **Sign-in** — `src/auth/`: RFC 8628 device-code flow (handled by the BFF).

## Backend split (vibi-bff)

The plugin is client-only; server logic changes live in the vibi-bff repo. Billing hardening
sits in the BFF: per-job length cap `MAX_SEPARATION_MINUTES` (default 60); a billing-safe
submit retry (retries Perso 5xx only, not timeouts, to avoid double-charge); server-measured
duration (`computeSeparationSourceDurationMs`, anti-spoof); plugin stems cached as WAV in R2
(transcoded once, presigned thereafter).

## Conventions

- **Merges** — PR / main merges wait for the owner's go (a main merge can ship). Commit, push,
  PR, and CI are fine to run autonomously; otherwise default to the recommended approach
  without asking.
- Short feature branch → PR `--base main`.
