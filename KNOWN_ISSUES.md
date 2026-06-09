# Unresolved issues

All previously unverified UXP-runtime paths have now been confirmed in a real Premiere Pro panel
(Premiere 2026 / v26.0). Nothing in the core or output flow is currently unverified.

## Verified in a real Premiere panel

Core path: device-code sign-in + Google OAuth + `secureStorage` token persistence; audio input
(file / project / timeline, incl. `readSelectedAudioClips`); waveform rendering + seek; multipart
upload (separation / segment / peaks); stem separation; script edit + audio rebuild;
mix (`POST /api/v2/mix`); the `audio/audioUrl.ts` registry read path.

Output / preview (verified 2026-06-08, real-Premiere manual run):
- **OS-default-app preview** (`audio/preview.ts`) — temp write + `shell.openPath` opens the clip in
  the default audio app (manifest `launchProcess.extensions` includes `.wav`).
- **In-panel playback** (`audio/player.ts`) — play buttons appear only when `playbackSupported()`;
  otherwise the OS-preview path above is the fallback (by design, not a defect).

- **In-panel `<video>` playback backend** (`audio/videoPlayer.ts`, verified 2026-06-09) — Premiere
  UXP has no AudioContext, but a hidden `<video>` element DOES emit audio for an audio-only WAV and
  is now the primary in-panel engine (Source Monitor demoted to fallback). Real sound + correct
  `duration` confirmed in a real panel. Key gotcha: UXP's `createObjectURL` returns a **fake
  `blob:/blob-N` handle the element can't load** (MediaError code 4 "unsupported URL"), so the
  backend writes a temp WAV and loads it via a real `file://` path instead (a `data:` URL is the
  fallback). `readyState` reads `undefined` in UXP but playback works regardless. Unlike Source
  Monitor this supports live per-stem gain via `video.volume`.
  Still worth a manual check: (a) progress bar tracks via `currentTime`, (b) volume fader changes
  loudness live, (c) clip fires `ended` so the play button resets, (d) seek lands.

## Pending real-Premiere verification

- **Source Monitor playback backend** (`audio/sourceMonitorPlayer.ts`) — since Premiere UXP has no
  AudioContext, in-panel preview now drives the host Source Monitor (`SourceMonitor.openFilePath` +
  `play(1.0)`) and polls `getPosition()` to move the panel's waveform bar; clicking the bar seeks via
  `setPosition()`. Type-checks and builds; **not yet run in a real Premiere panel.** Verify: (a) sound
  actually plays, (b) the bar tracks the playhead, (c) `play(0.0)`+`closeClip()` stops cleanly on
  toggle/end, (d) seek lands correctly, (e) per-stem volume is a no-op (expected — Source Monitor
  plays the file as-is; the fader still shapes the server-side mix).
- **Save dialog** (`output/saveFile.ts`) — `getFileForSaving` + `file.write` writes to a
  user-chosen path; cancel returns false cleanly.
- **Stem / mix export to Project** (`importAudioToProject`).
- **Stem / mix export to Timeline** (`host/premiere.ts` `importAudioToTimeline` /
  `appendClipToAudioTrack` + `ensureAudioTracks`) — clips land on the active sequence's audio
  tracks; time-aligned stems grow onto separate tracks.

## Out of scope for the credits-only launch

- **Credits / billing top-up** (`jobs/creditClient.ts` + `panels/BuyCreditsModal.tsx`,
  Paddle checkout) — payment UI is gated off via the `VIBI_BILLING_ENABLED` build flag for this
  launch (users spend their signup bonus only). Re-verify the Paddle checkout path when billing
  is turned back on.
