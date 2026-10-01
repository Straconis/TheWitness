# The Witness: current Craig adaptation

The target is a private, no-paywall recording package for the owner and friends.
This release implements the core recording and export workflow; it is not full
Craig feature parity. No subscription, SKU, supporter tier or server blessing
is required. Optional integrations and automation are opt-in.

Craig reference: https://github.com/CraigChat/craig, commit `60d1a00`, in the
ignored `reference/` checkout. Its ISC notice is preserved in
`licenses/Craig-ISC.txt`. Bundled audio dependencies retain their own notices.

| Area | Implemented locally | Remaining verification or development |
| --- | --- | --- |
| Recording | Separate speaker Opus tracks, bounded jitter handling, reconnects, graceful stop | Live Discord and encryption behavior |
| Recovery | CRC-checked salvage into a new session; originals preserved | Real interrupted group session |
| Discord controls | Compact panel, shared notes, titles, optional Bot Wrangler gate | Live permissions, buttons and gateway events |
| Automation | Persistent autojoin settings; selected voice events; separate opt-in event auto-stop | Live event transitions; weekly schedules/time zones and channel rules are now implemented |
| Exports | Ogg, WAV, FLAC, MP3, mixed audio, excerpts, Audition SESX with markers, Audacity AUP import packages, AAC/M4A and ZIP64 | Open project and markers in Audition; installed Audacity compatibility |
| Export jobs | Persistent queue, progress, cancel, retry, restart recovery | Hosting restart behavior |
| Browser capture | Signed microphone client, WebSocket audio, original PCM exports | Real browser microphone and public HTTPS |
| Web tools | Signed downloads, ranges, preview/crop, dashboard, settings, recovery and deletion | Witness editor implements waveforms/clip editing/mixing; it does not reproduce all Ennuizel UI/features. Web links remain bearer links by design |
| Integrations | Owner OAuth connection/refresh for four cloud providers; bundled whisper.cpp/base.en | Real cloud accounts and conversation accuracy; real speech execution passed locally |
| Operations | Disk warnings, bundled audio tools, offline host checker | Host native-library compatibility, quota and port routing |
| Persistence | Atomic disk-backed settings and jobs | Optional retention implemented; multiple workers are outside this single-host release |

The build and 65 automated checks pass on Linux. Tests exercise generated audio,
real local codecs and files, simulated Discord connections, HTTP/WebSocket
transport, and local cloud/recognizer fixtures. They do not prove live Discord,
real transcription accuracy, cloud authorization, Adobe compatibility or
bot-hosting.net deployment. See `LOCAL-TESTING.md` for the handoff checks.

An accelerated ten-minute, four-speaker recording test also passed with 120,000
packets and a decoded final excerpt. This is not a wall-clock network test.

Current setup and verification handoff: `READY-TO-TEST.md`. A/V sync remains
intentionally deferred. Larger Craig ecosystem parity is not implied.
