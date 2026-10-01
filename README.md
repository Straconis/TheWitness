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
audio. Live Discord recording and the web interfaces remain unfinished.

See [the package comparison and implementation sequence](docs/CRAIG-PARITY.md).
Craig attribution is preserved in [licenses/Craig-ISC.txt](licenses/Craig-ISC.txt).

## Audio exports

Build the app with `npm run build`, then build Craig's timestamp correction tool
with `npm run build:cook` (requires a C compiler on Linux). Export a completed
session with `npm run export -- <session UUID> ogg`. The result is a directory
inside that session containing numbered speaker files and a manifest mapping
filenames to participants. This does not require a Discord token.

Replace `ogg` with `wav`, `flac`, or `mp3` to convert through FFmpeg. FFmpeg must
be installed on the host, placed in `bin/ffmpeg`, or configured through
`FFMPEG_PATH`. Ogg, WAV, FLAC and MP3 exports have been verified locally with
generated audio and decoding checks. Formats have no payment or tier checks.
The local FFmpeg executable is excluded from Git and must be installed on each
deployment host. On a Debian host with administrator access, install it using
`sudo apt install ffmpeg`; no executable is bundled in the release.
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
FFmpeg test binary is GPL-3.0-or-later and is not tracked in this repository.
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
Automatic voice reconnection and live Discord validation remain unfinished.
