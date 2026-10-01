# Before purchasing hosting

The application is compiled into JavaScript. The deployment currently targets
Node 24 on Linux x86_64. TypeScript is only a development dependency.

Run `npm test` for automated checks, then `npm run check:host` to check the
compiled app, native audio/encryption modules, and audio executables without
connecting to Discord. These checks do not require a bot token.

Next, a real Discord test can run on this Linux computer before buying hosting:
configure the bot token privately in `.env`, invite the bot to a test server with
voice and application-command permissions, start it with `npm start`, record
at least two speakers, stop, and listen to the separate and mixed exports.
Also test a disconnect/reconnect and a restart with saved recordings.
Credentials should stay outside Git and deployment archives.

The optional browser/download service needs a reachable public HTTPS origin
and an allocated HTTP port behind the host's HTTPS proxy. Check that the hosting
plan supports this before purchasing it. Browser microphone access requires
HTTPS outside localhost. The Discord-only recording bot does not need a public
web port, but browser recording, dashboard and signed download pages do.

The bundled FFmpeg and correction executables need no administrator installation.
The included native Node modules were built on this computer. Their compatibility
with the hosting image remains unverified: Node 24 alone does not guarantee the
same Linux C/C++ runtime. Run `npm run check:host` on the host; native dependencies
may require a host-compatible rebuild or installation. The payload is a local
candidate for testing, not a verified hosting deployment.

Local tests use generated audio and simulated Discord voice connections. They
cover the actual disk writer, codecs, recovery, HTTP service and WebSocket audio
transport, but cannot confirm Discord gateway behavior, real microphone capture,
host networking, or cloud-account credentials.

The testing package includes whisper.cpp and an English speech model. Optional
cloud upload supports owner browser OAuth connections and automatic refresh.
See READY-TO-TEST.md for setup and the remaining real-account checks.

Run `node scripts/test-endurance.cjs 10` after compiling for an accelerated
ten-minute, four-speaker disk recording check and decoded final excerpt.
This uses generated tone and synthetic timestamps. It is separate from
wall-clock endurance, real network conditions and live microphone testing.

Reliability checks also cover cancelling a queued reconnect during stop/shutdown,
concurrent duplicate exports, and restart with interrupted/corrupted export jobs.
Unreadable job files are preserved and skipped so one bad job does not prevent
the rest of the queue from starting.

The current build passes 65 automated checks. New coverage exercises selected
event opt-in and ownership, export cancellation and retry, tool timeouts,
cloud request bodies and safe failure messages, and transcription conversion
and temporary-file cleanup. Cloud and recognizer fixtures run locally; no real
account or speech model was used.

During live testing, also select one scheduled voice event and confirm recording
starts on activation. Confirm event auto-stop is off by default, then enable it
and test completion. Verify manual stop stays stopped and another manual
recording is not stopped by an older event ending. Cancel and retry an export
from both Discord and its signed job page.
