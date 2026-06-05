# Unresolved issues

Everything below is implemented with a UXP-safe approach and works in the Vite browser preview,
but is **not yet verified in a real Premiere Pro panel** (UXP runtime, Premiere 25.6+). The open
question for each is whether the approach holds in the actual runtime. These are the only items
still open — resolved constraints and shipped fixes have been removed from this doc.

## Implemented but unverified in the real UXP runtime

| Area | Where | What to confirm | Fallback if it breaks |
|---|---|---|---|
| Blob URL + `fetch(objectURL)` | `audio/audioUrl.ts` | `createObjectURL` is guarded and every handle's bytes are cached in a registry, so playback/preview/import/mix read bytes without `fetch(objectURL)`. Confirm all four read correctly. | Synthetic `mem://` handle path must still round-trip bytes when `URL`/`Blob` are wholly absent. |
| Web Audio playback | `audio/player.ts` | `AudioContext` constructs from a click; WAV plays via parsed PCM; volume fader + seek work. | If absent, `playbackSupported()` is false → preview via OS default app (`audio/preview.ts`). |
| OS-default-app preview | `audio/preview.ts` | Temp file write + `shell.openPath`/`openExternal` opens the clip in the default audio app. | — |
| Save dialog | `output/saveFile.ts` | `getFileForSaving` + `file.write` writes to a user-chosen path. | This IS the fallback for the broken `<a download>`. |
| Multipart upload | `jobs/multipart.ts` | Raw-ArrayBuffer body with explicit boundary reaches the server with fields intact (separation / peaks / segment / extract). | — |
| Temp-file import | `host/premiere.ts` (`importAudioToProject` / `importAudioToTimeline`) | Temp write + `project.importFiles` + `appendClipToAudioTrack` land clips on the Project panel / timeline. | — |
| Audio-track creation | `host/premiere.ts` (`ensureAudioTracks`) | Which track API exists — `getAudioTrackCount` / `addAudioTrack` / `addTracks` — so time-aligned stems grow onto separate tracks. | Clamp to the last existing track; clear error asking the user to add tracks. |
| Device-code sign-in | `auth/*` | External browser opens, code authorizes, panel goes signed-in; a 401 routes back to login with a notice. | — |
| `secureStorage` token persistence | `auth/tokenStore.ts` | Token survives panel reload; ASCII byte conversion + `globalThis` UTF-8 polyfill cover the absent `TextEncoder`/`TextDecoder`. | — |

## Verification checklist (real Premiere panel)

1. Load `dist/` via UXP Developer Tool → panel renders, Spectrum styles intact.
2. Sign in (device code flow) → external browser opens, code authorizes, panel goes signed-in.
3. Add audio three ways: OS file picker, OS drag-drop, and "Add selected timeline clip"
   (`readSelectedAudioClips`). Only m4a/mp3/wav are accepted.
4. Per-file card preps → waveform draws (WAV via pure-JS `audio/wav.ts`; mp3/m4a via server peaks,
   `POST /api/v2/peaks`) → click-seek on the bar.
5. Separate → stems return with per-stem waveform, volume fader, and select checkbox. Stems play
   in-panel when `playbackSupported()`; otherwise preview opens the OS default app (`audio/preview.ts`).
6. "Check script" → the diarized script expands (no extra STT job), speaker edits persist across
   collapse, and "rebuild audio" re-cuts isolated speaker tracks (`segmentClient`).
7. Mix selected → server mix (`POST /api/v2/mix`, ffmpeg) returns a WAV that plays / imports.
8. Import a stem and the mix to **Project** and **Timeline** — confirm temp-file write +
   `project.importFiles` + `appendClipToAudioTrack`; ensure `ensureAudioTracks` grows the sequence
   enough for time-aligned stems.
9. Credits badge updates after a separation; the insufficient-credits path shows the Buy credits notice.

Anything that fails here points to the fallback column above.
</content>
</invoke>
