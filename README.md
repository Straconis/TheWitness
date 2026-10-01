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

Run `npm test` to build and check the recorder. Live Discord recording, exports,
and the web interfaces have not been verified or completed yet.

See [the package comparison and implementation sequence](docs/CRAIG-PARITY.md).
Craig attribution is preserved in [licenses/Craig-ISC.txt](licenses/Craig-ISC.txt).
