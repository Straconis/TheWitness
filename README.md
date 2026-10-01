# The Witness

The Witness is a private multitrack Discord recording package based on Craig, intended to run on bot-hosting.net for the owner and friends.

## Goals

- Per-user multitrack Discord voice recording
- Hosted on bot-hosting.net
- All implemented features available without premium tiers
- No artificial recording-duration limits
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
an active recording and `/dashboard` opens recording/settings management.
Browser audio preserves original PCM for lossless WAV/FLAC speaker exports.
Download pages support audio previews and clipped exports. `/recover` salvages
checksummed complete audio from interrupted sessions into a new session while
keeping the original. `/delete` requires explicit confirmation and Manage Server.

Exports persist in a disk-backed queue and resume queued jobs after restart.
Optional transcription and cloud adapters require additional configuration and
live verification; see `.env.example`. Full Craig parity is still tracked in
`docs/CRAIG-PARITY.md`.

## Audition projects and readable download names

`/export` defaults to an Audition project. Choose `format:audition` explicitly to download a ZIP containing
`session.sesx` and separate, aligned 48 kHz WAV tracks. Extract the entire ZIP
into one folder, then open `session.sesx` in Audition. WAV files are the session's
linked media; keep them beside the session file. Track labels use participant
names. The session generator follows Craig's SESX structure. Local checks verify
XML, references, clip lengths and ZIP integrity; opening it in Adobe Audition
is still pending. ZIP64 packaging streams from disk for large projects.

Download names default to the recording start date/time in UTC. Use
`/downloadnames style:date` or `style:original` to save your server preference.
The dashboard exposes the same setting, and each download page has a naming
toggle. Changing names preserves private URL authorization and source files.
Clipped exports add their selected range to readable filenames. The Audition
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
automatic deletion or artificial recording-duration limit is added. Filesystem
free space does not necessarily reflect hosting-provider storage quotas.

## Compact Discord recording panel

`/record` posts one compact panel in the command's text channel, updating it
in place about every ten seconds. It shows recording duration, track/note counts,
connection or reconnect state, packet drops and low-disk-space warnings. It uses
bot message edits so updates continue beyond interaction-token expiry. Automatic
recordings try to post the panel in the voice channel's text chat. Missing send
permissions leave recording working and `/status` available.

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

Everything is off by default. Add `stop_on_end:true` only if the event should
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
execution timeout, and each cloud request has a two-minute timeout.

## Completed development handoff

See [READY-TO-TEST.md](docs/READY-TO-TEST.md) for bundled transcription, browser
cloud-account connections and refresh, AAC/M4A and Audacity import projects, the
multitrack browser editor, recurring schedules, channel rules and optional
retention. These features are implemented; account setup, host compatibility
and real Discord/Adobe/browser behavior remain to be verified. Advanced
features remain opt-in.
