![The Witness banner](docs/images/discord_banner.png)

# The Witness

The Witness is a multitrack Discord recording bot based on [Craig](https://craig.chat/), designed for TTRPG sessions and private groups across multiple Discord servers. A hosted version is provided by the project owner on a RackNerd VPS, with automatic deployment from GitHub and private web downloads at [thewitness.dev](https://thewitness.dev). Exports support separate speaker tracks, mixdowns, reusable intros, configurable silence trimming, audio normalization, and local transcription.

**[Add The Witness to your Discord server](https://thewitness.dev/invite)**

## Hosted or self-hosted — your choice

A hosted version of The Witness is provided by the project owner for people who want to use the bot without running a server themselves. Self-hosting is optional: the source code is available so you can run your own instance, inspect how it works, or customize it if you want to. You do not need to deploy the source code to use the hosted version.

## How The Witness differs from Craig

[Craig](https://craig.chat/) provides the multitrack recording foundation and remains an established option for Discord communities. The Witness adapts Craig's recording files and timestamp correction for a privately operated service, with export options aimed at reducing weekly TTRPG editing work. Craig's attribution is preserved in [its license notice](licenses/Craig-ISC.txt).

The comparison below refers to **Craig's public hosted service**. Craig also publishes [self-hosting instructions](https://github.com/CraigChat/craig/blob/master/SELFHOST.md); hosting and operational policies can differ for self-hosted installations.

| Area | Craig's public service | The Witness |
| --- | --- | --- |
| Hosting and maintenance | A hosted bot you invite to your server. | Use the version hosted by the project owner, or run your own instance. The hosted deployment uses a RackNerd VPS with automatic deployment from GitHub. |
| Recording limits | Advertises recordings up to 6 hours, retained for 7 days. | Default 8-hour maximum per recording session, configurable from 2–24 hours; disk space and host resources also limit recording. Optional retention is controlled by the operator. |
| Transcription | Available to Tier 3 Supporters. | Server-side Whisper transcription is already configured on the live deployment and produces TXT, SRT, and VTT when requested for an export, without a subscription or user setup. Self-hosted instances need a Whisper executable/model and processing capacity. |
| Export formats | Advertises FLAC, AAC, Audacity projects, and Adobe Audition sessions; its FAQ says MP3 export is unavailable. | FLAC, WAV, AAC/M4A, Ogg Opus, MP3, Audacity import projects, and Adobe Audition sessions. Project ZIPs offer WAV or FLAC for individual tracks. |
| Customization | Public service features and settings are maintained by Craig's operators. | Use the hosted version without managing deployment, or use the available source to control your own instance. Implemented features have no Witness premium tiers; hosting still has a cost. |

Craig's service details were checked on October 2, 2026 against its [official website](https://craig.chat/) and [FAQ](https://craig.chat/faq/). They can change.

### The Witness export workflow

The private download page lets you combine these options in one export:

- Select speakers for the mixdown while keeping their separate tracks.
- Add a reusable server intro before the session, with optional volume matching to the selected speakers.
- Normalize speaker levels independently of intro matching.
- Remove shared silent pauses longer than a chosen duration (0.1–3600 seconds; default 30). Cuts apply to all processed speaker tracks together, and notes follow the new timeline.
- Include full-length, uncut FLAC copies alongside processed tracks in the ZIP. These originals have no trims, normalization, edits, or intro padding.
- Choose date-only (`YYYY-MM-DD.zip`), date plus channel, or original download filenames.
- Include local transcription and export notes with the project.

These describe Witness's implemented workflow, rather than claiming Craig lacks every comparable feature. The Witness does not reproduce the complete Craig ecosystem, browser editor, or backup-bot service.

### What has been verified

Generated recordings and production downloads have verified codecs, both speakers in a mixdown, synchronized silence cuts, intro insertion and volume matching, uncut originals, ZIP contents, and transcription completion. These checks do **not** establish real conversation transcription accuracy or live Discord recording reliability. A real microphone/group session remains the next validation step. See [the implementation comparison](docs/CRAIG-PARITY.md) for additional scope and limitations.

## Goals

- Per-user multitrack Discord voice recording
- Self-hosted on a VPS with automatic deployment from GitHub
- All implemented features available without premium tiers
- Default 8-hour maximum recording sessions; configurable 2, 4, 6, 8, 12, 16, or 24 hours
- No plugin marketplace architecture
- Local recording storage
- Reliable session recovery
- Multiple export formats
- Clear recording-state indication
- Designed with TTRPG sessions in mind

## Reference Implementations

External source repositories used for research are stored under /reference
and are intentionally excluded from this repository.

Craig:
https://github.com/CraigChat/craig

## Development state

The bot now captures received Opus packets into separate speaker tracks using
Craig's split recording files. `/record` starts a session, `/stop` drains and
finalizes it, and `/status` reports saved packet and track counts. Automatic
recording uses the same engine. Interrupted sessions are marked on startup and
raw audio is preserved. All recording feature flags are enabled without tiers.

Run `npm test` to build and check the recorder. Craig timestamp correction and per-speaker Ogg exports are tested with generated
audio. Live Discord recording remains unverified. Browser capture, dashboard, durable export jobs and recovery now have local integration checks.

See [the current package comparison](docs/CRAIG-PARITY.md).
Craig attribution is preserved in [licenses/Craig-ISC.txt](licenses/Craig-ISC.txt).

## Audio exports

Build the app with `npm run build`, then build Craig's timestamp correction tool
with `npm run build:cook` (requires a C compiler on Linux). Export a completed
session with `npm run export -- <session UUID> ogg`. The result is a directory
inside that session containing numbered speaker files and a manifest mapping
filenames to participants. This does not require a Discord token.

Replace `ogg` with `wav`, `flac`, `mp3`, `aac`, `audition`, or `audacity` to convert through FFmpeg. FFmpeg must
be installed on the host, placed in `bin/ffmpeg`, or configured through
`FFMPEG_PATH`. Ogg, WAV, FLAC, MP3 and AAC exports have been verified locally with
generated audio and decoding checks. Formats have no payment or tier checks.
The local FFmpeg executable is excluded from Git. The testing payload includes a
Linux x86_64 FFmpeg binary and Craig correction tool. To rebuild them, run
`python3 scripts/prepare-audio-sources.py`, then
`sh scripts/build-portable-audio.sh` on a Linux development machine.
Exports are streamed from disk and processed one track at a time. An interrupted
or failed recording cannot be exported until its recovery has been validated.
Use `/recordings` to list recent server sessions and `/export session:<UUID>
format:<format>` to request a private ZIP attachment. Attachment delivery currently
uses an 8 MiB budget; larger exports stay saved on the host when the download service is disabled. One export runs at a time. With the download service enabled, `/export` returns a private web link instead
of an attachment. These Discord interactions still need a live bot test. Automation settings persist in `settings.json` inside
the recording directory; disabling auto-join also disables auto-record.

## License

The Witness project code is licensed under [ISC](LICENSE). Craig's copyright
and permission notices are retained in the root license and
[licenses/Craig-ISC.txt](licenses/Craig-ISC.txt).

Dependencies and external executables retain their own licenses. The local
FFmpeg build uses LGPL components and is not tracked in this repository.
Its notices and pinned upstream source information are in `licenses/audio/`.
Any deployment package that includes FFmpeg must preserve its notices and
provide the corresponding source and build information as its license requires.
The Witness's ISC license does not replace those third-party terms.

## Private download service

Set `DOWNLOAD_PORT` to the port allocated by your host and
`DOWNLOAD_PUBLIC_URL` to the public origin (for example,
`https://downloads.example.com`, with no path). Leave the port unset to keep
web downloads disabled. The server runs in the same Node process as the bot;
no additional framework or service is required. Public HTTPS must be provided
by the hosting platform or its reverse proxy; this Node listener uses HTTP.

When enabled, `/export` returns a signed link valid for 24 hours. The download
page lists participant tracks and streams each file, including ranged/resumed
requests, without buffering an entire recording. Anyone holding the link can
access that export, so links are sent privately in Discord. They are scoped to
one export, not to every recording in the server.

The signing key is generated in `<RECORDING_PATH>/download-key`. Keep the
recording directory persistent across host restarts; removing or replacing this
key invalidates old links. Host port routing and public HTTPS have not been
verified on bot-hosting.net yet.

## Session notes and mixed audio

Use `/note text:<your note>` while recording to save a timestamped session note.
Notes are written using Craig's note track convention and as a sidecar file.
Exports include `notes.json` when notes are present.

Choose `mix:true` with `/export` to include mixed session audio alongside separate
speaker tracks. From the command line use
`npm run export -- <session UUID> wav --mix` (other supported formats work too).
Mixing requires FFmpeg and uses the corrected Opus originals before conversion,
with normalized levels and the longest speaker track determining mix length.
ZIP attachments and private download pages include the mix and notes.

## Voice packet reliability

Voice capture uses a bounded per-speaker reorder window modeled on Craig's
16-packet buffer. It preserves each packet's original arrival time, handles
32-bit RTP timestamp rollover, and removes duplicates or packets arriving after
their place in the stream has already been written. Short bursts flush after
about 200 ms; stopping drains every remaining packet before closing storage.
Timestamp epochs reset after more than two seconds of silence to accommodate a
restarted speaker stream. Dropped duplicate/late packet counts are retained in
session metadata. The reorder buffer has a 16 MiB aggregate memory budget;
exceeding it fails the session visibly instead of silently discarding audio.
Automatic reconnection now has local tests. Live Discord validation remains unfinished.

## Local readiness and web features

See [the local testing checklist](docs/LOCAL-TESTING.md) before buying hosting.
The compiled application targets Node 24. Run `npm run check:host` for offline
runtime checks. No TypeScript compilation is needed on the hosting service.

With downloads enabled, `/webapp` opens a private browser microphone link for
an active recording (up to 8 remote guests per recording; the connection is pinged every 25 seconds so reverse proxies keep it open, and guest audio is shed first if storage falls behind, so guest backpressure is less likely to fail the Discord recording) and `/dashboard` opens recording/settings management.
Browser audio preserves original PCM for lossless WAV/FLAC speaker exports.
Download pages support audio previews and clipped exports. `/recover` salvages
checksummed complete audio from interrupted sessions into a new session while
keeping the original. Valid sync-cue metadata is retained with its original cue IDs and timing; damaged optional cue metadata is skipped with a warning so audio recovery can continue. Browser-guest recovery currently falls back to Opus and does not preserve the separate lossless PCM. `/delete` requires explicit confirmation and Manage Server.

Exports persist in a disk-backed queue and resume queued jobs after restart.
The live deployment already has server-side Whisper transcription configured: select
Include a transcript on the download page or use `transcribe:true` with `/export`
to produce TXT, SRT, and VTT without user setup or a subscription. Self-hosting
operators must provide the bundled or configured executable/model and processing
capacity; cloud adapters require separate configuration. See `.env.example`. Full Craig parity is still tracked in
`docs/CRAIG-PARITY.md`.

## Audition projects and readable download names

`/export` defaults to an Audition project. Choose `format:audition` explicitly to download a ZIP containing
`session.sesx` and separate, aligned 48 kHz FLAC tracks. Extract the entire ZIP
into one folder, then open `session.sesx` in Audition. FLAC files are the session's
linked media; keep them beside the session file. Track labels use participant
names. The session generator follows Craig's SESX structure. Local checks verify
XML, references, clip lengths and ZIP integrity; opening it in Adobe Audition
is still pending. ZIP64 packaging streams from disk for large projects.

ZIP download names default to the recording start date in UTC (`YYYY-MM-DD.zip`).
Use `/downloadnames style:date-channel` for `YYYY-MM-DD-channel-name.zip`,
`style:date` for date only, or `style:original` for original filenames.
New recordings save the channel name at recording start; older recordings fall back
to their channel ID. Same-day exports can share a download filename; storage remains
separate and browsers handle duplicate downloads. Individual files keep their detailed names.
The dashboard exposes the same setting, and each download page has a naming
toggle. Changing names preserves private URL authorization and source files.
Clipped individual-file exports add their selected range to readable filenames. The Audition
ZIP uses readable naming too; names inside the project ZIP stay stable so the
session's media references keep working.

## Titles, edit markers and storage warnings

Start with `/record title:Campaign episode 1`, or name the active recording
using `/title text:Campaign episode 1`. Add `session:<UUID>` to `/title` to name
a saved session. Titles also have a dashboard control and appear in recordings,
download pages and readable filenames. Existing exports retain their snapshot
title; export again after a rename to use the new title.

Session notes export into the Audition session as XMP cue markers. Marker times
are relative to the exported audio. Excerpts include only notes in their selected
range and shift those notes to the excerpt timeline; original notes stay intact.
Audition must still verify how it displays these markers.

Storage checks run at startup and once a minute. Below `LOW_DISK_WARNING_GIB`
(default 1 GiB), the console logs a warning when entering the low-space state.
The dashboard and `/status` show available space and a low-space warning. No
automatic deletion is enabled by default. Sessions default to an 8-hour maximum, configurable with `/recordinglimit` (2–24 hours). Filesystem
free space does not necessarily reflect hosting-provider storage quotas. Below `CRITICAL_DISK_MIB` (default 256 MiB, capped at half the warning threshold; `0` disables it), recordings are finalized and new recordings and queued exports wait until space is freed. Nothing is deleted.

## Compact Discord recording panel

`/record` posts one compact panel in the command's text channel, updating it
in place about every ten seconds. It shows recording duration, track/note counts,
connection or reconnect state, packet drops and low-disk-space warnings. It uses
bot message edits so updates continue beyond interaction-token expiry. Automatic
recordings try to post the panel in the voice channel's text chat. Missing send
permissions leave recording working and `/status` available. On a graceful shutdown, recordings finalize before the last card edit, which shows saved or failed state and disables live recording controls.

The panel includes **Status**, **Add note** and **Stop** buttons. Any member of
the server may use `/note` or the Add note form; they do not need to have started
the recording or hold an administrator role. Notes retain the author's user ID
and timestamp. Stopped panels disable their controls; reconnects and completion
edit the same message. No dashboard window is needed during a game. These Discord
interactions have offline integration tests; live server behavior remains pending.

## Optional Bot Wrangler role

Access defaults to everyone. Create a Discord role named **Bot Wrangler** (or
choose another existing role), then use `/access mode:role role:@BotWrangler`
to restrict Discord commands, panel buttons, note submissions and automatic join
triggers to role members. Use `/access mode:everyone` to reopen access, or
`/access mode:status` to inspect the policy. Assign the role to the DM and anyone
else who should add notes or control recording. Role mode intentionally gates
notes too; everyone mode retains shared notes for all server members.

Changing or inspecting this policy requires **Manage Server** permission. Server
managers can use `/access` without the selected role, preventing configuration
lockout. Other commands do not have a general administrator bypass. The setting
survives restarts; a missing/deleted role can be replaced by a server manager.
`@everyone` cannot be selected as the restricted role.

This policy governs Discord interactions. Existing private browser/download/
dashboard links remain bearer links: holders can still access their linked web
features. Do not treat this switch as Discord authentication for the web service.

## Optional event recording

Use `/eventrecord mode:enable event:<event ID or Discord event URL>` to select
a scheduled voice-channel event. Manage Server permission is required, along
with the configured Bot Wrangler role when role mode is enabled. Recording
starts when Discord reports that selected event becoming active, using its name
as the recording title. External and stage events are unsupported.

Event recording is off until an event is selected. Once started, an event-owned
recording automatically stops and saves after **60 continuous seconds without
human participants** in its voice channel. Bots do not count; a human rejoining
cancels the countdown. Leaving or switching channels both count. This does not
stop manual recordings and does not depend on Discord ending the event. Occupancy
is rechecked after gateway interruptions; unavailable channel state never triggers
a stop. Finalization follows normal Stop, including any configured sync end-cue delay.
The bot then leaves voice and the saved card explains why it stopped.

Add `stop_on_end:true` only if the event should
also stop its own recording when completed or cancelled. Manual recordings are
never adopted by an event, and a manual stop stays stopped. Use `mode:status`
to inspect rules or `mode:disable` to remove one. Rules survive restarts;
starting events while the bot is offline is not replayed on reconnect.

## Export cancellation and retry

`/export` returns a job ID. `/exportjob action:status job:<ID>` shows progress;
use `action:cancel` to stop queued or running work, or `action:retry` for a failed
or cancelled job. The signed job page provides the same controls. Retry creates
a new job and preserves original recordings. Cancellation interrupts audio
tools, transcription, ZIP creation and upload requests. Files already uploaded
to a cloud account are not removed. Shutdown interrupts active jobs and queues
them for restart; cancelled jobs stay cancelled. Optional tools have a bounded
execution timeout and run at lowered CPU priority, and each cloud request has a two-minute timeout. If storage fails while the queue is working (for example a full disk) it pauses for 30 seconds and retries instead of staying stopped. On a hosted, multi-server bot set `CLOUD_UPLOAD_GUILD_IDS` to the server IDs allowed to upload to the owner's connected cloud accounts; when empty, every server may.

Exports from every server share one queue, as Craig's cooking queue does. `EXPORT_CONCURRENCY` (default 1, up to 16) sets how many run at once; later jobs wait oldest first, including after a restart or retry, and `/export`, `/exportjob action:status` and the job page show each waiting job's position. Without the download service, `/export` waits its turn and then attaches the ZIP; Discord stops accepting edits to that reply after 15 minutes, so a long wait leaves the export on the host instead.

## Completed development handoff

See [READY-TO-TEST.md](docs/READY-TO-TEST.md) for bundled transcription, browser
cloud-account connections and refresh, AAC/M4A and Audacity import projects, the
multitrack browser editor, recurring schedules, channel rules and optional
retention. These features are implemented; account setup, host compatibility
and real Discord/Adobe/browser behavior remain to be verified. Advanced
features remain opt-in.

## In-Discord help

`/help` opens a private quick-start guide with a topic menu. Use `/help topic`
to open recording, exports, downloads/browser tools, automation, permissions,
or troubleshooting directly. Help includes command examples and shows whether
web downloads are enabled on the host. Help is available to everyone, including
members without the configured Bot Wrangler role; operational access rules remain
in effect.

`/record` requires a `channel` selection and accepts an optional `title`. You can
start it from text chat if you have permission to view/connect to that voice channel. If a start fails after this request joins voice, the bot leaves unless a recording is already active. A pre-existing auto-join connection is kept.

Slash commands register for newly added servers without a restart; a registration failure in one server does not block the others. Commands show explicitly designated user-facing validation messages. Unexpected failures keep a generic reply and are logged; error replies disable mentions.

The live recording panel uses a Discord embed with state colors, duration, speaker
track/note counts, channel, start time, packet drops, and session ID. Low-space
warnings appear in the card; Status, Add note, and Stop stay below it.

Recording cards show the server name and icon. Completed cards retain the final
duration and offer a Download button that opens a private format-selection website; cards with no captured tracks explain why downloads are unavailable.

The private recording download panel offers Audition/Audacity projects and Ogg Opus, WAV, FLAC, MP3, and AAC tracks. Project exports have a separate WAV/FLAC track choice; Audition defaults to FLAC and Audacity to WAV. `/export track_format` exposes the same project choice. Download links are signed, recording-specific, and expire after 24 hours.

For the current RackNerd host, an administrator can run `sudo bash /opt/the-witness/scripts/enable-downloads-ip.sh` once to configure HTTPS at the VPS IP, an nginx proxy to the loopback-only download service, and automatic IP certificate renewal. This setup requires idle recordings/exports and does not print the bot credentials. `DOWNLOAD_BIND_HOST` controls the listener address; the setup sets it to `127.0.0.1`.

For `thewitness.dev`, run `sudo bash /opt/the-witness/scripts/enable-downloads-domain.sh` instead of the IP setup. It issues a domain certificate, enables the private download service at `https://thewitness.dev`, and configures automatic renewal. Cloudflare must route the domain to this VPS and permit HTTP ACME validation; use Full (strict) TLS mode once the origin certificate is installed. The website root returns 404 by design; access recordings through signed Discord Download links.

WAV, FLAC, MP3 and AAC excerpts trim directly during conversion from the corrected recording, avoiding an extra intermediate Opus encode. Ogg excerpts still require an Opus encode. Lossless output preserves the decoded source quality; it cannot restore information already lost in Discord Opus audio.

Private download pages let you choose which speaker tracks appear in mixed audio. All speakers are included by default. Excluded speakers keep their separate tracks in multi-track/project downloads, and at least one speaker must remain selected.

Download pages can save a reusable intro per Discord server (WAV, FLAC, MP3, or Ogg; up to 30 MB and five minutes). Enable it per export to add a separate intro track and shift all speaker audio and notes after it. Queued exports retain the intro version selected when queued. Intro and silence-trimming options default off.

“Trim shared silent pauses” (configurable on the download page from 0.1–3600 seconds, default 30) detects shared silence in the selected speakers (100 ms windows, -50 dBFS threshold), removes the whole qualifying pause, and applies identical cuts to every exported speaker track. Activity on an excluded speaker does not prevent a cut. Notes move with the edited timeline; intro audio is added afterward and is never silence-trimmed. Original recordings are preserved.

Optional speaker normalization matches each speaker and the final mix using two-pass EBU R128 / ITU-R BS.1770 integrated loudness matching, like Audition's LUFS Match Loudness mode, with configurable target loudness (default -16 LUFS, range -70 to -5) and maximum true peak (default -1 dBTP, range -9 to 0), and a 20 dB boost cap. Gating reduces the influence of quiet pauses. Linear gain preserves dynamics when possible; FFmpeg uses dynamic normalization / peak limiting when linear gain would exceed the ceiling. Silent tracks stay unchanged and very quiet tracks can remain below target. Export manifests record measured before/after loudness and capped targets; lossy encoding may introduce small loudness or true peak deviations. Intro matching uses the selected speakers' loudness after normalization and constant gain capped by true peak. Both settings default off and original media is preserved. Rebuild the bundled audio tool with `scripts/build-portable-audio.sh` when upgrading; GitHub source deployment shares the host's existing `bin/ffmpeg` and does not replace it automatically.

When mixed audio includes an intro, speaker mixing finishes first, then the intro is added without changing the speaker mix gain. Intro matching uses the measured speaker mix level for mixed exports, so adding an intro does not reduce its volume according to participant count.

Enable “Include uncut original speaker recordings” to add full-length FLAC copies alongside processed tracks and inside ZIP downloads. These copies have no trims, normalization, edits, or intro padding; lossy source audio remains limited by its original recording quality.

## Audio/video sync with VTT Cameraman

The optional sync slate identifies offset and drift; correction is left to editing. It is disabled by default. In `/dashboard`, enable **Audio/video sync cues**, choose **Start only**, **End only**, or **Start and end**, and set the cue delays (3–60 seconds). Settings are snapshotted for the next recording. The end delay is measured **after Stop is pressed**: recording continues until the cue finishes, then finalizes. There is no prediction of an unknown recording end time. A short session stopped before its scheduled start cue cancels that cue. Errors, crashes, service shutdowns, and the 8-hour cap do not emit an end cue.

Copy the dashboard’s private **Cameraman pairing URL** into VTT Cameraman’s Sync settings (`C` in its output window, or `python -m vtt_cameraman.main --sync-settings`). Enable pairing and keep Cameraman running. The URL is signed, read-only, scoped to this server’s cue IDs/timing, and expires after one year; it does not grant recording downloads. Keep it secret. Sync settings apply to manual, scheduled, and event recordings through the same recording lifecycle.

Start OBS **before** starting Witness. OBS must capture the **Cameraman output window**, not just the original VTT/browser window, and must capture system audio if you want the Cameraman beep. Stop OBS after the end cue. Cameraman follows Witness’s start/stop cue schedule; it does not start or stop OBS. The current Cameraman window-discovery implementation requires Linux `wmctrl`; a Windows capture backend has not been implemented or tested.

Witness inserts a 300 ms, 1 kHz beep on a separate **Sync cues** track, with a matching `SYNC START/END <cue-id>` note. Cameraman flashes that ID and plays the beep. Match actual recorded cue positions in the editor; compare start and end offsets to measure drift. Cue scheduling uses clock-offset estimates from the feed, with network uncertainty reported. This is not sample-accurate synchronization across the Internet. Cameraman logs late/missed cues rather than replaying old ones.

Export `manifest.json` includes `syncCues`: shared IDs, target UTC, source recording seconds, original-audio seconds, and processed-export seconds where calculable. The recorder’s first-audio offset, excerpt boundaries, silence cuts, and intros are accounted for. Arbitrary mixer edits make a single exported cue position ambiguous, so it is `null` rather than guessed. Cameraman’s `sync-cues.jsonl` records output-frame submission time, not the encoded OBS timeline; locate the flash in the video for its actual position. Use uncut original audio for drift measurements, because processing intentionally changes timing. Transcription may see the cue track; exclude it from mixes if unwanted.

Validation: automated lifecycle, marker/export, feed authorization, tone, and client scheduling tests. A real OBS audio/video capture and long-session drift test still needs to be performed. `/help topic:Audio/video sync cues` explains the setup in Discord.

## Recording session duration

Recordings have an **8-hour DEFAULT maximum**. Manage Server admins can set
`/recordinglimit hours:12`, choosing **2, 4, 6, 8, 12, 16, or 24 hours**.
Omit `hours` to view the server setting. Invalid values are rejected; the absolute
safety ceiling is 24 hours. Changes apply to new recordings, including manual,
automatic, event, scheduled, and browser recording. Active sessions keep their
original deadline, measured from creation including silence and reconnect time.

Discord warnings at 1 hour, 30 minutes, 15 minutes, 5 minutes, and 1 minute
remaining say capture is still active and show the automatic stop time. Timers
are cancelled when stopping. At the maximum, the normal `/stop` path drains
buffered pre-deadline audio, finalizes participant tracks, saves the recording,
and leaves voice. The saved card reports the configured limit; metadata retains
`stopReason: "duration-limit"` and adds `diagnosticStopReason: "max_duration"`.
Storage errors still produce failed sessions requiring recovery. The deadline
skips delayed sync end cues and prevents capture extending past the limit.

As after `/stop`, use the completed card's Download button or `/export` to select
processing (mixdown, trims, transcription, intro) and package a ZIP through the
normal export pipeline. These are selected at export time, not automatically
run when recording stops. Start another recording to continue.

## Trim silence at the end

Enable **Trim silence at the end** on the recording download page to remove
trailing silence, including any quiet tail around the empty-channel grace period.
It is off by default and works independently of **Trim shared silent pauses**:
internal pauses stay intact unless that option is also enabled. It uses the same
selected speakers and activity threshold, keeps half a second after the last
active 100 ms window, and applies the same end cut to every processed track and
mixdown. Excluded speakers do not prevent trimming. The intro is added afterward
and uncut originals remain intact. Notes in the removed tail are omitted, and
removed sync cues have no exported position. Entirely silent recordings are left
intact by this option. A recorded audible sync end cue counts as activity if its
track is selected; exclude that track when trimming to the conversation's end.

## Operator troubleshooting logs

The VPS captures application output and errors in the persistent systemd journal. Over SSH, use `sudo journalctl -u the-witness.service -f -o short-iso` to follow diagnostics without restarting the bot. See [Operator logs](docs/TROUBLESHOOTING-LOGS.md) for incident time windows, service/revision checks, private snapshots, and GitHub deployment logs. Hosting-wide logs require operator access and are not exposed through server dashboard links.

The optional password-protected operator portal runs at `https://logs.thewitness.dev`. Its viewer is a separate read-only service on localhost port 3011, behind HTTPS. Set it up once with `sudo bash /opt/the-witness/scripts/enable-log-portal.sh`; the script prompts privately for credentials and stores a scrypt password hash in `/etc/the-witness-log-portal.env` (0600), outside Git and deployment releases. Blank credentials disable startup. It supports live refresh, time windows, text/session/job filters, and downloads of up to the latest 1,000 service records. It displays only `the-witness.service` records, escapes message text, disables caching, and redacts recognized credentials/private links. Redaction is best effort; the logs remain operator-only. See [Operator logs](docs/TROUBLESHOOTING-LOGS.md) for setup and access.
