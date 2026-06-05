# Known issues & platform constraints

Hard-won lessons for this plugin. The panel (this repo's `src/`) talks **only to its own backend,
`server/`** (Node + Hono, `PUBLIC_BASE_URL`) over a Bearer JWT — it never calls Perso AI, Gemini,
Paddle, or storage directly. Every Perso-specific quirk (upload codec, `api.perso.ai` vs
`portal-media.perso.ai` download-host split, `originalBackgroundPath` vs `originalSubBackground`,
`downloadInfo` readiness, 5xx retry, `getProjectInfo` envelope, tar directory-traversal guard,
`mediaSeq` source) lives **server-side** in `server/src/perso/*`, where the `PERSO_API_KEY` stays.

> A direct client-side Perso integration used to live in the panel's `src/perso/*`
> (`persoClient.ts`, `separationFlow.ts`, `persoConfig.ts`, `tar.ts`, `persoTypes.ts`) — a dead
> duplicate of the server's client. It was **removed** because it held the Perso `XP-API-KEY` in the
> client. Do **not** reintroduce it: a `.ccx` is a plain zip, so any embedded API key ships to — and
> is extractable by — every user. All third-party calls must stay behind `server/`.

## Audio formats: m4a / mp3 / wav only — FLAC silently fails

Perso audio-separation **accepts FLAC at upload time but never finishes the job** — it polls to
`progress=100, hasFailed=false, progressReason="Failed"`. The BFF rejects anything outside
`m4a / mp3 / wav`, and the plugin enforces the same whitelist up front so the user gets an immediate,
clear error instead of a job that hangs to a Perso-side failure: `AUDIO_EXTS` in
`src/host/premiere.ts` (timeline-clip reader) and `SUPPORTED_EXTS` in `src/input/audioPicker.ts`
(OS file picker). Do not add OGG / FLAC / WebM.

# No native drag from the timeline into the panel

UXP panels are web views; their HTML5 `drop` only receives **OS-filesystem file drops**
(Finder/Explorer). A clip dragged from Premiere's native timeline/project panel never
delivers a usable payload to the web layer — there is no host→UXP drag bridge. So the
`Dropzone` handles OS files only. The supported equivalent is `readSelectedAudioClips`
(`src/host/premiere.ts`): the user selects clip(s) on the timeline and the
"Add selected timeline clip" button reads the underlying media. Only m4a/mp3/wav clips are
read; video selections are skipped with the export-audio hint. Do not re-attempt native
timeline drag — it is a platform limitation, not a bug.

The reverse is also unsupported: a drag started **inside** a UXP panel cannot drop onto
Premiere's native Project panel or timeline (no UXP→host drag bridge). So separation
results are pushed back programmatically instead — `importAudioToProject` /
`importAudioToTimeline` (`src/host/premiere.ts`) write the stem/mix to a temp file and call
`project.importFiles()` (Project panel) and `sequence.appendClipToAudioTrack()` (timeline).
The per-stem/mix "Project" / "Timeline" buttons drive these. `appendClipToAudioTrack` is
called with a distinct 0-based track index per stem so time-aligned stems land on separate
tracks (overlap) rather than concatenating on one — verify track creation in a real
sequence; if the sequence lacks enough audio tracks, the call may need a track first.

# UXP runtime compatibility (verify in real Premiere Pro)

UXP is **not** a full browser. Several web APIs the plugin uses work in the Vite browser
preview but are **unverified or known-risky** in the actual UXP runtime (Premiere 25.6+).
Verify each in a real panel; if unsupported, the noted fallback is required.

| Web API used | Where | UXP risk | Fallback if unsupported |
|---|---|---|---|
| `AudioContext.decodeAudioData` | `audio/waveform.ts` (waveform peaks) | High — Web Audio often absent | **Done**: WAV peaks via pure-JS `audio/wav.ts`; mp3/m4a duration via `audio/duration.ts`; mp3/m4a preview peaks computed server-side (`POST /api/v2/peaks`, ffmpeg) and fetched in `jobs/peaksClient.ts`. |
| `OfflineAudioContext` | `audio/mixer.ts` (Mix selected) | High | **Done**: mixing is pure-JS PCM summing over WAV stems (`audio/mixer.ts` + `audio/wav.ts`), no Web Audio. |
| `<audio>` playback | (removed) | **Confirmed broken** — `pause is not a function`, crashed on render | Replaced by Web Audio engine `audio/player.ts` (AudioBufferSourceNode + GainNode). Play buttons render only when `playbackSupported()` (AudioContext present); otherwise hidden — preview via timeline import. |
| `URL.createObjectURL` + `Blob` | stem/mix/dub/srt | Medium | Write to temp via `storage.localFileSystem`, use file URL |
| `FormData` body in `fetch` | upload clients (`jobs/*Client.ts`) | **Confirmed broken** — server got no fields → 400 `audio_required` | Fixed: `jobs/multipart.ts` builds the multipart body as a raw ArrayBuffer with an explicit boundary on Content-Type. Used by separation/transcript/dubbing. Filename is ASCII-sanitized. |
| `<a download>.click()` | SRT / mp3 download in `FileCard` | High — no anchor download | Switch to `storage.localFileSystem.getFileForSaving` (currently a.click only — not yet wired) |
| `localStorage` | only in `uxp-stubs` preview | N/A | Real build uses `secureStorage` (OK) |
| `TextEncoder` / `TextDecoder` | `auth/tokenStore.ts` | **Confirmed absent** — `ReferenceError` in real UXP | `tokenStore.ts` does its own ASCII byte<->char conversion (token values are pure ASCII, so no global needed). A UTF-8 polyfill on `globalThis` in `public/uxp-polyfills.js` covers any other callers. Note `window` is NOT the global in UXP — polyfills must target `globalThis`. |

`audio/waveform.ts` and `audio/mixer.ts` already guard for a missing `AudioContext`/
`OfflineAudioContext` (return mock peaks / throw a clear error) so the panel won't hard-crash.

## Verification checklist (real Premiere panel)

1. Load `dist/` via UXP Developer Tool → panel renders, Spectrum styles intact.
2. Sign in (device code flow) → external browser opens, code authorizes, panel goes signed-in.
3. Add audio (OS file picker + drag-drop). Confirm `getFileForOpening` works.
4. Prepare → waveform draws (confirms Web Audio decode) → range drag + click seek.
5. Review script → STT returns, modal edits work.
6. Generate with separation → stems play (confirms `<audio>` + Blob URL), waveforms per stem.
7. Mix selected → confirms `OfflineAudioContext`. Use as source.
8. Generate with transcript → SRT download (confirms file save).
9. Generate with dubbing → per-language mp3 plays + downloads.
10. Credits badge updates; insufficient-credits path shows the notice.

Anything that fails here points to the fallback column above.
</content>
</invoke>
