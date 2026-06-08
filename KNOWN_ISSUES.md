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
