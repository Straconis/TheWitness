# The Witness: Craig package adaptation

## Product direction

The Witness is a private deployment for the owner and friends on bot-hosting.net.
The target is Craig's whole recording package, with all features available without
subscriptions, SKUs, supporter tiers, or server blessings. Real storage and host
resource constraints still apply. The host's actual available services have not
been verified; do not assume Docker, PostgreSQL, Redis, FFmpeg, or multiple public
ports are available.

Reference: https://github.com/CraigChat/craig, local checkout in `reference/`,
commit `60d1a00`. Keep the reference checkout unchanged and excluded from Git.
Craig's root ISC notice is preserved in `licenses/Craig-ISC.txt`; preserve any
additional notices when adapting other components or bundled dependencies.

## Comparison

| Component | Craig source | The Witness today | Remaining work |
| --- | --- | --- | --- |
| Discord bot | apps/bot | Commands and voice joining | Typed interactions, command acknowledgement, live connection tests |
| Multitrack recorder | apps/bot/src/modules/recorder | Opus capture, separate tracks and split-file session writer | Packet reordering, reconnect behavior, end-to-end recording validation |
| Recovery | recorder/recording.ts and writer.ts | Graceful finalization, write errors and interrupted-session marking | Reconnection and validated recovery/export of interrupted files |
| Automation | bot/modules/autorecord.ts | In-memory toggles; auto-record starts the engine | Persistent settings and scheduling/channel rules |
| Notes and recording management | bot/commands | None | Notes, list/info, access checks, deletion |
| Browser recording | recorder/webapp.ts | None | Browser client, authorization, WebSocket transport, FLAC and continuous modes |
| Exports | apps/kitchen and cook helpers | None | Timestamp correction, per-user and mixed formats, archive generation, durable job queue |
| Download interface | apps/ferret | None | Private download links, format selection, export status and deletion |
| Dashboard | apps/dashboard | None | Recording/settings management and authorization |
| Browser editing/streaming | apps/ennuizel-streamer | None | Editor delivery and recording streaming |
| Background jobs | apps/tasks | None | Retention, cleanup, upload processing |
| Persistence and coordination | packages/db, Redis integrations | None | Host-compatible storage and job coordination |
| Operations | apps/botctl and deployment files | Console logging | Health/status, deployment configuration, restart behavior |
| Feature access | bot/config.ts, util.ts, entitlements.ts; consumers elsewhere | Always-enabled recording metadata policy | Apply the policy across bot, browser and export interfaces |

## Implementation sequence

1. Adapt recorder primitives with format tests. CRC and Ogg page encoding are
   now implemented, including segment-boundary tests and 64-bit granule positions.
2. Build the session writer around Craig's `.header1`, `.header2`, `.data`,
   `.users`, and metadata conventions, preserving timestamp packets needed by
   Craig's correction/export tools. Check compatibility with the cook helpers.
3. Connect voice reception to sessions and make `/record`, `/stop`, and `/status`
   reflect actual recording state. Handle concurrent starts and storage failures.
4. Add graceful finalization, reconnect behavior, interrupted-session recovery,
   persistent automation settings, notes and recording management.
5. Adapt export workers and download UI together, using real fixtures to verify
   synchronization and each supported format.
6. Adapt browser recording, editor/streaming and dashboard, with one consistent
   always-enabled feature policy instead of scattered tier bypasses.
7. Package the full deployment for verified bot-hosting.net capabilities; validate
   restart persistence, public download access and an end-to-end group session.

The current encoder returns a page buffer rather than owning a stream. The future
session writer must handle backpressure and propagate disk errors. A single packet
is limited to 65024 bytes by this one-page encoder; larger packets must be split
by a future continuation-page implementation, not silently truncated.

## Current verification

TypeScript build and fourteen automated checks pass on Linux. Tests cover Ogg
checksums/lacing, speaker separation, paired timestamps, concurrent starts,
finalization, failure states and interrupted-session preservation. Craig's
original `oggtracks` C helper recognizes both tracks in a generated Witness
fixture. The live Discord connection, audio decoding, timestamp correction,
exports, browser interfaces and hosting deployment remain unverified.

Recordings are stored at `<RECORDING_PATH>/<session UUID>/audio.ogg.*`, with
Witness lifecycle metadata in `session.json`. The `.info` file contains basic
Craig-format identifiers and all feature flags, but is not yet a complete
replacement for Craig's download authorization/recording database. Raw packets
are currently stored in arrival order; packet jitter reordering and automatic
reconnection remain to be adapted. Settings still reset when the bot restarts.
