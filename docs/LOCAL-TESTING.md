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

Optional transcription requires whisper.cpp and a downloaded speech model.
Optional cloud upload currently uses owner-provided access tokens; OAuth login
and automatic refresh are not implemented. These integrations are experimental.
