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
The download interface and Discord export delivery are still to be implemented.
