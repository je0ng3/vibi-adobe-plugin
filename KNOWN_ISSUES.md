# Unresolved issues

Implemented with a UXP-safe approach and working in the Vite browser preview, but **not yet
confirmed in a real Premiere Pro panel** (UXP runtime, Premiere 25.6+). The open question for each
is whether the approach holds in the actual runtime.

Already verified in a real panel and removed from this doc: device-code sign-in + `secureStorage`
token persistence; multipart upload (separation / segment / peaks); audio input
(file / project / timeline); waveform rendering; stem separation; script edit + audio rebuild;
mix (`POST /api/v2/mix`); the `audio/audioUrl.ts` registry read path (exercised by mix + export);
and **Project-panel export** (`importAudioToProject`). What remains is the **playback**,
**timeline export**, and **billing** surface.

## Implemented but unverified in the real UXP runtime

| Area | Where | What to confirm | Fallback if it breaks |
|---|---|---|---|
| In-panel playback (Web Audio) | `audio/player.ts` | `AudioContext` constructs from a click; WAV plays via parsed PCM; volume fader works. | If absent, `playbackSupported()` is false → OS-default-app preview. |
| Waveform seek | `panels/Waveform.tsx` + `audio/player.ts` | Click / drag on a waveform moves the playback position. | — |
| OS-default-app preview | `audio/preview.ts` | Temp write + `shell.openPath` / `openExternal` opens the clip in the default audio app. | — |
| Save dialog | `output/saveFile.ts` | `getFileForSaving` + `file.write` writes to a user-chosen path. | This IS the fallback for the broken `<a download>`. |
| Stem / mix export to **Timeline** | `host/premiere.ts` (`importAudioToTimeline`) | `appendClipToAudioTrack` lands clips on the active sequence's audio tracks (Project-panel export already verified). | — |
| Audio-track creation | `host/premiere.ts` (`ensureAudioTracks`) | Which track API exists — `getAudioTrackCount` / `addAudioTrack` / `addTracks` — so time-aligned stems grow onto separate tracks. | Clamp to the last existing track; clear error asking the user to add tracks. |
| Credits / billing | `jobs/creditClient.ts` + `panels/BuyCreditsModal.tsx` | Badge updates after a separation; insufficient-credits path shows the Buy credits notice; Paddle checkout opens (`shell.openExternal`). | — |

## Verification checklist (remaining)

1. Stem / mix plays in-panel when `playbackSupported()`; otherwise preview opens the OS default app
   (`audio/preview.ts`).
2. Click / drag seek on a waveform moves the playback position; volume fader affects live playback.
3. Export a stem and the mix to the **Timeline** — confirm `appendClipToAudioTrack`, and that
   `ensureAudioTracks` grows the sequence enough for time-aligned stems on separate tracks.
4. Save a stem / mix via the save dialog (`getFileForSaving`).
5. Credits badge updates after a separation; the insufficient-credits path shows the Buy credits
   notice and Paddle checkout opens.

Anything that fails here points to the fallback column above.
</content>
